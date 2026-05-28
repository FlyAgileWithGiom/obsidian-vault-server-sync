/**
 * Stateful CouchDB facade for binary-resilience scenario tests.
 *
 * Design principles:
 * - Never materializes 6000 doc objects in heap — generates rows on demand from index ranges.
 * - Failure plans drive putAttachment behavior per file path.
 * - Tracks putAttachment concurrency (inFlight / maxInFlight) for P2 assertion.
 * - Sentinel call detection: changes(0, {limit:0}) returns the last_seq oracle.
 */

import type {
  CouchDoc,
  CouchAllDocsResult,
  CouchBulkResult,
  CouchChangesResult,
  VaultFile,
} from "../types";

const DOC_PREFIX = "file/";

/** Failure plan for a single binary path */
type FailurePlan = "always-fail" | { failCount: number };

export interface FacadeOpts {
  textCount: number;
  binaryCount: number;
  /**
   * Keyed by vault path (e.g. "assets/bin-3.png").
   * "always-fail": every putAttachment call rejects unconditionally.
   * { failCount: N }: rejects on calls 1..N, succeeds on call N+1+.
   */
  failures?: Record<string, FailurePlan>;
}

export interface CouchFacade {
  /** Maximum simultaneous putAttachment calls observed */
  maxInFlight: number;
  /** All timeoutMs values passed to putAttachment */
  putAttachmentTimeouts: number[];
  /** Total putAttachment call count across all files */
  putAttachmentCallCount: number;
  /** Per-path putAttachment call timestamps (virtual Date.now() at entry) */
  putAttachmentTimestamps: Map<string, number[]>;

  // CouchClient interface
  isConfigured(): boolean;
  ensureDb(): Promise<void>;
  get(docId: string): Promise<CouchDoc>;
  put(doc: CouchDoc): Promise<CouchBulkResult>;
  delete(docId: string, rev: string): Promise<CouchBulkResult>;
  allDocs(options: { startkey?: string; endkey?: string; limit?: number; include_docs?: boolean }): Promise<CouchAllDocsResult>;
  allDocsByKeys(keys: string[], _timeoutMs?: number): Promise<CouchAllDocsResult>;
  bulkDocs(docs: CouchDoc[]): Promise<CouchBulkResult[]>;
  changes(since: string | number, options?: { limit?: number; timeout?: number; include_docs?: boolean }): Promise<CouchChangesResult>;
  cancelChanges(): void;
  updateSettings(_settings: unknown): void;
  getAttachment(_docId: string, _attName: string, _timeoutMs?: number): Promise<ArrayBuffer>;
  putAttachment(docId: string, attName: string, rev: string, data: ArrayBuffer, contentType: string, timeoutMs?: number): Promise<CouchBulkResult>;
}

function pathToDocId(path: string): string {
  return `${DOC_PREFIX}${path}`;
}

function makeFakeRev(n: number): string {
  return `1-${n.toString(16).padStart(32, "0")}`;
}

function isBinaryDocId(docId: string): boolean {
  const ext = docId.split(".").pop()?.toLowerCase() ?? "";
  return ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "gif" || ext === "webp";
}

/** Build a synthetic text doc row (no content, rev-only for allDocs scan) */
function makeTextDocRow(n: number) {
  const id = pathToDocId(`notes/file-${n}.md`);
  const rev = makeFakeRev(n);
  return { id, key: id, value: { rev } };
}

/** Build a synthetic binary doc row */
function makeBinaryDocRow(n: number) {
  const id = pathToDocId(`assets/bin-${n}.png`);
  const rev = makeFakeRev(100_000 + n);
  return { id, key: id, value: { rev } };
}

/**
 * Build a synthetic allDocsByKeys row for a given docId.
 * For text docs: returns inline content (the bulkPushExistingRemoteDocs path expects it).
 * For binary docs: returns _attachments stub so pullBinaryDocs queues a download.
 */
function makeKeyRow(docId: string, textCount: number, binaryCount: number) {
  const path = docId.startsWith(DOC_PREFIX) ? docId.slice(DOC_PREFIX.length) : docId;
  const rev = docId.includes("bin-") ? makeFakeRev(parseInt(path.match(/bin-(\d+)/)?.[1] ?? "0") + 100_000) : makeFakeRev(parseInt(path.match(/file-(\d+)/)?.[1] ?? "0"));

  if (isBinaryDocId(docId)) {
    // Binary docs need the attachment stub so the engine knows to download
    return {
      id: docId,
      key: docId,
      value: { rev },
      doc: {
        _id: docId,
        _rev: rev,
        content: null,
        mtime: 2_000_000,
        _attachments: { "data.bin": { content_type: "image/png", length: 4096, stub: true as const } },
      },
    };
  }

  // Text doc: return inline content so bulkPushExistingRemoteDocs can compare
  const n = parseInt(path.match(/file-(\d+)/)?.[1] ?? "0");
  const content = `text-${n}-${"x".repeat(Math.max(0, 506 - String(n).length))}`;
  return {
    id: docId,
    key: docId,
    value: { rev },
    doc: {
      _id: docId,
      _rev: rev,
      content,
      mtime: 1_000_000,
    },
  };
}

export function makeCouchFacade(opts: FacadeOpts): CouchFacade {
  const { textCount, binaryCount, failures = {} } = opts;

  // Concurrency tracking for P2
  let inFlight = 0;
  let maxInFlight = 0;

  // Per-path call count for failure plan evaluation
  const callCounts = new Map<string, number>();

  // All timeoutMs values passed to putAttachment
  const putAttachmentTimeouts: number[] = [];
  let putAttachmentCallCount = 0;

  // Per-path timestamps at putAttachment entry
  const putAttachmentTimestamps = new Map<string, number[]>();

  // Rev tracking: binary docs get rev bumped on each successful putAttachment
  const binaryRevs = new Map<string, string>();
  for (let i = 0; i < binaryCount; i++) {
    const docId = pathToDocId(`assets/bin-${i}.png`);
    binaryRevs.set(docId, makeFakeRev(100_000 + i));
  }

  // Text docs: rev is stable (content matches local → no push needed after bulkCompare)
  const textRevs = new Map<string, string>();
  for (let i = 0; i < textCount; i++) {
    const docId = pathToDocId(`notes/file-${i}.md`);
    textRevs.set(docId, makeFakeRev(i));
  }

  const facade: CouchFacade = {
    get maxInFlight() { return maxInFlight; },
    get putAttachmentTimeouts() { return putAttachmentTimeouts; },
    get putAttachmentCallCount() { return putAttachmentCallCount; },
    get putAttachmentTimestamps() { return putAttachmentTimestamps; },

    isConfigured: () => true,

    ensureDb: async () => { /* no-op */ },

    get: async (docId: string): Promise<CouchDoc> => {
      // Used during 409 backoff to fetch fresh rev
      const rev = binaryRevs.get(docId) ?? textRevs.get(docId) ?? "1-aaaa";
      return { _id: docId, _rev: rev, content: null, mtime: 0 };
    },

    put: async (doc: CouchDoc): Promise<CouchBulkResult> => {
      // Stub doc creation for binary push
      const docId = doc._id;
      const newRev = `2-${docId.slice(-8).padStart(32, "0")}`;
      if (isBinaryDocId(docId)) {
        binaryRevs.set(docId, newRev);
      }
      return { ok: true, id: docId, rev: newRev };
    },

    delete: async (docId: string, rev: string): Promise<CouchBulkResult> => {
      return { ok: true, id: docId, rev: `${parseInt(rev[0]) + 1}-deleted` };
    },

    allDocs: async (options: { startkey?: string; endkey?: string; limit?: number; include_docs?: boolean } = {}): Promise<CouchAllDocsResult> => {
      // Build paginated index of all docs (text + binary), sorted by docId
      const allRows: { id: string; key: string; value: { rev: string } }[] = [];

      for (let i = 0; i < textCount; i++) {
        allRows.push(makeTextDocRow(i));
      }
      for (let i = 0; i < binaryCount; i++) {
        allRows.push(makeBinaryDocRow(i));
      }

      // Sort by id (CouchDB returns docs sorted by key)
      allRows.sort((a, b) => a.id.localeCompare(b.id));

      // Apply startkey / endkey filter
      let filtered = allRows;
      if (options.startkey) {
        filtered = filtered.filter((r) => r.id >= options.startkey!);
      }
      if (options.endkey) {
        filtered = filtered.filter((r) => r.id <= options.endkey!);
      }

      // Apply limit (used for pagination lookahead: limit = PAGE_SIZE + 1)
      if (options.limit !== undefined) {
        filtered = filtered.slice(0, options.limit);
      }

      return { total_rows: textCount + binaryCount, rows: filtered };
    },

    allDocsByKeys: async (keys: string[], _timeoutMs?: number): Promise<CouchAllDocsResult> => {
      const rows = keys.map((docId) => makeKeyRow(docId, textCount, binaryCount));
      return { total_rows: rows.length, rows };
    },

    bulkDocs: async (docs: CouchDoc[]): Promise<CouchBulkResult[]> => {
      return docs.map((doc) => ({
        ok: true,
        id: doc._id,
        rev: `2-bulk${doc._id.slice(-4)}`,
      }));
    },

    changes: async (since: string | number, options?: { limit?: number; timeout?: number; include_docs?: boolean }): Promise<CouchChangesResult> => {
      // Sentinel call: changes(0, { limit: 0 }) → return last_seq oracle
      if (since === 0 && options?.limit === 0) {
        return { last_seq: `${textCount + binaryCount}`, results: [] };
      }
      // Polling call (after forceFullSync starts polling): return empty to avoid infinite loop
      return { last_seq: `${textCount + binaryCount}`, results: [] };
    },

    cancelChanges: () => { /* no-op */ },

    updateSettings: (_settings: unknown) => { /* no-op */ },

    getAttachment: async (_docId: string, _attName: string, _timeoutMs?: number): Promise<ArrayBuffer> => {
      return new ArrayBuffer(4096);
    },

    putAttachment: async (
      docId: string,
      _attName: string,
      rev: string,
      _data: ArrayBuffer,
      _contentType: string,
      timeoutMs?: number,
    ): Promise<CouchBulkResult> => {
      // Record timestamp at entry (before any async work)
      const path = docId.startsWith(DOC_PREFIX) ? docId.slice(DOC_PREFIX.length) : docId;
      const timestamps = putAttachmentTimestamps.get(path) ?? [];
      timestamps.push(Date.now());
      putAttachmentTimestamps.set(path, timestamps);

      // Track timeout values for P1 assertion
      putAttachmentTimeouts.push(timeoutMs ?? -1);
      putAttachmentCallCount++;

      // Track concurrency for P2 assertion.
      // Yield here so other concurrent callers can also enter before any resolves.
      // Without this yield, JS single-threaded execution would serialize all calls
      // (inFlight++ then inFlight-- before next call starts), making maxInFlight always 1.
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      await Promise.resolve(); // Let other concurrent putAttachment calls start

      try {
        const count = (callCounts.get(path) ?? 0) + 1;
        callCounts.set(path, count);

        const plan = failures[path];
        if (plan === "always-fail") {
          throw new Error("EIO");
        }
        if (plan && typeof plan === "object" && count <= plan.failCount) {
          throw new Error("network timeout");
        }

        // Success: bump rev
        const newRev = `${parseInt(rev[0]) + 1}-${path.slice(-8).padStart(32, "0")}`;
        binaryRevs.set(docId, newRev);
        return { ok: true, id: docId, rev: newRev };
      } finally {
        inFlight--;
      }
    },
  };

  return facade;
}
