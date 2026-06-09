/**
 * PouchDbFsBridge — bidirectional bridge between vault FS and local PouchDB.
 *
 * Platform-neutral: no Obsidian Plugin reference. Accepts a VaultWatcher port
 * (ObsidianVaultWatcher on plugin side, FsWatcher on daemon side).
 *
 * Responsible for:
 * - Vault events (change/delete) via VaultWatcher -> local PouchDB writes
 * - PouchDB change events -> vault FS writes
 * - Echo-loop suppression:
 *     Level 1: in-memory Map<docId, appliedRev> with 5s TTL
 *       Stored BEFORE vault write so the sentinel is always in memory
 *       when the FS event arrives (FSEvents latency is 50-200ms).
 *     Level 2: content equality check (text only, no read for binary)
 * - Parent directory creation before vault FS writes
 *
 * The strategy handles the actual CouchDB replication (db.sync). This bridge
 * only cares about the local PouchDB <-> vault FS boundary.
 */

import type { VaultAdapter } from "./types";
import { buildTextDoc, buildBinaryDocMeta } from "./doc-builder";
import { docIdToPath, pathToDocId, DOC_PREFIX } from "./doc-id";
import { isBinaryPath, ATTACHMENT_NAME, contentTypeForPath } from "./binary-ext";
import type PouchDB from "pouchdb-browser";
import type { VaultWatcher, FileEvent } from "./WatcherAdapter";

// Shape of a PouchDB change row from db.changes()
interface PouchChangeRow {
  id: string;
  seq: string | number;
  deleted?: boolean;
  doc?: {
    _id: string;
    _rev?: string;
    _deleted?: boolean;
    _conflicts?: string[];
    _attachments?: Record<string, unknown>;
    content?: string;
    mtime?: number;
    deleted?: boolean;
  };
}

/** TTL for the appliedRevs sentinel (ms). Clears after this delay. */
const APPLIED_REV_TTL_MS = 5000;

export class PouchDbFsBridge {
  private watcher: VaultWatcher | null = null;
  /**
   * Level 1 echo-suppression: docId -> _rev for docs the bridge just wrote to the FS.
   * Stored BEFORE vault.write() (synchronously) so the sentinel is always present
   * when the FS watcher fires (FSEvents latency 50-200ms, Node.js single-threaded).
   * TTL cleared after APPLIED_REV_TTL_MS to avoid stale suppression of genuine edits.
   */
  private appliedRevs: Map<string, string> = new Map();
  /** Handle for the PouchDB changes listener, so it can be cancelled on stop. */
  private changesHandle: { cancel(): void } | null = null;
  /**
   * When true, all vault->PouchDB event handling is suspended. Set during
   * replaceLocalFromServer (wipe + initial pull) so the bulk wipe's FS delete
   * events — and the pull's FS write events — never propagate back to PouchDB,
   * and thus never push deletions/edits upstream. "Replace from server" means the
   * server is authoritative for the whole operation.
   */
  private suppressVaultEvents = false;

  constructor(
    private readonly vault: VaultAdapter,
    private db: PouchDB,
  ) {}

  /**
   * Replace the PouchDB instance held by the bridge.
   *
   * Called by PouchDbSyncEngine.replaceLocalFromServer() after destroying the old
   * database and creating a fresh one. Re-arms the changes listener on the new db
   * if the bridge was already started (watcher present), so live change feed keeps
   * working after a local-replace.
   *
   * The vault-event watcher is NOT restarted — it routes through onVaultEvent()
   * which reads this.db fresh on every call.
   */
  setDb(db: PouchDB): void {
    this.db = db;
    // Cancel the changes listener on the destroyed db before arming a new one.
    if (this.changesHandle) {
      this.changesHandle.cancel();
      this.changesHandle = null;
    }
    // Re-arm only if bridge was started; if not started yet, startChangesListener()
    // will be called by start() later.
    if (this.watcher !== null) {
      this.startChangesListener();
    }
  }

  /**
   * Wire vault event handlers and start listening to PouchDB changes.
   * Replaces the old register(plugin) API — no Obsidian Plugin reference needed.
   */
  start(watcher: VaultWatcher): void {
    this.watcher = watcher;
    watcher.start((event: FileEvent) => this.onVaultEvent(event));
    this.startChangesListener();
  }

  /** Stop all event handlers and the PouchDB changes listener. */
  stop(): void {
    if (this.watcher) {
      this.watcher.stop();
      this.watcher = null;
    }
    if (this.changesHandle) {
      this.changesHandle.cancel();
      this.changesHandle = null;
    }
  }

  /**
   * Suspend or resume vault->PouchDB event handling. Used by
   * PouchDbSyncEngine.replaceLocalFromServer to ignore all local FS events for
   * the duration of a wipe-and-pull (server is authoritative).
   */
  setSuppressVaultEvents(suppress: boolean): void {
    this.suppressVaultEvents = suppress;
  }

  // --- Vault -> PouchDB ---

  private onVaultEvent(event: FileEvent): void {
    // Fully suspended during replaceLocalFromServer (wipe + pull): ignore all
    // local FS events so neither the bulk wipe nor the pull leaks back to PouchDB.
    if (this.suppressVaultEvents) return;
    if (event.type === "delete") {
      const docId = pathToDocId(event.path);
      // For deletes, check the sentinel too: if bridge just applied a remote
      // deletion (rare), avoid re-deleting. Sentinel uses empty string for deletes.
      if (this.appliedRevs.get(docId) === "") return;
      this.markDeletedInPouch(docId).catch(() => {/* non-critical */});
      return;
    }

    // "change" event
    const entry = this.vault.getEntryByPath(event.path);
    if (!entry || entry.kind !== "file") return;

    // Level 1 echo-suppression: compare the bridge's last-applied _rev against
    // the current doc _rev. If they match, this FS event is an echo of a remote
    // write the bridge just applied — skip it.
    const docId = pathToDocId(event.path);
    const sentinelRev = this.appliedRevs.get(docId);
    if (sentinelRev !== undefined) {
      // Sentinel present — check rev asynchronously to confirm it's an echo
      this.suppressIfEcho(docId, sentinelRev, event.path, entry).catch(() => {});
      return;
    }

    if (isBinaryPath(event.path)) {
      this.writeBinaryToPouch(entry).catch(() => {/* non-critical */});
    } else {
      this.writeTextToPouch(entry).catch(() => {/* non-critical */});
    }
  }

  /**
   * Check if a vault change event is an echo of a bridge-applied remote write.
   * Called only when appliedRevs has an entry for the docId (Level 1 sentinel).
   * If the current PouchDB _rev matches the applied rev, it's an echo — skip.
   * If _rev differs, it's a genuine concurrent edit — forward to PouchDB.
   */
  private async suppressIfEcho(
    docId: string,
    sentinelRev: string,
    path: string,
    entry: import("./types").VaultFile,
  ): Promise<void> {
    try {
      const current = await this.db.get(docId);
      if (current._rev === sentinelRev) {
        return; // Echo confirmed: this is the rev the bridge just applied
      }
      // Rev differs: genuine concurrent edit — write to PouchDB
    } catch {
      // Doc gone or DB error — treat as genuine edit
    }

    if (isBinaryPath(path)) {
      this.writeBinaryToPouch(entry).catch(() => {/* non-critical */});
    } else {
      this.writeTextToPouch(entry).catch(() => {/* non-critical */});
    }
  }

  private async writeTextToPouch(file: import("./types").VaultFile): Promise<void> {
    const content = await this.vault.readText(file);
    const docId = pathToDocId(file.path);

    // Get current _rev to avoid 409 conflicts
    let rev: string | undefined;
    try {
      const existing = await this.db.get(docId);
      rev = existing._rev;
    } catch {
      // Doc doesn't exist yet — create new
    }

    const doc = {
      ...buildTextDoc(file, content),
      ...(rev ? { _rev: rev } : {}),
    };

    await this.db.put(doc as Parameters<typeof this.db.put>[0]);
  }

  private async writeBinaryToPouch(file: import("./types").VaultFile): Promise<void> {
    const docId = pathToDocId(file.path);

    // Get current _rev to avoid 409 conflicts
    let rev: string | undefined;
    try {
      const existing = await this.db.get(docId);
      rev = existing._rev;
    } catch {
      // Doc doesn't exist yet
    }

    const meta = {
      ...buildBinaryDocMeta(file),
      ...(rev ? { _rev: rev } : {}),
    };

    const metaResult = await this.db.put(meta as Parameters<typeof this.db.put>[0]);
    const newRev = metaResult.rev;

    // Read the binary data and store as attachment.
    //
    // readBinary returns an ArrayBuffer. pouchdb-browser (plugin) tolerates a raw
    // ArrayBuffer, but pouchdb-node (daemon) routes it to crypto.Hash.update(),
    // which rejects ArrayBuffer (ERR_INVALID_ARG_TYPE) and crash-looped the daemon —
    // see BUG #79. A Uint8Array is a TypedArray that Node's crypto accepts and
    // pouchdb-browser also accepts, so normalising here keeps both adapters correct.
    const data = new Uint8Array(await this.vault.readBinary(file));
    const contentType = contentTypeForPath(file.path);
    await this.db.putAttachment(docId, ATTACHMENT_NAME, newRev, data, contentType);
  }

  private async markDeletedInPouch(docId: string): Promise<void> {
    // Tombstone the exact docId (handles single-file delete; 404 = no-op for folders).
    try {
      const existing = await this.db.get(docId);
      await this.db.put({
        ...existing,
        _deleted: true,
        deleted: true,
      } as Parameters<typeof this.db.put>[0]);
    } catch {
      // Doc doesn't exist — no-op
    }

    // Sweep all descendant file docs under this path.
    //
    // Folder-level FS events produce docId "file/MyFolder" which has no PouchDB doc
    // (only files are stored). Without this sweep the nested file docs survive and
    // are re-materialized onto disk by the live changes feed ("ghost files").
    //
    // Range: [file/<path>/, file/<path>/"\uffff"] — the trailing "/" ensures siblings
    // like "file/MyFolder.md" or "file/MyFolderOther/…" are excluded.
    // "\uffff" (U+FFFF) is the highest BMP code-point, safe as a range upper-bound sentinel.
    //
    // allDocs excludes already-deleted docs by default, so this sweep is idempotent:
    // calling it twice (e.g. if the runtime also fires per-file events) is a no-op
    // on the second pass.
    const prefix = docId + "/";
    const result = await this.db.allDocs({
      startkey: prefix,
      endkey: prefix + "\uffff",
    });
    await Promise.all(
      result.rows.map(row => this.markDeletedInPouch(row.id)),
    );
  }

  // --- PouchDB -> Vault ---

  private startChangesListener(): void {
    this.changesHandle = this.db.changes({
      since: "now",
      live: true,
      include_docs: true,
    }) as { cancel(): void };

    // The PouchDB changes handle emits 'change' events
    const changesEmitter = this.changesHandle as unknown as {
      on(event: "change", handler: (change: PouchChangeRow) => void): void;
      on(event: "error", handler: (err: unknown) => void): void;
    };

    changesEmitter.on("change", (change) => {
      this.applyRemoteChange(change).catch(() => {/* non-critical */});
    });

    changesEmitter.on("error", (_err) => {
      // Changes feed error — strategy will restart on visibility change
    });
  }

  private async applyRemoteChange(change: PouchChangeRow): Promise<void> {
    if (!change.doc) return;
    const doc = change.doc;

    // Only handle file/ docs — skip design docs, metadata docs, etc.
    if (!doc._id.startsWith(DOC_PREFIX)) return;
    const path = docIdToPath(doc._id);

    const docId = doc._id;
    let docRev = doc._rev ?? "";
    let resolvedDoc = doc;

    // Skip deleted docs — handle tombstone by deleting from vault
    if (doc._deleted || doc.deleted) {
      const entry = this.vault.getEntryByPath(path);
      if (entry && entry.kind === "file") {
        // Sentinel: empty string marks "bridge applied a delete for this docId"
        this.setAppliedRev(docId, "");
        await this.vault.deleteFile(entry);
      }
      return;
    }

    // LWW-by-mtime conflict resolution: if PouchDB reports conflicts, pick
    // the doc with the highest mtime as the winner before writing to vault.
    if (doc._conflicts && doc._conflicts.length > 0) {
      const winner = await this.resolveConflictsByMtime(doc);
      resolvedDoc = winner;
      docRev = winner._rev ?? docRev;
    }

    if (isBinaryPath(path)) {
      await this.applyRemoteBinaryChange(resolvedDoc, path, docRev);
      return;
    }

    // Text path
    const content = typeof resolvedDoc.content === "string" ? resolvedDoc.content : null;
    if (content === null) return; // Malformed doc — skip

    // Level 2 echo-suppression: content equality guard
    const existingEntry = this.vault.getEntryByPath(path);
    if (existingEntry && existingEntry.kind === "file") {
      const localContent = await this.vault.readText(existingEntry);
      if (localContent === content) return; // Idempotent write, skip
    }

    // Ensure parent directory exists
    await this.ensureParentDirectory(path);

    // Set Level 1 sentinel BEFORE vault write.
    // FSEvents fires 50-200ms after the write; Node.js single-threaded so this
    // is always in memory before the FS event handler runs.
    this.setAppliedRev(docId, docRev);

    if (existingEntry && existingEntry.kind === "file") {
      await this.vault.modifyText(existingEntry, content);
    } else {
      await this.vault.createText(path, content);
    }
  }

  /**
   * LWW (Last-Write-Wins) conflict resolution by mtime.
   *
   * When PouchDB detects conflicts, it picks a winner arbitrarily by _rev string
   * sort. This method overrides that by fetching all conflict revisions and
   * picking the one with the highest mtime field. Losing revisions are deleted
   * from PouchDB so the conflict tree stays clean.
   *
   * Called only when change.doc._conflicts is non-empty. Cost: one extra
   * db.get({open_revs:"all"}) per conflicted doc — negligible in steady state.
   */
  private async resolveConflictsByMtime(
    doc: NonNullable<PouchChangeRow["doc"]>,
  ): Promise<NonNullable<PouchChangeRow["doc"]>> {
    const allRevs = (doc._conflicts ?? []).concat(doc._rev ?? []);

    // Fetch all revisions (winner + losing conflict revs)
    let candidates: NonNullable<PouchChangeRow["doc"]>[];
    try {
      const rows = await (this.db as unknown as {
        get(id: string, opts: { open_revs: string[] }): Promise<Array<{ ok: NonNullable<PouchChangeRow["doc"]> }>>;
      }).get(doc._id, { open_revs: allRevs });
      candidates = rows.map(r => r.ok).filter(Boolean);
    } catch {
      // If we can't fetch all revs, fall back to the change-feed winner
      return doc;
    }

    if (candidates.length === 0) return doc;

    // Pick the candidate with the highest mtime; break ties by _rev lexicographic order
    const winner = candidates.reduce((best, curr) => {
      const bestMtime = typeof best.mtime === "number" ? best.mtime : -Infinity;
      const currMtime = typeof curr.mtime === "number" ? curr.mtime : -Infinity;
      if (currMtime > bestMtime) return curr;
      if (currMtime === bestMtime && (curr._rev ?? "") > (best._rev ?? "")) return curr;
      return best;
    });

    // Delete all losing revisions so PouchDB's conflict tree stays clean
    const losers = candidates.filter(c => c._rev !== winner._rev);
    await Promise.all(
      losers.map(loser =>
        this.db.put({ ...loser, _deleted: true } as Parameters<typeof this.db.put>[0]).catch(() => {
          // If delete fails (e.g., race condition), it's non-fatal — next sync will retry
        }),
      ),
    );

    return winner;
  }

  private async applyRemoteBinaryChange(
    doc: NonNullable<PouchChangeRow["doc"]>,
    path: string,
    docRev: string,
  ): Promise<void> {
    // Check if this doc has an attachment
    if (!doc._attachments || !doc._attachments[ATTACHMENT_NAME]) return;

    const existingEntry = this.vault.getEntryByPath(path);

    await this.ensureParentDirectory(path);

    // Set Level 1 sentinel BEFORE vault write (binary has no content equality check).
    this.setAppliedRev(doc._id, docRev);

    const blob = await this.db.getAttachment(doc._id, ATTACHMENT_NAME);
    const buffer = blob instanceof Blob
      ? await blob.arrayBuffer()
      : (blob as unknown as ArrayBuffer);

    if (existingEntry && existingEntry.kind === "file") {
      await this.vault.modifyBinary(existingEntry, buffer);
    } else {
      await this.vault.createBinary(path, buffer);
    }
  }

  /**
   * Record that the bridge applied _rev for docId to the vault FS.
   * The sentinel is cleared after APPLIED_REV_TTL_MS to avoid stale suppression.
   */
  private setAppliedRev(docId: string, rev: string): void {
    this.appliedRevs.set(docId, rev);
    setTimeout(() => {
      // Only clear if the rev hasn't been updated by a newer remote write
      if (this.appliedRevs.get(docId) === rev) {
        this.appliedRevs.delete(docId);
      }
    }, APPLIED_REV_TTL_MS);
  }

  private async ensureParentDirectory(filePath: string): Promise<void> {
    const lastSlash = filePath.lastIndexOf("/");
    if (lastSlash <= 0) return; // Root level, no parent needed
    const parentPath = filePath.substring(0, lastSlash);
    if (!this.vault.getEntryByPath(parentPath)) {
      await this.vault.createDirectory(parentPath);
    }
  }

  // --- Reconcile public entries (startup only, called before bridge.start) ---

  /**
   * Push a vault file to local PouchDB during startup reconciliation.
   *
   * Mirrors the change branch of onVaultEvent: reads the file from the vault
   * adapter and writes it to local PouchDB (text or binary).
   *
   * No echo sentinel needed here: this writes TO PouchDB, not FROM PouchDB.
   * The live changes feed (since:"now") is not yet armed when reconcile runs
   * (bridge.start has not been called), so there is no loop risk.
   */
  async reconcilePush(path: string): Promise<void> {
    const entry = this.vault.getEntryByPath(path);
    if (!entry || entry.kind !== "file") return;
    if (isBinaryPath(path)) {
      await this.writeBinaryToPouch(entry);
    } else {
      await this.writeTextToPouch(entry);
    }
    // Set the echo-suppression sentinel AFTER writing to PouchDB.
    //
    // Why: conflict-copy files are written to disk by runReconcileOnStartup BEFORE
    // bridge.start() arms the FS watcher. Once bridge.start() runs, macOS FSEvents
    // may deliver stale events for those pre-existing files. Without the sentinel,
    // onVaultEvent fires and calls writeTextToPouch a second time, bumping the rev.
    // Setting the sentinel here makes onVaultEvent treat the first FSEvent as an echo
    // of this push and suppress it.
    //
    // All reconcilePush callers write the file to disk before calling this method
    // (stranded-file push: file was already on disk; conflict-copy: createText first).
    // The sentinel is correct in both cases: the first watcher event after start()
    // is always an echo of content already in PouchDB.
    const docId = pathToDocId(path);
    try {
      const written = await this.db.get(docId);
      const rev = (written as { _rev?: string })._rev;
      if (rev) this.setAppliedRev(docId, rev);
    } catch {
      // Doc vanished between put and get — sentinel not critical, skip
    }
  }

  /**
   * Register an echo-suppression sentinel for a docId WITHOUT writing to PouchDB.
   *
   * Used by the conflict-copy reconcile path: the original file (e.g. "p.md") is left
   * on disk with divergent content, and its local PouchDB doc is NOT touched by reconcile.
   * However, macOS FSEvents may deliver a stale event for the original file after
   * bridge.start() arms the FS watcher. Without a sentinel, onVaultEvent would push
   * the divergent disk content into the local doc, clobbering the outage-surviving rev.
   *
   * Fix: set the sentinel to the doc's current rev in local PouchDB. When FSEvents fires,
   * suppressIfEcho fetches the doc and sees _rev === sentinelRev → echo suppressed.
   */
  reconcileSuppressEcho(docId: string, currentLocalRev: string): void {
    this.setAppliedRev(docId, currentLocalRev);
  }

  /**
   * Apply a "pull" action from startup reconciliation.
   *
   * Design decision: (b) logged near-no-op, relying on live sync to deliver.
   *
   * WHY option (b) is correct:
   *   - AC2.3c (no local doc): local PouchDB has nothing to write to disk — a write
   *     is literally impossible without first fetching the remote content.
   *   - AC2.3b (local doc present, rev differs): local PouchDB holds the OLD rev
   *     (last-synced content before the outage). Writing it to disk would put stale
   *     content there; the remote's new content arrives only after live sync runs.
   *   After bridge.start, the changes feed (since:"now") is armed. After engine.start,
   *   live db.sync pulls the remote rev into local PouchDB, which fires applyRemoteChange
   *   → disk write automatically. That path is tested in the integration tests via
   *   db._emitChange (simulating live-sync delivery) after runDaemonV2Startup returns.
   *
   * This is NOT a masking no-op: the contract is that live sync delivers the file.
   * If live sync never delivers it, that is a live-sync bug, not a reconcile bug.
   * A caller that needs proof: see the "downtime-remote-edit pull" integration test.
   */
  async reconcilePull(_docId: string, path: string): Promise<void> {
    // No-op at reconcile time — live sync (engine.start → db.sync → applyRemoteChange)
    // delivers the remote content to disk after bridge.start arms the changes feed.
    // See design decision comment above.
    console.log(`[vault-sync] reconcile: pull queued for live-sync delivery — ${path}`);
  }

  /**
   * Tombstone a local PouchDB doc during startup reconciliation.
   *
   * Reuses markDeletedInPouch directly. No echo sentinel needed: this writes
   * to PouchDB only, not to the FS. The FS file is already absent (caller
   * guarantees this via the FS-absent reconcile branch).
   */
  async reconcileTombstone(docId: string): Promise<void> {
    await this.markDeletedInPouch(docId);
  }

  /**
   * Delete all local vault files not matched by the exclude predicate.
   *
   * Called at the start of replaceLocalFromServer(), BEFORE the local PouchDB is
   * destroyed and re-pulled from the server.  Wiping first means we never need to
   * fetch the server's _all_docs to know what to keep — the fresh initial pull
   * recreates everything authoritatively.
   *
   * Safety rules:
   *   - Only touches files returned by vault.getFiles() (vault-managed files only).
   *   - Skips any path where isExcluded returns true (.obsidian/, .trash/, .git/, …).
   *   - Sets the echo-suppression sentinel to "" BEFORE vault.deleteFile() so the
   *     FS watcher does not push a phantom tombstone back into PouchDB.
   *
   * @param isExcluded  Predicate wrapping the caller's exclude-patterns list.
   */
  async wipeLocalFiles(isExcluded: (relPath: string) => boolean): Promise<void> {
    const files = this.vault.getFiles();

    // Partition into root-level files and the set of top-level directory names.
    const rootFiles: import("./types").VaultFile[] = [];
    const topDirs = new Set<string>();
    for (const f of files) {
      const slash = f.path.indexOf("/");
      if (slash === -1) rootFiles.push(f);
      else topDirs.add(f.path.slice(0, slash));
    }

    // Root files: delete individually (skip excluded).
    for (const f of rootFiles) {
      if (isExcluded(f.path)) continue;
      await this.vault.deleteFile(f);
    }

    // Top-level directories: ONE recursive delete each — dozens of calls instead of
    // thousands of per-file deletes. A directory is bulk-deleted only when neither it
    // nor anything inside it is excluded; otherwise its files are removed individually
    // so nested exclusions (e.g. "Folder/private/") are honoured.
    for (const dir of topDirs) {
      if (isExcluded(dir)) continue; // whole directory excluded
      const dirFiles = files.filter(
        (f) => f.path === dir || f.path.startsWith(dir + "/"),
      );
      const hasExcludedInside = dirFiles.some((f) => isExcluded(f.path));
      if (hasExcludedInside) {
        for (const f of dirFiles) {
          if (isExcluded(f.path)) continue;
          await this.vault.deleteFile(f);
        }
        continue;
      }
      const entry = this.vault.getEntryByPath(dir);
      if (entry && entry.kind === "folder") {
        await this.vault.deleteDirectory(entry);
      } else {
        // No folder entry (unexpected) — fall back to per-file deletion.
        for (const f of dirFiles) await this.vault.deleteFile(f);
      }
    }
  }
}
