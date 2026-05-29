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

  // --- Vault -> PouchDB ---

  private onVaultEvent(event: FileEvent): void {
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

    // Read the binary data and store as attachment
    const data = await this.vault.readBinary(file);
    const contentType = contentTypeForPath(file.path);
    await this.db.putAttachment(docId, ATTACHMENT_NAME, newRev, data, contentType);
  }

  private async markDeletedInPouch(docId: string): Promise<void> {
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
}
