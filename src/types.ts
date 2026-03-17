export interface VaultSyncSettings {
  couchdbUrl: string;
  database: string;
  username: string;
  password: string;
  debounceMs: number;
  pollIntervalSec: number;
  maxBinarySize: number;
}

export const DEFAULT_SETTINGS: VaultSyncSettings = {
  couchdbUrl: "",
  database: "vault-v2-prod",
  username: "",
  password: "",
  debounceMs: 500,
  pollIntervalSec: 30,
  maxBinarySize: 20 * 1024 * 1024,
};

export interface CouchDoc {
  _id: string;
  _rev?: string;
  type: "file";
  content?: string;
  mtime: number;
  ctime: number;
  size: number;
  deleted?: boolean;
  _attachments?: Record<string, { content_type: string; data?: string }>;
}

export interface ChangeResult {
  id: string;
  seq: string;
  changes: { rev: string }[];
  doc?: CouchDoc;
  deleted?: boolean;
}

export interface QueuedChange {
  path: string;
  type: "upsert" | "delete";
  timestamp: number;
  retries: number;
}
