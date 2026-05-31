export interface VaultSyncSettings {
  couchDbUrl: string;
  couchDbName: string;
  couchDbUser: string;
  couchDbPassword: string;
  excludePatterns: string[];
}

/** Filename for plugin-managed settings at vault root */
export const VAULT_SYNC_CONFIG_FILE = ".vault-sync.json";

export const DEFAULT_SETTINGS: VaultSyncSettings = {
  couchDbUrl: "https://sync.fly-agile.com",
  couchDbName: "",
  couchDbUser: "",
  couchDbPassword: "",
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
  /**
   * Two-phase initial-pull phase (Refs #72). Distinct from `state`: when this is
   * "text-ready" or "binary-backfill", `state` is still "syncing" (binaries pending) —
   * the UI reads this to show "Notes ready, attachments syncing" without claiming "Synced".
   */
  syncPhase: SyncPhase;
  pullProgress: { fetched: number; total: number } | null;
  pullApplied: number;
  /**
   * Binary backfill progress during phase-2, or null when unavailable.
   * Pattern B has no binary-specific counter (the live db.sync `pending` is a combined
   * text+binary figure), so this is null under Pattern B and reserved for a future
   * Pattern A exact "attachments N/total". Do not fabricate an N/6750 from combined pending.
   */
  binaryProgress: { fetched: number; total: number } | null;
  lastError: string | null;
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

