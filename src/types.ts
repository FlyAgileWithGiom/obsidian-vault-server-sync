export interface VaultSyncSettings {
  couchDbUrl: string;
  couchDbName: string;
  couchDbUser: string;
  couchDbPassword: string;
  syncDebounceMs: number;
  excludePatterns: string[];
}

export const DEFAULT_SETTINGS: VaultSyncSettings = {
  couchDbUrl: "https://sync.fly-agile.com",
  couchDbName: "vault-v2-prod",
  couchDbUser: "",
  couchDbPassword: "",
  syncDebounceMs: 500,
  excludePatterns: [".obsidian/", ".trash/"],
};

export type SyncState = "idle" | "syncing" | "ok" | "error" | "offline" | "not-configured";

export interface SyncCounts {
  pendingPush: number;
  pendingPull: number;
}

/** Tracks known revision for each doc to detect remote changes */
export interface RevMap {
  [docId: string]: string;
}

export interface CouchDoc {
  _id: string;
  _rev?: string;
  content: string;
  mtime: number;
  deleted?: boolean;
}

export interface CouchBulkResult {
  ok?: boolean;
  id: string;
  rev?: string;
  error?: string;
  reason?: string;
}

export interface CouchChangesResult {
  last_seq: string | number;
  results: CouchChangeRow[];
}

export interface CouchChangeRow {
  seq: string | number;
  id: string;
  changes: { rev: string }[];
  deleted?: boolean;
  doc?: CouchDoc;
}

export interface CouchAllDocsResult {
  total_rows: number;
  rows: {
    id: string;
    key: string;
    value: { rev: string };
    doc?: CouchDoc;
  }[];
}
