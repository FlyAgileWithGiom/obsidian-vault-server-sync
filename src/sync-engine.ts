import { TFile, TAbstractFile, Vault, normalizePath } from "obsidian";
import { CouchClient } from "./couch-client";
import type {
  VaultSyncSettings,
  CouchDoc,
  CouchChangeRow,
  RevMap,
  SyncState,
} from "./types";

const REVMAP_KEY = "vault-sync-revmap";
const SEQ_KEY = "vault-sync-last-seq";

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
  private running = false;

  /** Callback to update UI state */
  onStateChange: (state: SyncState) => void = () => {};
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
      this.onStateChange("not-configured");
      return;
    }
    this.running = true;
    this.onStateChange("syncing");

    try {
      await this.client.ensureDb();
      await this.fullSync();
      this.onStateChange("ok");
      this.startPolling();
    } catch (e) {
      this.running = false;
      this.onStateChange("error");
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
      await this.pushAllLocal();
      await this.pullAllRemote();
      this.persistState();
      this.onStateChange("ok");
    } catch (e) {
      this.onStateChange("error");
      throw e;
    }
  }

  /**
   * Push all local vault files to CouchDB.
   * Uses mtime comparison to avoid unnecessary writes.
   */
  private async pushAllLocal(): Promise<void> {
    const files = this.vault.getFiles().filter((f) => !this.isExcluded(f.path));
    const batch: CouchDoc[] = [];

    for (const file of files) {
      const docId = file.path;
      const content = await this.vault.cachedRead(file);
      const mtime = file.stat.mtime;

      // Check if remote has same or newer version
      if (this.revMap[docId]) {
        try {
          const remote = await this.client.get(docId);
          if (remote.mtime >= mtime) continue; // Remote is same or newer, skip
          batch.push({ _id: docId, _rev: remote._rev, content, mtime });
        } catch {
          // Doc doesn't exist remotely, push it
          batch.push({ _id: docId, content, mtime });
        }
      } else {
        // No known rev, try to get remote to avoid conflicts
        try {
          const remote = await this.client.get(docId);
          if (remote.mtime >= mtime) {
            this.revMap[docId] = remote._rev!;
            continue;
          }
          batch.push({ _id: docId, _rev: remote._rev, content, mtime });
        } catch {
          batch.push({ _id: docId, content, mtime });
        }
      }
    }

    if (batch.length === 0) return;

    // Bulk push in chunks to avoid oversized requests
    const CHUNK_SIZE = 50;
    for (let i = 0; i < batch.length; i += CHUNK_SIZE) {
      const chunk = batch.slice(i, i + CHUNK_SIZE);
      const results = await this.client.bulkDocs(chunk);
      for (const result of results) {
        if (result.ok && result.rev) {
          this.revMap[result.id] = result.rev;
        } else if (result.error === "conflict") {
          // Conflict: remote was updated since we checked. Pull wins.
          // Will be resolved on next pull.
        }
      }
    }
  }

  /**
   * Pull all remote docs and apply to vault.
   * Fetches full doc list and writes files that are newer remotely.
   */
  private async pullAllRemote(): Promise<void> {
    const result = await this.client.allDocs({ include_docs: true });

    this.applyingRemote = true;
    try {
      for (const row of result.rows) {
        if (!row.doc || row.id.startsWith("_design/")) continue;
        await this.applyRemoteDoc(row.doc);
        if (row.doc._rev) {
          this.revMap[row.id] = row.doc._rev;
        }
      }
    } finally {
      this.applyingRemote = false;
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

      // Immediately poll again (long-poll will block server-side)
      if (this.running) {
        this.changesPollTimer = setTimeout(() => this.pollChanges(), 100);
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
      }
    } finally {
      this.applyingRemote = false;
    }
  }

  private async applyRemoteDoc(doc: CouchDoc): Promise<void> {
    if (this.isExcluded(doc._id)) return;
    if (doc.deleted) {
      await this.handleRemoteDelete(doc._id);
      return;
    }

    const path = normalizePath(doc._id);
    const existing = this.vault.getAbstractFileByPath(path);

    if (existing instanceof TFile) {
      // Compare mtime: only overwrite if remote is newer
      if (doc.mtime > existing.stat.mtime) {
        await this.vault.modify(existing, doc.content);
      }
    } else if (!existing) {
      // New file from remote - ensure parent directories exist
      await this.ensureParentDirs(path);
      await this.vault.create(path, doc.content);
    }
  }

  private async handleRemoteDelete(docId: string): Promise<void> {
    if (this.isExcluded(docId)) return;
    const path = normalizePath(docId);
    const file = this.vault.getAbstractFileByPath(path);
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

    // Cancel any pending debounce for this file
    const existing = this.pendingWrites.get(file.path);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      this.pendingWrites.delete(file.path);
      await this.pushFile(file);
    }, this.settings.syncDebounceMs);

    this.pendingWrites.set(file.path, timer);
  }

  /** Called when a local file is deleted */
  async handleLocalDelete(file: TAbstractFile): Promise<void> {
    if (!this.running || this.applyingRemote) return;
    if (!(file instanceof TFile)) return;
    if (this.isExcluded(file.path)) return;

    const rev = this.revMap[file.path];
    if (!rev) return; // Never synced, nothing to do

    try {
      const result = await this.client.delete(file.path, rev);
      if (result.ok) {
        delete this.revMap[file.path];
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
    const oldRev = this.revMap[oldPath];
    if (oldRev) {
      try {
        await this.client.delete(oldPath, oldRev);
        delete this.revMap[oldPath];
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
      const content = await this.vault.cachedRead(file);
      const doc: CouchDoc = {
        _id: file.path,
        content,
        mtime: file.stat.mtime,
      };

      // Include rev if we have one (update) or fetch it (avoid conflict)
      if (this.revMap[file.path]) {
        doc._rev = this.revMap[file.path];
      } else {
        try {
          const remote = await this.client.get(file.path);
          if (remote._rev) doc._rev = remote._rev;
        } catch {
          // New doc, no rev needed
        }
      }

      const result = await this.client.put(doc);
      if (result.ok && result.rev) {
        this.revMap[file.path] = result.rev;
        this.persistState();
      }
    } catch (e) {
      this.onError(`Push failed for ${file.path}: ${(e as Error).message}`);
    }
  }

  // --- Utilities ---

  private isExcluded(path: string): boolean {
    return this.settings.excludePatterns.some((pattern) => path.startsWith(pattern));
  }
}
