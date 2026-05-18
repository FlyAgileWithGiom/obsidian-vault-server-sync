/**
 * SYNC ENGINE — Ownership rules and design contract
 * ====================================================
 *
 * This is a point-to-point sync between two endpoints:
 *   - LOCAL  : the vault filesystem (Mac via headless daemon, OR Obsidian app)
 *   - REMOTE : a CouchDB database (vault-{slug})
 *
 * There is exactly ONE sync engine instance per LOCAL endpoint. Other clients
 * (iOS plugin, agents writing directly to CouchDB via vault-server-mcp) are
 * not modeled here — they are seen as remote changes via the changes feed.
 *
 * STATE MODEL — RevMap entries are a discriminated union (see types.ts):
 *
 *   known       Doc exists on both sides, last sync agreed on rev + mtime.
 *   tombstoned  Doc was deleted (locally or remotely) and confirmed in DB.
 *               PERMANENT until forceFullSync() — no phase resurrects it.
 *   orphan      Doc exists only in DB (e.g. agent-created), never observed
 *               on FS. Never auto-pulled to FS unless forceFullSync().
 *
 * STATE TRANSITIONS:
 *   absent      → known       on first push or pull of a new file
 *   absent      → orphan      on changes-feed observation of unknown DB doc
 *   absent      → orphan      on binary metadata fetch with no attachment
 *   orphan      → known       on explicit pull (forceFullSync, or rev change)
 *   known       → tombstoned  on local delete (chokidar / reconcile)
 *   known       → tombstoned  on remote delete (changes feed _deleted)
 *   tombstoned  → tombstoned  permanent until forceFullSync clears state
 *
 * OWNERSHIP RULES per scenario:
 *
 *   File modified locally   → LOCAL is canonical, push to REMOTE
 *   File modified remotely  → REMOTE is canonical, pull to LOCAL
 *   Both modified (rev/mtime conflict) → LWW by mtime (lwwWinner function)
 *   File deleted locally    → propagate tombstone to REMOTE
 *   File deleted remotely   → delete from LOCAL (handleRemoteDelete)
 *   Doc in DB, never on FS  → orphan, do NOT pull (agent-first workflow)
 *   Doc tombstoned           → permanent, no phase resurrects it
 *
 * PHASES of fullSync (in strict order):
 *   1. reconcileLocalDeletes : known entries with no FS file → tombstoned
 *   2. pushAllLocal          : push files to DB, skip tombstoned/orphan
 *   3. pullAllRemote         : pull rev-mismatched known entries from DB
 *   4. pullBinaryDocs        : fetch binary attachments
 *   5. polling (changes feed): incremental updates after fullSync
 *
 * The architecture review (planning/sync-architecture-review-2026-05-04.md)
 * documents the rationale and the bugs that this design dissolves
 * (Trous A/B/C/D and S14/S15).
 */

import { CouchClient, CouchError } from "./couch-client";
import type {
  VaultSyncSettings,
  CouchDoc,
  CouchChangeRow,
  RevMap,
  RevMapEntry,
  SyncState,
  SyncCounts,
  SyncDiagnostics,
  FullSyncPlan,
  VaultAdapter,
  VaultFile,
  VaultEntry,
  HttpTransport,
  StateStore,
} from "./types";

const REVMAP_KEY = "vault-sync-revmap";
const SEQ_KEY = "vault-sync-last-seq";
const DOC_PREFIX = "file/";
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB - skip larger files for now (TODO: chunked upload)
const PULL_BATCH_SIZE = 20; // Smaller batches to avoid timeout on mobile with large docs
const ATTACHMENT_NAME = "data.bin";
const PARALLEL_BINARY_PULLS = 5;
const BINARY_PULL_RETRIES = 3;
const BINARY_PULL_TIMEOUT_MS = 120_000;
// Chunk size for binary metadata pre-fetch (POST _all_docs). A single POST with
// 7000+ keys timed out (30s default) on slow CouchDB connections — see GitHub #15.
const META_BATCH_SIZE = 500;
const META_TIMEOUT_MS = 60_000;

const CONTENT_TYPE_MAP: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

function contentTypeForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPE_MAP[ext] ?? "application/octet-stream";
}

/**
 * Convert a vault file path to a CouchDB doc ID.
 * Always produces NFC-normalized output so the same logical path always
 * yields the same docId regardless of the source platform's encoding
 * (macOS HFS+/APFS stores filenames in NFD, most other platforms NFC).
 * Without this, "Productivité" pushed from Mac (NFD) and "Productivité"
 * pushed from iOS (NFC) become two distinct docs.
 */
function pathToDocId(path: string): string {
  return `${DOC_PREFIX}${path.normalize("NFC")}`;
}

/**
 * Last-write-wins decision by mtime. Returns "local" or "remote" indicating
 * which side wins the conflict. Equal mtime defaults to "local" (we already
 * have it, no need to fetch). Zero mtime (unknown) is treated as the oldest
 * possible value, so a non-zero mtime on the other side wins.
 */
export function lwwWinner(localMtime: number, remoteMtime: number): "local" | "remote" {
  return localMtime >= remoteMtime ? "local" : "remote";
}

/** Convert a CouchDB doc ID back to a vault file path (NFC-normalized) */
function docIdToPath(docId: string): string {
  const raw = docId.startsWith(DOC_PREFIX) ? docId.slice(DOC_PREFIX.length) : docId;
  return raw.normalize("NFC");
}

/**
 * Returns true when a CouchDB 404 error represents a tombstone ("deleted") rather
 * than a doc that never existed ("missing"). The distinction matters for push paths:
 * a tombstone means the server intentionally removed the doc and we must not resurrect it.
 */
function isTombstone404(e: unknown): boolean {
  return e instanceof CouchError && e.status === 404 && e.message.includes('"reason":"deleted"');
}

/**
 * Recoverable error codes for file reads. These errors mean the file is
 * temporarily inaccessible (cloud-only, permission issue, transient I/O, or
 * race-deleted) and the daemon should skip the file rather than crash the sync.
 *
 * EAGAIN (-11): Dropbox/iCloud Smart Sync — file not yet downloaded to disk.
 * EACCES (-13): Permission denied.
 * EIO   (-5):   Transient disk/network I/O error.
 * ENOENT (-2):  File disappeared between scan and read (rm race).
 */
const RECOVERABLE_READ_CODES = new Set(["EAGAIN", "EACCES", "EIO", "ENOENT"]);

function isRecoverableReadError(e: unknown): { recoverable: boolean; code?: string } {
  if (e instanceof Error) {
    const err = e as NodeJS.ErrnoException;
    if (typeof err.code === "string" && RECOVERABLE_READ_CODES.has(err.code)) {
      return { recoverable: true, code: err.code };
    }
    // Match generic "Unknown system error -N" messages (node fallback for unknown errno values)
    const match = err.message?.match(/system error (-\d+)/);
    if (match) {
      const errno = match[1];
      // -11=EAGAIN, -13=EACCES, -5=EIO, -2=ENOENT
      if (errno === "-11" || errno === "-13" || errno === "-5" || errno === "-2") {
        return { recoverable: true, code: `errno${errno}` };
      }
    }
  }
  return { recoverable: false };
}

/**
 * Bidirectional sync engine between a vault and CouchDB.
 *
 * Design decisions for mobile-first:
 * - Long-poll changes feed instead of continuous replication (battery friendly)
 * - Debounced local writes to batch rapid edits
 * - Stores rev map in StateStore to survive plugin reloads without re-fetching
 * - All network calls go through CouchClient (transport-injected, no PouchDB)
 */
export class SyncEngine {
  private client: CouchClient;
  private revMap: RevMap = {};
  private lastSeq: string | number = 0;
  private changesPollTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingWrites: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private applyingRemote = false;
  private recentRemotePaths: Set<string> = new Set();
  private pushLocks: Map<string, Promise<void>> = new Map();
  private recentRemoteTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private running = false;
  private pullCount = 0;
  private pullTotal = 0;
  private pullFetched = 0;
  private pullSkipped = 0;
  private pullApplied = 0;
  private lastError: string | null = null;
  private currentState: SyncState = "idle";
  /** Files skipped due to recoverable read errors (EAGAIN, EACCES, EIO, ENOENT). Cleared on successful read. */
  private unsyncableFiles: Map<string, { reason: string; firstSeen: number; retryAfter: number }> = new Map();

  /** Callback to update UI state */
  onStateChange: (state: SyncState) => void = () => {};
  onCountsChange: (counts: SyncCounts) => void = () => {};
  onError: (msg: string) => void = () => {};
  /** Callback for diagnostics refresh (settings tab live update) */
  onDiagnosticsChange: () => void = () => {};

  constructor(
    private settings: VaultSyncSettings,
    private vault: VaultAdapter,
    private store: StateStore,
    transport: HttpTransport,
  ) {
    this.client = new CouchClient(settings, transport);
    this.loadPersistedState();
  }

  private normalizePath(path: string): string {
    return this.vault.normalizePath(path);
  }

  updateSettings(settings: VaultSyncSettings): void {
    this.settings = settings;
    this.client.updateSettings(settings);
  }

  isRunning(): boolean {
    return this.running;
  }

  getDiagnostics(): SyncDiagnostics {
    const entries = Object.values(this.revMap);
    return {
      running: this.running,
      state: this.currentState,
      revMapSize: entries.length,
      knownRevMapSize: entries.filter((e) => e.state === "known").length,
      lastSeq: this.lastSeq,
      pullProgress: this.pullTotal > 0
        ? { fetched: this.pullFetched, total: this.pullTotal }
        : null,
      pullSkipped: this.pullSkipped,
      pullApplied: this.pullApplied,
      pendingPushCount: this.pendingWrites.size,
      lastError: this.lastError,
      unsyncableCount: this.unsyncableFiles.size,
      unsyncableSample: [...this.unsyncableFiles.keys()].slice(0, 5),
    };
  }

  private setState(state: SyncState): void {
    this.currentState = state;
    this.onStateChange(state);
    this.onDiagnosticsChange();
  }

  private setError(msg: string): void {
    this.lastError = msg;
    this.onError(msg);
    this.onDiagnosticsChange();
  }

  // --- Persistence (survives plugin reloads) ---

  private loadPersistedState(): void {
    try {
      const stored = this.store.get(REVMAP_KEY);
      if (stored) {
        const raw = JSON.parse(stored) as Record<string, unknown>;
        // Migrate stored entries from any prior format:
        //   Shape A (legacy): string  "1-rev"          → { state: "known", rev, mtime: 0 }
        //   Shape B (previous): { rev, mtime, lastSeenInFs }   → { state: "known", rev, mtime }
        //   Shape C (current): { state, rev, ... }     → pass through (idempotent)
        // mtime:0 for migrated entries means "unknown, treat as changed" (Trou A).
        const migrated: RevMap = {};
        for (const [id, val] of Object.entries(raw)) {
          if (typeof val === "string") {
            // Shape A
            migrated[id] = { state: "known", rev: val, mtime: 0 };
          } else if (val !== null && typeof val === "object" && !("state" in val)) {
            // Shape B
            const b = val as { rev: string; mtime: number };
            migrated[id] = { state: "known", rev: b.rev, mtime: b.mtime ?? 0 };
          } else {
            // Shape C — already a discriminated union entry
            migrated[id] = val as RevMapEntry;
          }
        }
        this.revMap = migrated;
      }
      const seq = this.store.get(SEQ_KEY);
      if (seq) this.lastSeq = JSON.parse(seq);
    } catch {
      // Corrupted state, start fresh
      this.revMap = {};
      this.lastSeq = 0;
    }
  }

  private persistState(): void {
    try {
      this.store.set(REVMAP_KEY, JSON.stringify(this.revMap));
      this.store.set(SEQ_KEY, JSON.stringify(this.lastSeq));
    } catch {
      // Store full or unavailable, non-critical
    }
  }

  /** Transition any entry to tombstoned state. Tombstone is permanent until forceFullSync(). */
  private markTombstoned(docId: string, rev: string): void {
    this.revMap[docId] = { state: "tombstoned", rev, tombstonedAt: Date.now() };
  }

  // --- Lifecycle ---

  async start(): Promise<void> {
    if (!this.client.isConfigured()) {
      console.log("[vault-sync] Not configured, skipping start");
      this.setState("not-configured");
      return;
    }
    this.running = true;
    this.setState("syncing");
    console.log("[vault-sync] Starting sync...");

    try {
      await this.client.ensureDb();
      console.log("[vault-sync] DB ensured, starting fullSync");
      await this.fullSync();
      console.log("[vault-sync] fullSync complete, starting polling");
      this.setState("ok");
      this.startPolling();
    } catch (e) {
      this.running = false;
      this.setState("error");
      console.error("[vault-sync] Start failed:", e);
      this.setError(`Sync start failed: ${(e as Error).message}`);
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
    for (const timer of this.recentRemoteTimers.values()) {
      clearTimeout(timer);
    }
    this.recentRemoteTimers.clear();
    this.recentRemotePaths.clear();
    this.setState("idle");
  }

  // --- Full sync (initial or manual) ---

  clearState(): void {
    console.log("[vault-sync] Clearing revMap and lastSeq");
    this.revMap = {};
    this.lastSeq = 0;
    this.persistState();
  }

  async forceFullSync(): Promise<void> {
    // Owns its full lifecycle so callers can invoke this whether the engine is
    // running or stopped without losing the bypassOrphanGuard flag (a previous
    // bug had the plugin do stop+clearState+start, which silently dropped the
    // bypass and left the revMap empty on first-device onboarding).
    this.stop();
    this.clearState();
    if (!this.client.isConfigured()) {
      this.setState("not-configured");
      return;
    }
    this.running = true;
    this.setState("syncing");
    try {
      await this.client.ensureDb();
      // bypassOrphanGuard: true — empty revMap after clearState() must not skip all pulls.
      // Bypass is for seed/restore; in normal operation the guard remains active.
      await this.fullSync({ bypassOrphanGuard: true });
      this.setState("ok");
      this.startPolling();
    } catch (e) {
      this.running = false;
      this.setState("error");
      this.setError(`Force full sync failed: ${(e as Error).message}`);
    }
  }

  /**
   * Dry-run version of forceFullSync: produces a FullSyncPlan describing exactly
   * what would happen without executing any writes.
   *
   * Mirrors the comparison/filtering logic of reconcileLocalDeletes, pushAllLocal,
   * and pullAllRemote step-by-step.  One network call is unavoidable: fetching the
   * remote rev index (allDocs) and the tombstone check (allDocsByKeys on unknownFiles)
   * to accurately categorise wouldDeleteLocalTombstoned.  No writes are performed.
   *
   * Default bypassOrphanGuard=true matches what forceFullSync does after clearState().
   * Pass false to see how the normal incremental path would behave.
   */
  async planFullSync(opts: { bypassOrphanGuard?: boolean } = {}): Promise<FullSyncPlan> {
    const bypass = opts.bypassOrphanGuard !== false; // default true

    // Counters and samples (5 paths each)
    const plan: FullSyncPlan = {
      wouldPushNew: { count: 0, sample: [] },
      wouldPushChanged: { count: 0, sample: [] },
      wouldPullRevMismatch: { count: 0, sample: [] },
      wouldSkipOrphanGuard: { count: 0, sample: [] },
      wouldTombstoneLocal: { count: 0, sample: [] },
      wouldPullDelete: { count: 0, sample: [] },
      wouldDeleteLocalTombstoned: { count: 0, sample: [] },
      alreadyTombstoned: 0,
      alreadyOrphan: 0,
      oversizeSkipped: 0,
      excludedCount: 0,
    };

    function addSample(bucket: { count: number; sample: string[] }, path: string): void {
      bucket.count++;
      if (bucket.sample.length < 5) bucket.sample.push(path);
    }

    // --- Fetch remote rev index (read-only) ---
    const remoteIndex = await this.client.allDocs({
      startkey: DOC_PREFIX,
      endkey: `${DOC_PREFIX}￿`,
    });
    const remoteRevs = new Map<string, string>();
    for (const row of remoteIndex.rows) {
      remoteRevs.set(row.id, row.value.rev);
    }

    // --- Phase 1: mirror reconcileLocalDeletes ---
    // Counts revMap entries that would be tombstoned (no FS file, not excluded)
    for (const [docId, entry] of Object.entries(this.revMap)) {
      if (entry.state === "tombstoned") {
        plan.alreadyTombstoned++;
        continue;
      }
      if (entry.state === "orphan") {
        // Orphans are counted in Phase 2; skip here to avoid double-counting
        continue;
      }
      const path = docIdToPath(docId);
      const normalizedPath = this.normalizePath(path);
      if (this.isExcluded(normalizedPath)) continue;
      const fsEntry = this.vault.getEntryByPath(normalizedPath);
      if (fsEntry === null) {
        addSample(plan.wouldTombstoneLocal, path);
      }
    }

    // Count alreadyOrphan separately (not in reconcileLocalDeletes loop above)
    for (const entry of Object.values(this.revMap)) {
      if (entry.state === "orphan") plan.alreadyOrphan++;
    }

    // --- Phase 2: mirror pushAllLocal ---
    // Full vault file list (all files, even large/excluded) for counting purposes
    const allVaultFiles = this.vault.getFiles();
    for (const file of allVaultFiles) {
      if (this.isExcluded(file.path)) {
        plan.excludedCount++;
        continue;
      }
      if (file.size > MAX_FILE_SIZE) {
        plan.oversizeSkipped++;
        continue;
      }
      const docId = pathToDocId(file.path);
      if (remoteRevs.has(docId)) {
        const entry = this.revMap[docId];
        if (entry?.state === "tombstoned") {
          // Would call handleRemoteDelete (delete local); tracked in wouldDeleteLocalTombstoned
          addSample(plan.wouldDeleteLocalTombstoned, file.path);
          continue;
        }
        if (entry?.state === "orphan") {
          // Already counted in alreadyOrphan, no push
          continue;
        }
        if (entry?.state === "known" && entry.mtime > 0 && file.mtime <= entry.mtime) {
          continue; // Unchanged since last sync
        }
        // Modified or mtime unknown — would push (changed)
        addSample(plan.wouldPushChanged, file.path);
      } else {
        // Not in remoteRevs — potential push-new, but first check for server tombstones.
        // We defer the allDocsByKeys call to a batch below; for now collect candidates.
        // (actual categorisation happens after the batch)
        addSample(plan.wouldPushNew, file.path);
      }
    }

    // Tombstone batch check: same allDocsByKeys call as pushAllLocal Phase 2.
    // For each local file that looks like wouldPushNew, verify the server has no tombstone.
    // Files with a tombstone shift from wouldPushNew to wouldDeleteLocalTombstoned.
    if (plan.wouldPushNew.count > 0) {
      // Reconstruct the unknownFiles list (files not in remoteRevs, non-excluded, non-oversize)
      const unknownFiles = allVaultFiles.filter(
        (f) => !this.isExcluded(f.path) && f.size <= MAX_FILE_SIZE && !remoteRevs.has(pathToDocId(f.path))
      );
      const unknownDocIds = unknownFiles.map((f) => pathToDocId(f.path));
      let tombstoneIds: Set<string> = new Set();
      try {
        const batchResult = await this.client.allDocsByKeys(unknownDocIds);
        for (const row of batchResult.rows) {
          if (row.doc?.deleted) tombstoneIds.add(row.id);
        }
      } catch {
        // Network failure: leave tombstoneIds empty; wouldPushNew counts remain as-is.
        // The dry-run is best-effort — a failed batch means we can't distinguish
        // tombstoned files from genuinely new ones for that batch.
      }

      if (tombstoneIds.size > 0) {
        // Rebuild wouldPushNew excluding tombstoned files; add them to wouldDeleteLocalTombstoned
        const newPushNew: { count: number; sample: string[] } = { count: 0, sample: [] };
        for (const file of unknownFiles) {
          const docId = pathToDocId(file.path);
          if (tombstoneIds.has(docId)) {
            addSample(plan.wouldDeleteLocalTombstoned, file.path);
          } else {
            addSample(newPushNew, file.path);
          }
        }
        plan.wouldPushNew = newPushNew;
      }
    }

    // --- Phase 3: mirror pullAllRemote ---
    for (const [docId, rev] of remoteRevs) {
      if (docId.startsWith("_design/")) continue;
      if (this.revMap[docId]?.rev === rev) continue;
      const entry = this.revMap[docId];
      if (!entry && !bypass) {
        addSample(plan.wouldSkipOrphanGuard, docIdToPath(docId));
        continue;
      }
      if (entry?.state === "tombstoned" || entry?.state === "orphan") continue;
      addSample(plan.wouldPullRevMismatch, docIdToPath(docId));
    }

    // Remote deletions: known entries absent from remoteRevs → would delete local
    for (const [docId, entry] of Object.entries(this.revMap)) {
      if (entry.state !== "known") continue;
      if (!remoteRevs.has(docId)) {
        const path = docIdToPath(docId);
        addSample(plan.wouldPullDelete, path);
      }
    }

    return plan;
  }

  async fullSync(opts: { bypassOrphanGuard?: boolean } = {}): Promise<void> {
    this.setState("syncing");
    try {
      // Fetch remote rev index (no content) -- lightweight, ~15K rows with just id+rev
      const remoteIndex = await this.client.allDocs({
        startkey: DOC_PREFIX,
        endkey: `${DOC_PREFIX}￿`,
      });
      const remoteRevs = new Map<string, string>();
      for (const row of remoteIndex.rows) {
        remoteRevs.set(row.id, row.value.rev);
      }

      await this.reconcileLocalDeletes(remoteRevs);
      await this.pushAllLocal(remoteRevs);
      await this.pullAllRemote(remoteRevs, opts);
      this.persistState();

      // Surface unsyncable files once per fullSync (not per file) to avoid error noise.
      // Files remain in the map for the next cycle — Dropbox/iCloud may have downloaded by then.
      if (this.unsyncableFiles.size > 0) {
        this.setError(`${this.unsyncableFiles.size} unsyncable files (e.g. cloud-only): see diagnostics`);
        console.warn("[vault-sync] Unsyncable files (top 5):");
        for (const [path, info] of [...this.unsyncableFiles].slice(0, 5)) {
          console.warn(`  ${path} → ${info.reason} (since ${new Date(info.firstSeen).toISOString()})`);
        }
      }

      this.setState("ok");
    } catch (e) {
      this.setState("error");
      throw e;
    }
  }

  /**
   * Reconcile locally-deleted files that were missed while the daemon was down.
   *
   * The daemon propagates local deletes to CouchDB via chokidar `unlink` events.
   * When the daemon is offline during a local delete, that event is lost and the
   * remote doc becomes a ghost. This method detects those ghosts on every fullSync
   * by comparing the persisted revMap (files the daemon last knew about) against
   * the actual vault state. Anything in revMap that no longer exists locally (and
   * is not excluded) gets tombstoned in bulk.
   */
  private async reconcileLocalDeletes(remoteRevs: Map<string, string>): Promise<void> {
    const toDelete: { docId: string; rev: string }[] = [];

    for (const [docId, entry] of Object.entries(this.revMap)) {
      // Skip already-tombstoned entries — they are permanently removed from FS
      if (entry.state === "tombstoned") continue;
      const path = docIdToPath(docId);
      const normalizedPath = this.normalizePath(path);
      if (this.isExcluded(normalizedPath)) continue;
      const fsEntry = this.vault.getEntryByPath(normalizedPath);
      if (fsEntry !== null) continue; // File still present — nothing to do
      toDelete.push({ docId, rev: entry.rev });
    }

    if (toDelete.length === 0) return;

    console.log(`[vault-sync] reconcileLocalDeletes: tombstoning ${toDelete.length} locally-deleted docs`);

    this.applyingRemote = true;
    try {
      const BATCH_SIZE = 50;
      for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
        const chunk = toDelete.slice(i, i + BATCH_SIZE);
        const batch: CouchDoc[] = chunk.map(({ docId, rev }) => ({
          _id: docId,
          _rev: rev,
          _deleted: true,
          content: null,
          mtime: 0,
        }));

        try {
          const results = await this.client.bulkDocs(batch);
          for (const result of results) {
            if (result.ok && result.rev) {
              this.markTombstoned(result.id, result.rev);
              remoteRevs.delete(result.id);
            } else if (result.error) {
              // Row-level error — skip silently, will retry next sync
            }
          }
        } catch {
          // Bulk threw — fall back to per-doc deletes (mirrors pushBatch lines 354-370)
          for (const { docId, rev } of chunk) {
            try {
              const result = await this.client.delete(docId, rev);
              if (result.ok && result.rev) {
                this.markTombstoned(docId, result.rev);
                remoteRevs.delete(docId);
              }
            } catch (e) {
              if (e instanceof CouchError && e.status === 404) {
                // Already gone — tombstone with prior rev (best available)
                this.markTombstoned(docId, rev);
                remoteRevs.delete(docId);
              } else {
                this.setError(`reconcileLocalDeletes: failed to delete ${docId}: ${(e as Error).message}`);
              }
            }
          }
        }

        // Yield and persist state every batch (mirrors pullTextDocs lines 496-498)
        await this.yield();
        this.persistState();
      }
    } finally {
      this.applyingRemote = false;
    }
  }

  /**
   * Push local files that are new or changed since last sync.
   * Uses rev index (no content) to determine what needs pushing.
   *
   * Tombstone detection uses a single batch allDocsByKeys call instead of
   * per-file GETs (avoids N+1 latency on fresh install with many files).
   */
  private async pushAllLocal(remoteRevs: Map<string, string>): Promise<void> {
    const files = this.vault.getFiles().filter((f) => !this.isExcluded(f.path) && f.size <= MAX_FILE_SIZE);

    // Phase 1: collect files not present in the remote allDocs index
    const unknownFiles = files.filter((f) => !remoteRevs.has(pathToDocId(f.path)));

    // Phase 2: batch-check tombstones for all unknown files in a single request.
    // This is bounded by local file count (not remote); if local file count grows
    // very large, consider applying the same META_BATCH_SIZE chunking here too.
    const tombstoneIds = new Set<string>();
    const existingIds = new Set<string>();
    if (unknownFiles.length > 0) {
      const unknownDocIds = unknownFiles.map((f) => pathToDocId(f.path));
      const batchResult = await this.client.allDocsByKeys(unknownDocIds);
      for (const row of batchResult.rows) {
        if (row.doc?.deleted) {
          // Server has a tombstone — must not resurrect this file
          tombstoneIds.add(row.id);
        } else if (!row.error && row.doc) {
          // Doc exists with content but wasn't in allDocs index (edge case); let pull handle it
          existingIds.add(row.id);
        }
      }
    }

    // Phase 3: push genuinely new files, delete locally any tombstoned ones
    const batch: CouchDoc[] = [];

    for (let fi = 0; fi < files.length; fi++) {
      const file = files[fi];
      const docId = pathToDocId(file.path);
      // Yield every 100 files to keep UI responsive
      if (fi % 100 === 99) await this.yield();

      if (remoteRevs.has(docId)) {
        // Trou A fix: skip push only when file has not changed since last sync.
        // mtime:0 means migration default (unknown mtime) — treat as changed → push.
        const entry = this.revMap[docId];
        // Tombstoned entries: the file was deleted locally; delete remotely instead of pushing
        if (entry?.state === "tombstoned") {
          await this.handleRemoteDelete(docId);
          continue;
        }
        // Orphan entries: skip push (no FS file to push from)
        if (entry?.state === "orphan") {
          continue;
        }
        if (entry?.state === "known" && entry.mtime > 0 && file.mtime <= entry.mtime) {
          continue; // Not changed since last sync
        }
        // Fall through: file modified (or mtime unknown after migration) → push it.
        // For changed files, delegate to pushTextFile/pushBinaryFile which handle rev correctly.
        if (this.isBinaryDoc(docId)) {
          if (this.settings.disableBinaryPush) { await this.yield(); continue; }
          await this.pushBinaryFile(file);
          await this.yield();
        } else {
          await this.pushTextFile(file);
          await this.yield();
        }
        continue;
      }

      if (tombstoneIds.has(docId)) {
        // Server has a tombstone — do not resurrect; delete locally
        await this.handleRemoteDelete(docId);
        continue;
      }

      if (existingIds.has(docId)) {
        // Doc exists with content but wasn't in allDocs index (edge case); let pull handle it
        continue;
      }

      // Genuinely new file, not on remote
      if (this.isBinaryDoc(docId)) {
        if (this.settings.disableBinaryPush) { await this.yield(); continue; }
        // Binary files need attachment PUT, not bulk_docs
        await this.pushBinaryFile(file);
        await this.yield();
      } else {
        let content: string;
        try {
          content = await this.vault.readText(file);
          // Successful read: remove from unsyncable set (file is accessible again)
          this.unsyncableFiles.delete(file.path);
        } catch (e) {
          const check = isRecoverableReadError(e);
          if (check.recoverable) {
            this.unsyncableFiles.set(file.path, {
              reason: check.code ?? "unknown",
              firstSeen: this.unsyncableFiles.get(file.path)?.firstSeen ?? Date.now(),
              retryAfter: Date.now() + 60_000,
            });
            await this.yield();
            continue; // Skip this file, continue rest of sync
          }
          throw e; // Non-recoverable: propagate
        }

        batch.push({ _id: docId, content, mtime: file.mtime });

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
          const localDoc = batch.find((d) => d._id === result.id);
          this.revMap[result.id] = { state: "known", rev: result.rev, mtime: localDoc?.mtime ?? 0 };
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
            this.revMap[result.id] = { state: "known", rev: result.rev, mtime: doc.mtime ?? 0 };
          }
        } catch (putErr) {
          if (putErr instanceof CouchError && putErr.status === 409) {
            await this.resolveConflict(doc._id, doc.content, doc.mtime);
          } else {
            this.setError(`Push failed for ${doc._id}: ${(putErr as Error).message}`);
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
   * Uses batched _all_docs with include_docs to avoid N+1 individual GETs.
   * This is critical for mobile where 14K individual requests would fail silently.
   */
  /** Skip binary extensions that have no text content in CouchDB */
  private static readonly BINARY_EXTENSIONS = new Set([
    "png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "svgz", "ico",
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
    "mp3", "m4a", "wav", "ogg", "flac",
    "mp4", "mov", "avi", "mkv", "webm",
    "zip", "tar", "gz", "rar", "7z",
    "bin", "heic", "drawing", "writing",
  ]);

  private isBinaryDoc(docId: string): boolean {
    const ext = docId.split(".").pop()?.toLowerCase() ?? "";
    return SyncEngine.BINARY_EXTENSIONS.has(ext);
  }

  private async pullAllRemote(remoteRevs: Map<string, string>, opts: { bypassOrphanGuard?: boolean } = {}): Promise<void> {
    const textToPull: string[] = [];
    const binaryToPull: string[] = [];

    for (const [docId, rev] of remoteRevs) {
      if (docId.startsWith("_design/")) continue;
      if (this.revMap[docId]?.rev === rev) continue;
      const entry = this.revMap[docId];
      // Trou B: doc exists in DB but has no revMap entry → agent-created doc, skip pull.
      // Without a revMap entry we have no evidence this device ever synced this doc to FS.
      // First-device onboarding (empty state): seed via rsync or forceFullSync({ bypassOrphanGuard: true }).
      if (!entry && !opts.bypassOrphanGuard) continue;
      // Skip tombstoned and orphan entries — they have no FS representation to pull to.
      if (entry?.state === "tombstoned" || entry?.state === "orphan") continue;
      if (this.isBinaryDoc(docId)) {
        binaryToPull.push(docId);
      } else {
        textToPull.push(docId);
      }
    }

    console.log(`[vault-sync] Pull: ${textToPull.length} text docs, ${binaryToPull.length} binary docs to fetch`);

    const totalToPull = textToPull.length + binaryToPull.length;
    if (totalToPull > 0) {
      this.applyingRemote = true;
      this.pullCount = totalToPull;
      this.pullTotal = totalToPull;
      this.pullFetched = 0;
      this.pullSkipped = 0;
      this.pullApplied = 0;
      this.emitCounts();
      try {
        await this.pullTextDocs(textToPull);
        await this.pullBinaryDocs(binaryToPull, remoteRevs);
      } finally {
        this.pullCount = 0;
        this.pullTotal = 0;
        this.pullFetched = 0;
        this.applyingRemote = false;
        this.emitCounts();
      }
    }

    // Detect remote deletions: only known entries not present in remote index trigger handleRemoteDelete.
    // Tombstoned entries are already removed from remote; orphans have no FS file to delete.
    this.applyingRemote = true;
    try {
      for (const [docId, entry] of Object.entries(this.revMap)) {
        if (entry.state !== "known") continue;
        if (!remoteRevs.has(docId)) {
          await this.handleRemoteDelete(docId);
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

  private async pullTextDocs(keys: string[]): Promise<void> {
    let failCount = 0;
    for (let offset = 0; offset < keys.length; offset += PULL_BATCH_SIZE) {
      const batchKeys = keys.slice(offset, offset + PULL_BATCH_SIZE);
      let docs: (CouchDoc | null)[];

      try {
        const result = await this.client.allDocsByKeys(batchKeys);
        docs = result.rows.map((row) => (row.error || !row.doc) ? null : row.doc);
      } catch {
        // Batch failed -- fall back to individual GETs
        docs = [];
        for (const docId of batchKeys) {
          try {
            docs.push(await this.client.get(docId));
          } catch {
            docs.push(null);
          }
        }
      }

      for (const doc of docs) {
        if (doc) {
          try {
            await this.applyRemoteDoc(doc);
            if (doc._rev) {
              this.revMap[doc._id] = { state: "known", rev: doc._rev, mtime: doc.mtime ?? 0 };
              this.pullApplied++;
            }
          } catch (e) {
            failCount++;
            this.pullSkipped++;
            if (failCount <= 3) {
              this.setError(`Pull ${doc._id.slice(0, 40)}: ${(e as Error).message?.slice(0, 80)}`);
            }
          }
        } else {
          this.pullSkipped++;
        }
        this.pullFetched++;
        this.pullCount--;
        this.emitCounts();
      }
      await this.yield();
      this.persistState();
    }
    if (failCount > 0) {
      console.warn(`[vault-sync] Text pull complete with ${failCount} failures out of ${keys.length}`);
    }
  }

  private async pullBinaryDocs(docIds: string[], remoteRevs: Map<string, string>): Promise<void> {
    // Batch-fetch doc metadata in chunks to avoid a single huge POST that times out
    // on slow CouchDB connections with 7000+ keys (GitHub #15).
    const hasAttachment = new Set<string>();
    const metaFailedDocIds = new Set<string>();
    for (let offset = 0; offset < docIds.length; offset += META_BATCH_SIZE) {
      const chunk = docIds.slice(offset, offset + META_BATCH_SIZE);
      try {
        const metaResult = await this.client.allDocsByKeys(chunk, META_TIMEOUT_MS);
        for (const row of metaResult.rows) {
          if (!row.error && row.doc?._attachments?.[ATTACHMENT_NAME]) {
            hasAttachment.add(row.id);
          }
        }
      } catch (e) {
        // Metadata chunk failed (e.g. timeout) — track affected docs, don't abort full pull.
        console.warn(`[vault-sync] Binary metadata chunk [${offset}..${offset + chunk.length - 1}] failed: ${(e as Error).message}`);
        for (const id of chunk) metaFailedDocIds.add(id);
      }
    }

    // Classify docs: meta-fetch-failed (transient skip), real orphans (no attachment), or download
    const toDownload: string[] = [];
    for (const docId of docIds) {
      if (metaFailedDocIds.has(docId)) {
        // Metadata fetch failed transiently — do NOT write to revMap so the next sync retries.
        this.pullSkipped++;
        this.pullFetched++;
        this.pullCount--;
        this.emitCounts();
      } else if (!hasAttachment.has(docId)) {
        // Binary orphan: doc exists in DB but has no attachment data.
        // Record as orphan state — no mtime field because no FS file was written.
        const rev = remoteRevs.get(docId);
        if (rev) this.revMap[docId] = { state: "orphan", rev };
        this.pullSkipped++;
        this.pullFetched++;
        this.pullCount--;
        this.emitCounts();
      } else {
        toDownload.push(docId);
      }
    }

    // Download attachments in parallel batches of PARALLEL_BINARY_PULLS
    let failCount = 0;
    for (let batchStart = 0; batchStart < toDownload.length; batchStart += PARALLEL_BINARY_PULLS) {
      const batch = toDownload.slice(batchStart, batchStart + PARALLEL_BINARY_PULLS);
      const results = await Promise.allSettled(
        batch.map(async (docId) => {
          let lastErr: Error | undefined;
          for (let attempt = 0; attempt < BINARY_PULL_RETRIES; attempt++) {
            try {
              const data = await this.client.getAttachment(docId, ATTACHMENT_NAME, BINARY_PULL_TIMEOUT_MS);
              return { docId, data };
            } catch (e) {
              lastErr = e as Error;
              // Only retry on timeout/network errors, not on 4xx
              const isRetryable = !(e instanceof CouchError) || e.status >= 500;
              if (!isRetryable || attempt === BINARY_PULL_RETRIES - 1) break;
              await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
            }
          }
          throw lastErr;
        })
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status === "fulfilled") {
          const { docId, data } = result.value;
          await this.applyRemoteBinary(docId, data);
          const rev = remoteRevs.get(docId);
          // mtime not easily available here (binary doc metadata not fetched with content); use 0.
          if (rev) this.revMap[docId] = { state: "known", rev, mtime: 0 };
          this.pullApplied++;
        } else {
          const docId = batch[j];
          failCount++;
          this.pullSkipped++;
          // Rate-limit error reporting to avoid flooding the UI with 7000+ error events
          if (failCount <= 3) {
            this.setError(`Binary pull ${docId.slice(0, 40)}: ${(result.reason as Error).message?.slice(0, 80)}`);
          }
        }
        this.pullFetched++;
        this.pullCount--;
        this.emitCounts();
      }

      await this.yield();
      if (batchStart % 50 === 0 && batchStart > 0) this.persistState();
    }
    if (failCount > 0) {
      console.warn(`[vault-sync] Binary pull complete with ${failCount} failures out of ${toDownload.length}`);
    }
  }

  private async applyRemoteBinary(docId: string, data: ArrayBuffer): Promise<void> {
    const path = docIdToPath(docId);
    if (this.isExcluded(path)) return;

    const normalized = this.normalizePath(path);

    this.trackRecentRemotePath(normalized);

    const existing = this.vault.getEntryByPath(normalized);
    if (existing && existing.kind === "file") {
      await this.vault.modifyBinary(existing, data);
    } else if (!existing) {
      try {
        await this.ensureParentDirs(normalized);
        await this.vault.createBinary(normalized, data);
      } catch (e) {
        if ((e as Error).message?.includes("already exists")) {
          const file = this.vault.getEntryByPath(normalized);
          if (file && file.kind === "file") {
            await this.vault.modifyBinary(file, data);
          }
        } else {
          throw e;
        }
      }
    }
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
      this.setState("ok");

      // Poll again after interval (normal feed, not longpoll)
      if (this.running) {
        const POLL_INTERVAL = 3000; // 3 seconds for near-realtime
        this.changesPollTimer = setTimeout(() => this.pollChanges(), POLL_INTERVAL);
      }
    } catch (e) {
      if (!this.running) return; // Expected abort on stop

      const msg = (e as Error).message || "";
      if (msg.includes("aborted") || msg.includes("AbortError")) return;

      this.setState("offline");
      this.setError(`Changes feed error: ${msg}`);

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

        const newRev = change.changes[0]?.rev ?? "";
        const existing = this.revMap[change.id];

        if (change.deleted) {
          // Skip tombstoned entries — already recorded as deleted
          if (existing?.state !== "tombstoned") {
            await this.handleRemoteDelete(change.id);
          }
        } else {
          const entryState = existing?.state;

          if (entryState === "tombstoned") {
            // Tombstoned path: do not apply content. Just update the stored rev.
            if (newRev) this.revMap[change.id] = { state: "tombstoned", rev: newRev, tombstonedAt: (existing as { tombstonedAt: number }).tombstonedAt };
            this.pullCount--;
            this.emitCounts();
            continue;
          }

          if (!existing) {
            // First observation via changes feed — record as orphan (Trou B guard: no FS write).
            if (newRev) this.revMap[change.id] = { state: "orphan", rev: newRev };
            this.pullCount--;
            this.emitCounts();
            continue;
          }

          // Known or orphan entry: apply content and transition to known
          if (change.doc) {
            if (this.isBinaryDoc(change.id)) {
              const data = await this.client.getAttachment(change.id, ATTACHMENT_NAME, BINARY_PULL_TIMEOUT_MS);
              await this.applyRemoteBinary(change.id, data);
            } else {
              await this.applyRemoteDoc(change.doc);
            }
          }

          // Transition to known after successful apply
          if (newRev) {
            this.revMap[change.id] = {
              state: "known",
              rev: newRev,
              mtime: change.doc?.mtime ?? (existing.state === "known" ? existing.mtime : 0),
            };
          }
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
    // Skip docs with null/undefined content (corrupted or binary)
    if (typeof doc.content !== "string") return;

    const normalized = this.normalizePath(path);
    const existing = this.vault.getEntryByPath(normalized);

    // Track path to suppress echo events from async vault notifications
    this.trackRecentRemotePath(normalized);

    if (existing && existing.kind === "file") {
      // Compare mtime: overwrite if remote is newer.
      // When mtime is missing/0 (external tool update), fall back to content comparison.
      const remoteMtime = doc.mtime || 0;
      const localMtime = existing.mtime || 0;
      if (lwwWinner(localMtime, remoteMtime) === "remote") {
        await this.vault.modifyText(existing, doc.content);
      } else if (!remoteMtime || remoteMtime === localMtime) {
        // No mtime or same mtime: apply if content actually differs
        const localContent = await this.vault.readText(existing);
        if (localContent !== doc.content) {
          await this.vault.modifyText(existing, doc.content);
        }
      }
    } else if (!existing) {
      // New file from remote - ensure parent directories exist
      try {
        await this.ensureParentDirs(normalized);
        await this.vault.createText(normalized, doc.content);
      } catch (e) {
        if ((e as Error).message?.includes("already exists")) {
          // Race condition: file appeared between check and create, use modify
          const file = this.vault.getEntryByPath(normalized);
          if (file && file.kind === "file") {
            await this.vault.modifyText(file, doc.content);
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
    const normalized = this.normalizePath(path);
    const file = this.vault.getEntryByPath(normalized);
    if (file && file.kind === "file") {
      await this.vault.deleteFile(file);
      await this.cleanupEmptyParents(normalized);
    }
    const existing = this.revMap[docId];
    this.markTombstoned(docId, existing?.rev ?? "");
  }

  private async cleanupEmptyParents(filePath: string): Promise<void> {
    // Best-effort: never let cleanup errors propagate to the caller or fail the sync.
    try {
      const parts = filePath.split("/");
      for (let i = parts.length - 2; i >= 0; i--) {
        const dirPath = this.normalizePath(parts.slice(0, i + 1).join("/"));
        // Skip directories that match an exclude pattern (e.g. .git/, .obsidian/)
        if (this.isExcluded(dirPath + "/")) break;
        const dir = this.vault.getEntryByPath(dirPath);
        if (!dir || dir.kind !== "folder") break;
        if (await this.vault.isDirectoryEmpty(dirPath)) {
          await this.vault.deleteDirectory(dir);
        } else {
          break;
        }
      }
    } catch {
      // Directory cleanup is best-effort — ignore errors silently
    }
  }

  private async ensureParentDirs(filePath: string): Promise<void> {
    const parts = filePath.split("/");
    if (parts.length <= 1) return;

    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current = current ? `${current}/${parts[i]}` : parts[i];
      const normalized = this.normalizePath(current);
      if (!this.vault.getEntryByPath(normalized)) {
        await this.vault.createDirectory(normalized);
      }
    }
  }

  // --- Local change handlers (called by plugin event listeners or filesystem watcher) ---

  /**
   * Called when a local file is modified/created.
   * Debounces writes to batch rapid edits (e.g., typing).
   */
  handleLocalChange(file: VaultEntry): void {
    if (!this.running || this.applyingRemote) return;
    if (file.kind !== "file") return;
    if (this.isExcluded(file.path)) return;
    if (file.size > MAX_FILE_SIZE) return; // TODO: chunk large files
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
  async handleLocalDelete(file: VaultEntry): Promise<void> {
    if (!this.running || this.applyingRemote) return;
    if (file.kind !== "file") return;
    if (this.isExcluded(file.path)) return;

    const docId = pathToDocId(file.path);
    const entry = this.revMap[docId];
    const rev = entry?.rev;
    console.log(`[vault-sync] Delete: ${file.path} docId=${docId} rev=${rev ?? "NONE"}`);
    if (!rev) {
      // Never synced, nothing to do for CouchDB — still clean up empty parent dirs
      await this.cleanupEmptyParents(file.path);
      return;
    }

    try {
      const result = await this.client.delete(docId, rev);
      if (result.ok) {
        this.markTombstoned(docId, result.rev ?? rev);
        this.persistState();
      }
    } catch (e) {
      if (e instanceof CouchError && e.status === 404) {
        this.markTombstoned(docId, rev);
        this.persistState();
      } else {
        this.setError(`Failed to delete remote ${file.path}: ${(e as Error).message}`);
      }
    }
    await this.cleanupEmptyParents(file.path);
  }

  /** Called when a local file is renamed */
  async handleLocalRename(file: VaultEntry, oldPath: string): Promise<void> {
    if (!this.running || this.applyingRemote) return;
    if (file.kind !== "file") return;

    // Delete old doc
    const oldDocId = pathToDocId(oldPath);
    const oldRev = this.revMap[oldDocId]?.rev;
    if (oldRev) {
      try {
        const result = await this.client.delete(oldDocId, oldRev);
        this.markTombstoned(oldDocId, result.rev ?? oldRev);
      } catch {
        // Best effort delete of old path — tombstone with prior rev
        this.markTombstoned(oldDocId, oldRev);
      }
    }

    // Push as new doc at new path
    if (!this.isExcluded(file.path)) {
      await this.pushFile(file);
    }

    // Clean up empty parent dirs left behind by the old path
    await this.cleanupEmptyParents(oldPath);

    this.persistState();
  }

  // --- Push single file ---

  private async pushFile(file: VaultFile): Promise<void> {
    const key = file.path;
    const isBinary = this.isBinaryDoc(pathToDocId(file.path));
    // Escape hatch: skip binary push if disabled in config. Used to keep text sync working
    // while binary push has known issues (e.g. tombstone 404 loop on resurrected files).
    if (isBinary && this.settings.disableBinaryPush) return;
    // Serialize pushes per file to prevent concurrent 409 conflicts
    const prev = this.pushLocks.get(key) ?? Promise.resolve();
    const settled = prev.catch(() => {}); // ensure chain continues even if prev failed
    const next = settled.then(async () => {
      if (isBinary) {
        await this.pushBinaryFile(file);
      } else {
        await this.pushTextFile(file);
      }
    });
    const swallowed = next.catch(() => {}); // store settled version so chain never rejects
    this.pushLocks.set(key, swallowed);
    await next;
  }

  private async pushTextFile(file: VaultFile): Promise<void> {
    try {
      const docId = pathToDocId(file.path);

      // Tombstoned path: do not push content; instead propagate the delete to FS
      if (this.revMap[docId]?.state === "tombstoned") {
        await this.handleRemoteDelete(docId);
        return;
      }

      let content: string;
      try {
        content = await this.vault.readText(file);
        // Successful read: remove from unsyncable set (file is accessible again)
        this.unsyncableFiles.delete(file.path);
      } catch (e) {
        const check = isRecoverableReadError(e);
        if (check.recoverable) {
          this.unsyncableFiles.set(file.path, {
            reason: check.code ?? "unknown",
            firstSeen: this.unsyncableFiles.get(file.path)?.firstSeen ?? Date.now(),
            retryAfter: Date.now() + 60_000,
          });
          return; // Skip this file, continue rest of sync
        }
        throw e; // Non-recoverable: propagate
      }

      const doc: CouchDoc = {
        _id: docId,
        content,
        mtime: file.mtime,
      };

      // Always pass _rev when we have a revMap entry — avoids 409 storm after migration
      // (mtime:0 entries still have the correct rev from the legacy string value).
      // If no revMap entry, fetch the current rev to avoid a blind conflict.
      if (this.revMap[docId]) {
        doc._rev = this.revMap[docId].rev;
      } else {
        try {
          const remote = await this.client.get(docId);
          if (remote._rev) doc._rev = remote._rev;
        } catch (e) {
          if (isTombstone404(e)) {
            // Server has a tombstone — do not resurrect; delete locally and bail out
            await this.handleRemoteDelete(docId);
            return;
          }
          // Doc not found (missing, not deleted) — push as new with no _rev
        }
      }

      try {
        const result = await this.client.put(doc);
        if (result.ok && result.rev) {
          this.revMap[docId] = { state: "known", rev: result.rev, mtime: file.mtime };
          this.persistState();
        }
      } catch (e) {
        if (e instanceof CouchError && e.status === 409) {
          await this.resolveConflict(docId, content, file.mtime);
        } else {
          throw e;
        }
      }
    } catch (e) {
      this.setError(`Push failed for ${file.path}: ${(e as Error).message}`);
    }
  }

  private async pushBinaryFile(file: VaultFile): Promise<void> {
    try {
      const docId = pathToDocId(file.path);

      // Tombstoned path: do not push content; instead propagate the delete to FS
      if (this.revMap[docId]?.state === "tombstoned") {
        await this.handleRemoteDelete(docId);
        return;
      }

      let data: ArrayBuffer;
      try {
        data = await this.vault.readBinary(file);
        // Successful read: remove from unsyncable set (file is accessible again)
        this.unsyncableFiles.delete(file.path);
      } catch (e) {
        const check = isRecoverableReadError(e);
        if (check.recoverable) {
          this.unsyncableFiles.set(file.path, {
            reason: check.code ?? "unknown",
            firstSeen: this.unsyncableFiles.get(file.path)?.firstSeen ?? Date.now(),
            retryAfter: Date.now() + 60_000,
          });
          return; // Skip this file, continue rest of sync
        }
        throw e; // Non-recoverable: propagate
      }

      const contentType = contentTypeForPath(file.path);

      // Ensure the stub doc exists first (needed for the attachment PUT).
      // Always pass _rev when we have a revMap entry — avoids 409 storm after migration.
      let rev = this.revMap[docId]?.rev ?? "";
      if (!rev) {
        try {
          const remote = await this.client.get(docId);
          rev = remote._rev ?? "";
        } catch (e) {
          if (isTombstone404(e)) {
            // Server has a tombstone — do not resurrect; delete locally and bail out
            await this.handleRemoteDelete(docId);
            return;
          }
          // Doc not found (missing, not deleted) — create stub doc
          const stubResult = await this.client.put({ _id: docId, content: null, mtime: file.mtime });
          rev = stubResult.rev ?? "";
          if (stubResult.rev) this.revMap[docId] = { state: "known", rev: stubResult.rev, mtime: file.mtime };
        }
      }

      const MAX_RETRIES = 3;
      let attachmentRev = rev;
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const result = await this.client.putAttachment(docId, ATTACHMENT_NAME, attachmentRev, data, contentType);
          if (result.ok && result.rev) {
            this.revMap[docId] = { state: "known", rev: result.rev, mtime: file.mtime };
            this.persistState();
          }
          break;
        } catch (e) {
          if (isTombstone404(e)) {
            // Server cleaned up this doc — delete locally and bail out without retrying
            await this.handleRemoteDelete(docId);
            return;
          } else if (e instanceof CouchError && e.status === 409 && attempt < MAX_RETRIES - 1) {
            // Rev became stale between stub PUT and attachment PUT — refetch and retry
            const fresh = await this.client.get(docId);
            attachmentRev = fresh._rev ?? "";
            const curEntry: RevMapEntry | undefined = this.revMap[docId];
            this.revMap[docId] = {
              state: "known",
              rev: attachmentRev,
              mtime: curEntry?.state === "known" ? curEntry.mtime : 0,
            };
          } else {
            throw e;
          }
        }
      }
    } catch (e) {
      this.setError(`Binary push failed for ${file.path}: ${(e as Error).message}`);
    }
  }

  /**
   * Resolve a push conflict using last-write-wins by mtime.
   * Fetches the remote version, compares mtime, and the newest version wins.
   * No conflict files are created - resolution is fully automatic.
   * Retries up to MAX_RETRIES times if further 409s occur during resolution.
   */
  private async resolveConflict(
    docId: string,
    localContent: string | null,
    localMtime: number,
  ): Promise<void> {
    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const remote = await this.client.get(docId);
      // Update rev on initial fetch; keep existing mtime until resolution determines the winner
      const existing = this.revMap[docId];
      const existingMtime = existing?.state === "known" ? existing.mtime : 0;
      this.revMap[docId] = { state: "known", rev: remote._rev!, mtime: remote.mtime ?? existingMtime };

      if (remote.content === localContent) {
        // Same content, no real conflict - just update rev
        this.persistState();
        return;
      }

      if (lwwWinner(localMtime, remote.mtime ?? 0) === "local") {
        // Local is newer (or equal mtime) - push local content over remote
        const doc: CouchDoc = {
          _id: docId,
          _rev: remote._rev,
          content: localContent,
          mtime: localMtime,
        };
        try {
          const result = await this.client.put(doc);
          if (result.ok && result.rev) {
            this.revMap[docId] = { state: "known", rev: result.rev, mtime: localMtime };
          }
          this.persistState();
          return;
        } catch (e) {
          if (e instanceof CouchError && e.status === 409 && attempt < MAX_RETRIES - 1) {
            // Rev changed again between fetch and put, retry
            continue;
          }
          throw e;
        }
      } else {
        // Remote is newer - apply remote content locally
        const normalized = this.normalizePath(docIdToPath(docId));
        const existingFile = this.vault.getEntryByPath(normalized);
        if (existingFile && existingFile.kind === "file" && typeof remote.content === "string") {
          this.applyingRemote = true;
          try {
            await this.vault.modifyText(existingFile, remote.content);
          } finally {
            this.applyingRemote = false;
          }
        }
        this.persistState();
        return;
      }
    }
  }

  // --- Recent remote path tracking (echo suppression with cleanup) ---

  private trackRecentRemotePath(path: string): void {
    this.recentRemotePaths.add(path);
    const existing = this.recentRemoteTimers.get(path);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.recentRemotePaths.delete(path);
      this.recentRemoteTimers.delete(path);
    }, 2000);
    this.recentRemoteTimers.set(path, timer);
  }

  // --- Counts ---

  private emitCounts(): void {
    this.onCountsChange({
      pendingPush: this.pendingWrites.size,
      pendingPull: this.pullCount,
    });
    this.onDiagnosticsChange();
  }

  // --- Utilities ---

  private isExcluded(path: string): boolean {
    return this.settings.excludePatterns.some((pattern) => path.startsWith(pattern));
  }
}
