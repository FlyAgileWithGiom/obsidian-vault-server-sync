export interface VaultSyncSettings {
  couchDbUrl: string;
  couchDbName: string;
  couchDbUser: string;
  couchDbPassword: string;
  syncDebounceMs: number;
  excludePatterns: string[];
  /**
   * Skip binary file push entirely. Use as escape hatch when binary push
   * is misbehaving (e.g. tombstone 404 loop on resurrected files) and
   * blocks the daemon from reaching State: ok. Text sync continues normally.
   * Default: false.
   */
  disableBinaryPush?: boolean;
}

/** Filename for plugin-managed settings at vault root */
export const VAULT_SYNC_CONFIG_FILE = ".vault-sync.json";

export const DEFAULT_SETTINGS: VaultSyncSettings = {
  couchDbUrl: "https://sync.fly-agile.com",
  couchDbName: "",
  couchDbUser: "",
  couchDbPassword: "",
  syncDebounceMs: 500,
  excludePatterns: [".trash/", ".obsidian/", ".vault-sync-state.json", VAULT_SYNC_CONFIG_FILE],
};

export type SyncState = "idle" | "syncing" | "ok" | "error" | "offline" | "not-configured";

/**
 * Two-phase initial-pull phase (Refs #72), distinct from SyncState.
 *
 * SyncState must NOT read "ok" while binaries are still backfilling — that would render
 * "Synced" as a lie. The phase carries the honest "notes ready, attachments syncing"
 * signal independently of state. Mirrors PouchDbSyncEngine's internal SyncPhase.
 */
export type SyncPhase = "idle" | "text-pull" | "text-ready" | "binary-backfill" | "complete";

export interface SyncCounts {
  pendingPush: number;
  pendingPull: number;
}

export type RevMapEntry =
  | { state: "known"; rev: string; mtime: number }
  | { state: "tombstoned"; rev: string; tombstonedAt: number }
  | { state: "orphan"; rev: string };

/** Tracks known revision and state for each doc to detect remote changes and skip unchanged files */
export interface RevMap {
  [docId: string]: RevMapEntry;
}

/** Diagnostic snapshot for settings UI -- provides observability on mobile */
export interface SyncDiagnostics {
  running: boolean;
  state: SyncState;
  revMapSize: number;       // total entries (known + tombstoned + orphan)
  knownRevMapSize: number;  // entries with state: "known" only
  lastSeq: string | number;
  pullProgress: { fetched: number; total: number } | null;
  pullSkipped: number;
  pullApplied: number;
  pendingPushCount: number;
  lastError: string | null;
  /** Files skipped due to recoverable read errors (EAGAIN, EACCES, EIO, ENOENT) */
  unsyncableCount: number;
  /** Up to 5 paths of currently unsyncable files, for diagnostics UI */
  unsyncableSample: string[];
  /** Rolling average (last 50 samples) of allDocsByKeys call duration in pullTextDocs, ms */
  avgFetchMs: number | null;
  /** Number of samples in the avgFetchMs rolling buffer */
  fetchSampleCount: number;
  /** Rolling average (last 50 samples) of applyRemoteDoc call duration in pullTextDocs, ms */
  avgApplyMs: number | null;
  /** Number of samples in the avgApplyMs rolling buffer */
  applySampleCount: number;
  /**
   * Two-phase initial-pull phase (Refs #72). Distinct from `state`: when this is
   * "text-ready" or "binary-backfill", `state` is still "syncing" (binaries pending) —
   * the UI reads this to show "Notes ready, attachments syncing" without claiming "Synced".
   */
  syncPhase: SyncPhase;
  /**
   * Binary backfill progress during phase-2, or null when unavailable.
   * Pattern B has no binary-specific counter (the live db.sync `pending` is a combined
   * text+binary figure), so this is null under Pattern B and reserved for a future
   * Pattern A exact "attachments N/total". Do not fabricate an N/6750 from combined pending.
   */
  binaryProgress: { fetched: number; total: number } | null;
}

/**
 * Dry-run plan produced by SyncEngine.planFullSync().
 *
 * Models exactly what forceFullSync() would do (bypass=true) without any writes.
 * Each count/sample pair mirrors one decision branch in fullSync.
 *
 * Assumption: the plan is computed with bypassOrphanGuard=true by default because
 * the user-facing button routes through forceFullSync, which sets bypass=true after
 * clearState().  Tests should also cover bypass=false to exercise the guard branch.
 */
export interface FullSyncPlan {
  /** Files on FS not present in remoteRevs — would push as new docs */
  wouldPushNew: { count: number; sample: string[] };
  /** Files on FS present in remoteRevs but locally changed since last sync */
  wouldPushChanged: { count: number; sample: string[] };
  /** Remote docs whose rev differs from revMap (or no revMap entry when bypass=true) — would pull */
  wouldPullRevMismatch: { count: number; sample: string[] };
  /**
   * Remote docs with no revMap entry when bypassOrphanGuard=false — would be skipped.
   * When bypass=true this bucket is empty and those docs appear in wouldPullRevMismatch.
   * A non-zero count here is the diagnostic signal that surfaced the PR #30 bug.
   */
  wouldSkipOrphanGuard: { count: number; sample: string[] };
  /** revMap "known" entries with no FS file — would propagate tombstone to remote */
  wouldTombstoneLocal: { count: number; sample: string[] };
  /** revMap "known" entries absent from remoteRevs — would delete local file */
  wouldPullDelete: { count: number; sample: string[] };
  /**
   * Files that the server has tombstoned (detected via allDocsByKeys on unknownFiles).
   * Would cause local deletion.  Separate from wouldPullDelete because these are
   * files that *exist locally* but the remote has a tombstone for — the most
   * surprising action a full sync can take.
   */
  wouldDeleteLocalTombstoned: { count: number; sample: string[] };
  /** revMap entries already in tombstoned state (informational — no action taken) */
  alreadyTombstoned: number;
  /** revMap entries already in orphan state (informational — no action taken) */
  alreadyOrphan: number;
  /** Files skipped because they exceed MAX_FILE_SIZE (same threshold as fullSync) */
  oversizeSkipped: number;
  /** Files skipped because they match excludePatterns (informational) */
  excludedCount: number;
}

// --- Portable abstractions (used by both Obsidian plugin and headless daemon) ---

export type VaultFile = { kind: "file"; path: string; mtime: number; size: number };
export type VaultFolder = { kind: "folder"; path: string };
export type VaultEntry = VaultFile | VaultFolder;

export interface VaultAdapter {
  getFiles(): VaultFile[];
  getEntryByPath(path: string): VaultEntry | null;
  readText(file: VaultFile): Promise<string>;
  readBinary(file: VaultFile): Promise<ArrayBuffer>;
  modifyText(file: VaultFile, content: string): Promise<void>;
  modifyBinary(file: VaultFile, data: ArrayBuffer): Promise<void>;
  createText(path: string, content: string): Promise<VaultFile>;
  createBinary(path: string, data: ArrayBuffer): Promise<VaultFile>;
  createDirectory(path: string): Promise<void>;
  deleteFile(file: VaultFile): Promise<void>;
  deleteDirectory(dir: VaultFolder): Promise<void>;
  isDirectoryEmpty(path: string): Promise<boolean>;
  normalizePath(path: string): string;
}

