import { TFile, TAbstractFile, Vault, normalizePath } from "obsidian";
import { CouchClient, CouchError } from "./couch-client";
import type {
  VaultSyncSettings,
  CouchDoc,
  CouchChangeRow,
  RevMap,
  SyncState,
  SyncCounts,
} from "./types";

const REVMAP_KEY = "vault-sync-revmap";
const SEQ_KEY = "vault-sync-last-seq";
const DOC_PREFIX = "file/";
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB - skip larger files for now (TODO: chunked upload)

/** Convert a vault file path to a CouchDB doc ID */
function pathToDocId(path: string): string {
  return `${DOC_PREFIX}${path}`;
}

/** Convert a CouchDB doc ID back to a vault file path */
function docIdToPath(docId: string): string {
  return docId.startsWith(DOC_PREFIX) ? docId.slice(DOC_PREFIX.length) : docId;
}

/**
 * Bidirectional sync engine between Obsidian vault and CouchDB.
 *
 * Design decisions for mobile-first:
 * - Long-poll changes feed instead of continuous replication (battery friendly)
 * - Debounced local writes to batch rapid edits
 * - Stores rev map in localStorage to survive plugin reloads without re-fetching
 * - All network calls go through CouchClient (fetch-based, no PouchDB)
 */
export class SyncEngine {
  private client: CouchClient;
  private vault: Vault;
  private revMap: RevMap = {};
  private lastSeq: string | number = 0;
  private changesPollTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingWrites: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private applyingRemote = false;
  private recentRemotePaths: Set<string> = new Set();
  private running = false;
  private pullCount = 0;

  /** Callback to update UI state */
  onStateChange: (state: SyncState) => void = () => {};
  onCountsChange: (counts: SyncCounts) => void = () => {};
  onError: (msg: string) => void = () => {};

  constructor(
    private settings: VaultSyncSettings,
    vault: Vault,
  ) {
    this.client = new CouchClient(settings);
    this.vault = vault;
    this.loadPersistedState();
  }

  updateSettings(settings: VaultSyncSettings): void {
    this.settings = settings;
    this.client.updateSettings(settings);
  }

  isRunning(): boolean {
    return this.running;
  }

  // --- Persistence (survives plugin reloads) ---

  private loadPersistedState(): void {
    try {
      const stored = localStorage.getItem(REVMAP_KEY);
      if (stored) this.revMap = JSON.parse(stored);
      const seq = localStorage.getItem(SEQ_KEY);
      if (seq) this.lastSeq = JSON.parse(seq);
    } catch {
      // Corrupted state, start fresh
      this.revMap = {};
      this.lastSeq = 0;
    }
  }

  private persistState(): void {
    try {
      localStorage.setItem(REVMAP_KEY, JSON.stringify(this.revMap));
      localStorage.setItem(SEQ_KEY, JSON.stringify(this.lastSeq));
    } catch {
      // localStorage full or unavailable, non-critical
    }
  }

  // --- Lifecycle ---

  async start(): Promise<void> {
    if (!this.client.isConfigured()) {
      console.log("[vault-sync] Not configured, skipping start");
      this.onStateChange("not-configured");
      return;
    }
    this.running = true;
    this.onStateChange("syncing");
    console.log("[vault-sync] Starting sync...");

    try {
      await this.client.ensureDb();
      console.log("[vault-sync] DB ensured, starting fullSync");
      await this.fullSync();
      console.log("[vault-sync] fullSync complete, starting polling");
      this.onStateChange("ok");
      this.startPolling();
    } catch (e) {
      this.running = false;
      this.onStateChange("error");
      console.error("[vault-sync] Start failed:", e);
      this.onError(`Sync start failed: ${(e as Error).message}`);
    }
  }

  stop(): void {
    this.running = false;
    this.client.cancelChanges();
    if (this.changesPollTimer) {
      clearTimeout(this.changesPollTimer);
      this.changesPollTimer = null;
    }
    for (const timer of this.pendingWrites.values()) {
      clearTimeout(timer);
    }
    this.pendingWrites.clear();
    this.onStateChange("idle");
  }

  // --- Full sync (initial or manual) ---

  async fullSync(): Promise<void> {
    this.onStateChange("syncing");
    try {
      // Fetch remote rev index (no content) -- lightweight, ~15K rows with just id+rev
      const remoteIndex = await this.client.allDocs({
        startkey: DOC_PREFIX,
        endkey: `${DOC_PREFIX}\uffff`,
      });
      const remoteRevs = new Map<string, string>();
      for (const row of remoteIndex.rows) {
        remoteRevs.set(row.id, row.value.rev);
      }

      await this.pushAllLocal(remoteRevs);
      await this.pullAllRemote(remoteRevs);
      this.persistState();
      this.onStateChange("ok");
    } catch (e) {
      this.onStateChange("error");
      throw e;
    }
  }

  /**
   * Push local files that are new or changed since last sync.
   * Uses rev index (no content) to determine what needs pushing.
   */
  private async pushAllLocal(remoteRevs: Map<string, string>): Promise<void> {
    const files = this.vault.getFiles().filter((f) => !this.isExcluded(f.path) && f.stat.size <= MAX_FILE_SIZE);

    const batch: CouchDoc[] = [];

    for (let fi = 0; fi < files.length; fi++) {
      const file = files[fi];
      const docId = pathToDocId(file.path);
      const remoteRev = remoteRevs.get(docId);
      const knownRev = this.revMap[docId];
      // Yield every 100 files to keep UI responsive
      if (fi % 100 === 99) await this.yield();

      if (remoteRev) {
        // Doc exists remotely
        if (!knownRev) {
          // First sync for this doc - trust remote, just record rev
          this.revMap[docId] = remoteRev;
          continue;
        }
        if (knownRev === remoteRev) continue; // Unchanged
        // Rev changed by another device - let pull handle it
        continue;
      } else {
        // New file, not on remote
        const content = await this.vault.cachedRead(file);
        batch.push({ _id: docId, content, mtime: file.stat.mtime });

        // Flush in small chunks to avoid nginx 413
        if (batch.length >= 10) {
          await this.pushBatch(batch.splice(0));
          await this.yield();
        }
      }
    }

    if (batch.length > 0) {
      await this.pushBatch(batch);
    }
  }

  private async pushBatch(batch: CouchDoc[]): Promise<void> {
    try {
      const results = await this.client.bulkDocs(batch);
      for (const result of results) {
        if (result.ok && result.rev) {
          this.revMap[result.id] = result.rev;
        } else if (result.error === "conflict") {
          const localDoc = batch.find((d) => d._id === result.id);
          if (localDoc) {
            await this.resolveConflict(result.id, localDoc.content, localDoc.mtime);
          }
        }
      }
    } catch (e) {
      // 413 or other bulk error: fall back to individual puts
      console.log(`[vault-sync] Bulk push failed (${(e as Error).message}), falling back to individual puts`);
      for (const doc of batch) {
        try {
          const result = await this.client.put(doc);
          if (result.ok && result.rev) {
            this.revMap[result.id] = result.rev;
          }
        } catch (putErr) {
          if (putErr instanceof CouchError && putErr.status === 409) {
            await this.resolveConflict(doc._id, doc.content, doc.mtime);
          } else {
            this.onError(`Push failed for ${doc._id}: ${(putErr as Error).message}`);
          }
        }
      }
    }
  }

  /** Yield to the main thread to prevent UI freeze */
  private yield(): Promise<void> {
    return new Promise((r) => setTimeout(r, 0));
  }

  /**
   * Pull remote docs that are new or changed since last sync.
   * Fetches content individually for docs whose rev differs from local revMap.
   */
  private async pullAllRemote(remoteRevs: Map<string, string>): Promise<void> {
    const toPull: string[] = [];
    for (const [docId, rev] of remoteRevs) {
      if (docId.startsWith("_design/")) continue;
      if (this.revMap[docId] === rev) continue;
      toPull.push(docId);
    }

    console.log(`[vault-sync] Pull: ${toPull.length} docs to fetch`);

    if (toPull.length > 0) {
      this.applyingRemote = true;
      this.pullCount = toPull.length;
      this.emitCounts();
      try {
        for (let i = 0; i < toPull.length; i++) {
          const docId = toPull[i];
          try {
            const doc = await this.client.get(docId);
            await this.applyRemoteDoc(doc);
            if (doc._rev) {
              this.revMap[docId] = doc._rev;
            }
          } catch {
            // Skip docs that fail to fetch
          }
          this.pullCount--;
          this.emitCounts();
          if (i % 10 === 9) await this.yield();
          // Persist every 100 docs to survive interruptions
          if (i % 100 === 99) this.persistState();
        }
      } finally {
        this.pullCount = 0;
        this.applyingRemote = false;
        this.emitCounts();
      }
    }

    // Get current sequence for changes feed
    const changes = await this.client.changes(0, { limit: 0, include_docs: false });
    this.lastSeq = changes.last_seq;
    this.persistState();
  }

  // --- Incremental sync (changes feed) ---

  private startPolling(): void {
    if (!this.running) return;
    this.pollChanges();
  }

  private async pollChanges(): Promise<void> {
    if (!this.running) return;

    try {
      const result = await this.client.changes(this.lastSeq, {
        timeout: 25000,
        include_docs: true,
      });

      if (!this.running) return;

      if (result.results.length > 0) {
        await this.applyRemoteChanges(result.results);
      }

      this.lastSeq = result.last_seq;
      this.persistState();
      this.onStateChange("ok");

      // Poll again after interval (normal feed, not longpoll)
      if (this.running) {
        const POLL_INTERVAL = 3000; // 3 seconds for near-realtime
        this.changesPollTimer = setTimeout(() => this.pollChanges(), POLL_INTERVAL);
      }
    } catch (e) {
      if (!this.running) return; // Expected abort on stop

      const msg = (e as Error).message || "";
      if (msg.includes("aborted") || msg.includes("AbortError")) return;

      this.onStateChange("offline");
      this.onError(`Changes feed error: ${msg}`);

      // Backoff retry
      if (this.running) {
        this.changesPollTimer = setTimeout(() => this.pollChanges(), 5000);
      }
    }
  }

  private async applyRemoteChanges(changes: CouchChangeRow[]): Promise<void> {
    this.applyingRemote = true;
    this.pullCount = changes.filter((c) => !c.id.startsWith("_design/")).length;
    this.emitCounts();
    try {
      for (const change of changes) {
        if (change.id.startsWith("_design/")) continue;

        if (change.deleted) {
          await this.handleRemoteDelete(change.id);
        } else if (change.doc) {
          await this.applyRemoteDoc(change.doc);
        }

        // Update rev map
        if (change.changes.length > 0) {
          this.revMap[change.id] = change.changes[0].rev;
        }
        this.pullCount--;
        this.emitCounts();
      }
    } finally {
      this.pullCount = 0;
      this.applyingRemote = false;
      this.emitCounts();
    }
  }

  private async applyRemoteDoc(doc: CouchDoc): Promise<void> {
    const path = docIdToPath(doc._id);
    if (this.isExcluded(path)) return;
    if (doc.deleted) {
      await this.handleRemoteDelete(doc._id);
      return;
    }

    const normalized = normalizePath(path);
    const existing = this.vault.getAbstractFileByPath(normalized);

    // Track path to suppress echo events from async vault notifications
    this.recentRemotePaths.add(normalized);
    setTimeout(() => this.recentRemotePaths.delete(normalized), 2000);

    if (existing instanceof TFile) {
      // Compare mtime: only overwrite if remote is newer
      if (doc.mtime > existing.stat.mtime) {
        await this.vault.modify(existing, doc.content);
      }
    } else if (!existing) {
      // New file from remote - ensure parent directories exist
      try {
        await this.ensureParentDirs(normalized);
        await this.vault.create(normalized, doc.content);
      } catch (e) {
        if ((e as Error).message?.includes("already exists")) {
          // Race condition: file appeared between check and create, use modify
          const file = this.vault.getAbstractFileByPath(normalized);
          if (file instanceof TFile) {
            await this.vault.modify(file, doc.content);
          }
        } else {
          throw e;
        }
      }
    }
  }

  private async handleRemoteDelete(docId: string): Promise<void> {
    const path = docIdToPath(docId);
    if (this.isExcluded(path)) return;
    const normalized = normalizePath(path);
    const file = this.vault.getAbstractFileByPath(normalized);
    if (file instanceof TFile) {
      await this.vault.delete(file);
    }
    delete this.revMap[docId];
  }

  private async ensureParentDirs(filePath: string): Promise<void> {
    const parts = filePath.split("/");
    if (parts.length <= 1) return;

    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current = current ? `${current}/${parts[i]}` : parts[i];
      const normalized = normalizePath(current);
      if (!this.vault.getAbstractFileByPath(normalized)) {
        await this.vault.createFolder(normalized);
      }
    }
  }

  // --- Local change handlers (called by plugin event listeners) ---

  /**
   * Called when a local file is modified/created.
   * Debounces writes to batch rapid edits (e.g., typing).
   */
  handleLocalChange(file: TAbstractFile): void {
    if (!this.running || this.applyingRemote) return;
    if (!(file instanceof TFile)) return;
    if (this.isExcluded(file.path)) return;
    if (file.stat.size > MAX_FILE_SIZE) return; // TODO: chunk large files
    if (this.recentRemotePaths.has(file.path)) return; // Suppress echo from remote apply

    // Cancel any pending debounce for this file
    const existing = this.pendingWrites.get(file.path);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      this.pendingWrites.delete(file.path);
      this.emitCounts();
      await this.pushFile(file);
    }, this.settings.syncDebounceMs);

    this.pendingWrites.set(file.path, timer);
    this.emitCounts();
  }

  /** Called when a local file is deleted */
  async handleLocalDelete(file: TAbstractFile): Promise<void> {
    if (!this.running || this.applyingRemote) return;
    if (!(file instanceof TFile)) return;
    if (this.isExcluded(file.path)) return;

    const docId = pathToDocId(file.path);
    const rev = this.revMap[docId];
    if (!rev) return; // Never synced, nothing to do

    try {
      const result = await this.client.delete(docId, rev);
      if (result.ok) {
        delete this.revMap[docId];
        this.persistState();
      }
    } catch (e) {
      this.onError(`Failed to delete remote ${file.path}: ${(e as Error).message}`);
    }
  }

  /** Called when a local file is renamed */
  async handleLocalRename(file: TAbstractFile, oldPath: string): Promise<void> {
    if (!this.running || this.applyingRemote) return;
    if (!(file instanceof TFile)) return;

    // Delete old doc
    const oldDocId = pathToDocId(oldPath);
    const oldRev = this.revMap[oldDocId];
    if (oldRev) {
      try {
        await this.client.delete(oldDocId, oldRev);
        delete this.revMap[oldDocId];
      } catch {
        // Best effort delete of old path
      }
    }

    // Push as new doc at new path
    if (!this.isExcluded(file.path)) {
      await this.pushFile(file);
    }

    this.persistState();
  }

  // --- Push single file ---

  private async pushFile(file: TFile): Promise<void> {
    try {
      const docId = pathToDocId(file.path);
      const content = await this.vault.cachedRead(file);
      const doc: CouchDoc = {
        _id: docId,
        content,
        mtime: file.stat.mtime,
      };

      // Include rev if we have one (update) or fetch it (avoid conflict)
      if (this.revMap[docId]) {
        doc._rev = this.revMap[docId];
      } else {
        try {
          const remote = await this.client.get(docId);
          if (remote._rev) doc._rev = remote._rev;
        } catch {
          // New doc, no rev needed
        }
      }

      try {
        const result = await this.client.put(doc);
        if (result.ok && result.rev) {
          this.revMap[docId] = result.rev;
          this.persistState();
        }
      } catch (e) {
        if (e instanceof CouchError && e.status === 409) {
          await this.resolveConflict(docId, content, file.stat.mtime);
        } else {
          throw e;
        }
      }
    } catch (e) {
      this.onError(`Push failed for ${file.path}: ${(e as Error).message}`);
    }
  }

  /**
   * Resolve a push conflict using last-write-wins by mtime.
   * Fetches the remote version, compares mtime, and the newest version wins.
   * No conflict files are created - resolution is fully automatic.
   */
  private async resolveConflict(
    docId: string,
    localContent: string,
    localMtime: number,
  ): Promise<void> {
    const remote = await this.client.get(docId);
    this.revMap[docId] = remote._rev!;

    if (remote.content === localContent) {
      // Same content, no real conflict - just update rev
      this.persistState();
      return;
    }

    if (localMtime >= remote.mtime) {
      // Local is newer (or equal mtime) - push local content over remote
      const doc: CouchDoc = {
        _id: docId,
        _rev: remote._rev,
        content: localContent,
        mtime: localMtime,
      };
      const result = await this.client.put(doc);
      if (result.ok && result.rev) {
        this.revMap[docId] = result.rev;
      }
    } else {
      // Remote is newer - apply remote content locally
      const normalized = normalizePath(docIdToPath(docId));
      const existing = this.vault.getAbstractFileByPath(normalized);
      if (existing instanceof TFile) {
        this.applyingRemote = true;
        try {
          await this.vault.modify(existing, remote.content);
        } finally {
          this.applyingRemote = false;
        }
      }
    }

    this.persistState();
  }

  // --- Counts ---

  private emitCounts(): void {
    this.onCountsChange({
      pendingPush: this.pendingWrites.size,
      pendingPull: this.pullCount,
    });
  }

  // --- Utilities ---

  private isExcluded(path: string): boolean {
    return this.settings.excludePatterns.some((pattern) => path.startsWith(pattern));
  }
}
