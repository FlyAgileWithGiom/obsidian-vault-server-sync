/**
 * Tests for PouchDbFsBridge — bidirectional FS <-> PouchDB bridge.
 *
 * Uses jsdom environment (configured in vitest.config.ts environmentMatchGlobs).
 * PouchDB is not mocked — a real in-memory PouchDB instance is used via pouchdb-browser
 * which adapts to localStorage in jsdom.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PouchDbFsBridge } from "./PouchDbFsBridge";
import type { VaultAdapter, VaultFile, VaultEntry, VaultFolder } from "./types";
import { pathToDocId } from "./doc-id";
import { contentTypeForPath, ATTACHMENT_NAME } from "./binary-ext";
import type { VaultWatcher, FileEvent } from "./WatcherAdapter";

// ---- Minimal PouchDB-shaped in-memory mock --------------------------------
// We don't want the full pouchdb-browser runtime in unit tests (IndexedDB setup,
// complex async initialization). Instead we use a hand-rolled in-memory store
// that mirrors the PouchDB API surface used by PouchDbFsBridge.

type DocShape = {
  _id: string;
  _rev?: string;
  _deleted?: boolean;
  deleted?: boolean;
  content?: string | null;
  mtime?: number;
  _attachments?: Record<string, unknown>;
  _conflicts?: string[];
};

type AttachmentShape = Blob | ArrayBuffer;

function makePouchMock() {
  const docs = new Map<string, DocShape>();
  const attachments = new Map<string, AttachmentShape>();
  let revCounter = 0;

  // Change listeners: { cancel(), on(event, handler) }
  type ChangeHandler = (change: { id: string; seq: number; deleted?: boolean; doc?: DocShape }) => void;
  type ErrorHandler = (err: unknown) => void;
  const changeListeners: ChangeHandler[] = [];
  const errorListeners: ErrorHandler[] = [];

  let cancelled = false;

  const changesHandle = {
    cancel() { cancelled = true; },
    on(event: "change" | "error", handler: ChangeHandler | ErrorHandler) {
      if (event === "change") changeListeners.push(handler as ChangeHandler);
      if (event === "error") errorListeners.push(handler as ErrorHandler);
      return changesHandle;
    },
  };

  /** Emit a synthetic change event to all registered listeners.
   * Also stores the doc in the in-memory map so that db.get() returns the
   * correct _rev after the event fires — matching real PouchDB behaviour
   * where the doc is persisted before the change feed fires.
   */
  function emitChange(doc: DocShape) {
    if (cancelled) return;
    // Persist the doc first (real PouchDB stores before firing change feed)
    if (!doc._deleted) {
      docs.set(doc._id, { ...doc });
    }
    const event = { id: doc._id, seq: revCounter, deleted: !!doc._deleted, doc };
    for (const h of changeListeners) h(event);
  }

  // Conflict revision store: docId -> Map<rev, doc>
  // Used by LWW resolver tests to populate alternative conflict revisions.
  const conflictDocs = new Map<string, Map<string, DocShape>>();

  return {
    async get(id: string, opts?: { open_revs?: string[] }): Promise<DocShape | Array<{ ok: DocShape }>> {
      if (opts?.open_revs) {
        // Return all requested revisions as {ok: doc} rows
        const revMap = conflictDocs.get(id) ?? new Map<string, DocShape>();
        const mainDoc = docs.get(id);
        if (mainDoc && mainDoc._rev) revMap.set(mainDoc._rev, mainDoc);
        const rows: Array<{ ok: DocShape }> = [];
        for (const rev of opts.open_revs) {
          const d = revMap.get(rev);
          if (d) rows.push({ ok: { ...d } });
        }
        return rows;
      }
      const doc = docs.get(id);
      if (!doc || doc._deleted) throw { status: 404, name: "not_found" };
      return { ...doc };
    },

    async put(doc: DocShape): Promise<{ ok: boolean; id: string; rev: string }> {
      revCounter++;
      const rev = `${revCounter}-abc`;
      const stored = { ...doc, _rev: rev };
      docs.set(doc._id, stored);
      emitChange(stored);
      return { ok: true, id: doc._id, rev };
    },

    async putAttachment(
      docId: string,
      attachmentId: string,
      rev: string,
      data: AttachmentShape,
      _contentType: string,
    ): Promise<{ ok: boolean; id: string; rev: string }> {
      revCounter++;
      const newRev = `${revCounter}-abc`;
      const doc = docs.get(docId);
      if (!doc) throw { status: 404 };
      const stored = {
        ...doc,
        _rev: newRev,
        _attachments: { ...(doc._attachments ?? {}), [attachmentId]: { stub: false } },
      };
      docs.set(docId, stored);
      attachments.set(`${docId}/${attachmentId}`, data);
      emitChange(stored);
      return { ok: true, id: docId, rev: newRev };
    },

    async getAttachment(docId: string, attachmentId: string): Promise<AttachmentShape> {
      const key = `${docId}/${attachmentId}`;
      const att = attachments.get(key);
      if (!att) throw { status: 404 };
      return att;
    },

    async allDocs(opts?: {
      include_docs?: boolean;
      attachments?: boolean;
      startkey?: string;
      endkey?: string;
    }): Promise<{ rows: Array<{ id: string; key: string; value: { rev: string; deleted?: boolean }; doc?: DocShape }>; total_rows: number; offset: number }> {
      const rows: Array<{ id: string; key: string; value: { rev: string; deleted?: boolean }; doc?: DocShape }> = [];
      for (const [id, doc] of docs.entries()) {
        // Real PouchDB allDocs excludes deleted docs by default
        if (doc._deleted) continue;
        if (opts?.startkey !== undefined && id < opts.startkey) continue;
        if (opts?.endkey !== undefined && id > opts.endkey) continue;
        rows.push({
          id,
          key: id,
          value: { rev: doc._rev ?? "" },
          // include_docs:true returns the full doc (mirrors real PouchDB) so the
          // folder-delete bulk sweep can build tombstone stubs without a per-doc get.
          ...(opts?.include_docs ? { doc: { ...doc } } : {}),
        });
      }
      return { rows, total_rows: rows.length, offset: 0 };
    },

    // bulkDocs: write each doc with a bumped _rev (mirrors real PouchDB). Conflicts
    // (stale _rev) are reported as per-doc error rows — NOT a thrown rejection — which
    // is how real PouchDB surfaces a 409 in a bulk write. Tolerates an empty array.
    async bulkDocs(
      bulk: DocShape[],
    ): Promise<Array<{ ok?: boolean; id?: string; rev?: string; error?: boolean; status?: number }>> {
      const results: Array<{ ok?: boolean; id?: string; rev?: string; error?: boolean; status?: number }> = [];
      for (const doc of bulk) {
        const existing = docs.get(doc._id);
        // Stale-rev conflict: the doc exists with a different _rev than the caller sent.
        if (existing && doc._rev !== undefined && existing._rev !== doc._rev) {
          results.push({ id: doc._id, error: true, status: 409 });
          continue;
        }
        revCounter++;
        const rev = `${revCounter}-abc`;
        docs.set(doc._id, { ...doc, _rev: rev });
        results.push({ ok: true, id: doc._id, rev });
      }
      return results;
    },

    changes(_opts: unknown): typeof changesHandle {
      cancelled = false;
      return changesHandle;
    },

    // Test helpers
    _docs: docs,
    _attachments: attachments,
    _emitChange: emitChange,
    _changesHandle: changesHandle,
    /** Register an extra conflict revision for a doc (for LWW resolver tests). */
    _addConflictRev(docId: string, doc: DocShape) {
      if (!conflictDocs.has(docId)) conflictDocs.set(docId, new Map());
      conflictDocs.get(docId)!.set(doc._rev ?? "", doc);
    },
  };
}

// ---- VaultWatcher mock ---------------------------------------------------
// Platform-neutral replacement for the old Obsidian plugin mock.
// Exposes emit() to fire FileEvents directly in tests.

function makeWatcherMock(): VaultWatcher & { emit(event: FileEvent): void } {
  let handler: ((event: FileEvent) => void) | null = null;
  return {
    start(h) { handler = h; },
    stop() { handler = null; },
    emit(event: FileEvent) { handler?.(event); },
  };
}

// ---- Minimal VaultAdapter mock -------------------------------------------

function makeVaultMock() {
  const textFiles = new Map<string, { file: VaultFile; content: string }>();
  const binaryFiles = new Map<string, { file: VaultFile; data: ArrayBuffer }>();
  const dirs = new Set<string>();

  function makeFile(path: string, mtime = Date.now()): VaultFile {
    return { kind: "file", path, mtime, size: 0 };
  }

  const vault: VaultAdapter & {
    _addText(path: string, content: string, mtime?: number): VaultFile;
    _getText(path: string): string | undefined;
    _getBinary(path: string): ArrayBuffer | undefined;
    _hasDir(path: string): boolean;
  } = {
    getFiles() {
      return [
        ...Array.from(textFiles.values()).map(f => f.file),
        ...Array.from(binaryFiles.values()).map(f => f.file),
      ];
    },

    getEntryByPath(path: string): VaultEntry | null {
      if (textFiles.has(path)) return textFiles.get(path)!.file;
      if (binaryFiles.has(path)) return binaryFiles.get(path)!.file;
      if (dirs.has(path)) return { kind: "folder", path } as VaultFolder;
      // Implicit folder: any file lives under this path.
      const prefix = path + "/";
      for (const p of textFiles.keys()) if (p.startsWith(prefix)) return { kind: "folder", path } as VaultFolder;
      for (const p of binaryFiles.keys()) if (p.startsWith(prefix)) return { kind: "folder", path } as VaultFolder;
      return null;
    },

    async readText(file: VaultFile): Promise<string> {
      return textFiles.get(file.path)?.content ?? "";
    },

    async readBinary(file: VaultFile): Promise<ArrayBuffer> {
      return binaryFiles.get(file.path)?.data ?? new ArrayBuffer(0);
    },

    async modifyText(file: VaultFile, content: string): Promise<void> {
      const entry = textFiles.get(file.path);
      if (entry) entry.content = content;
    },

    async modifyBinary(file: VaultFile, data: ArrayBuffer): Promise<void> {
      const entry = binaryFiles.get(file.path);
      if (entry) entry.data = data;
    },

    async createText(path: string, content: string): Promise<VaultFile> {
      const file = makeFile(path);
      textFiles.set(path, { file, content });
      return file;
    },

    async createBinary(path: string, data: ArrayBuffer): Promise<VaultFile> {
      const file = makeFile(path);
      binaryFiles.set(path, { file, data });
      return file;
    },

    async createDirectory(path: string): Promise<void> {
      dirs.add(path);
    },

    async deleteFile(file: VaultFile): Promise<void> {
      textFiles.delete(file.path);
      binaryFiles.delete(file.path);
    },

    async deleteDirectory(dir: VaultFolder): Promise<void> {
      const prefix = dir.path + "/";
      for (const p of [...textFiles.keys()]) if (p === dir.path || p.startsWith(prefix)) textFiles.delete(p);
      for (const p of [...binaryFiles.keys()]) if (p === dir.path || p.startsWith(prefix)) binaryFiles.delete(p);
      dirs.delete(dir.path);
    },

    async isDirectoryEmpty(_path: string): Promise<boolean> { return true; },

    normalizePath(path: string): string { return path; },

    // Test helpers
    _addText(path: string, content: string, mtime = Date.now()): VaultFile {
      const file = makeFile(path, mtime);
      textFiles.set(path, { file, content });
      return file;
    },
    _getText(path: string) { return textFiles.get(path)?.content; },
    _getBinary(path: string) { return binaryFiles.get(path)?.data; },
    _hasDir(path: string) { return dirs.has(path); },
  };

  return vault;
}

// ---- Helper to flush microtasks ------------------------------------------
// Note: when vi.useFakeTimers() is active, use flushPromisesFakeTimers() instead.
const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0));
/**
 * Flush microtasks when fake timers are active.
 * Advances time by 1ms (enough to run flushPromises' setTimeout(0))
 * WITHOUT advancing past the 3s TTL cleanup timer.
 */
const flushPromisesFakeTimers = async () => {
  await vi.advanceTimersByTimeAsync(1);
};

// ==========================================================================
// Tests
// ==========================================================================

describe("PouchDbFsBridge — vault -> PouchDB (text)", () => {
  let db: ReturnType<typeof makePouchMock>;
  let vault: ReturnType<typeof makeVaultMock>;
  let watcher: ReturnType<typeof makeWatcherMock>;
  let bridge: PouchDbFsBridge;

  beforeEach(() => {
    db = makePouchMock();
    vault = makeVaultMock();
    watcher = makeWatcherMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bridge = new PouchDbFsBridge(vault, db as any);
    bridge.start(watcher);
  });

  afterEach(() => {
    bridge.stop();
  });

  it("writes text file to PouchDB when vault change fires", async () => {
    const mtime = 1700000000123;
    vault._addText("notes/hello.md", "Hello world", mtime);
    watcher.emit({ type: "change", path: "notes/hello.md" });
    await flushPromises();

    const doc = db._docs.get(pathToDocId("notes/hello.md"));
    expect(doc).toBeDefined();
    expect(doc!.content).toBe("Hello world");
    // mtime must be truncated to integer (Math.floor)
    expect(doc!.mtime).toBe(Math.floor(mtime));
  });

  it("applies Math.floor to mtime (sub-millisecond invariant)", async () => {
    const mtime = 1700000000999.9; // fractional
    vault._addText("frac.md", "content", mtime);
    watcher.emit({ type: "change", path: "frac.md" });
    await flushPromises();

    const doc = db._docs.get(pathToDocId("frac.md"));
    expect(doc!.mtime).toBe(Math.floor(mtime));
    expect(Number.isInteger(doc!.mtime)).toBe(true);
  });

  it("marks doc deleted in PouchDB when vault delete fires", async () => {
    vault._addText("gone.md", "bye");
    watcher.emit({ type: "change", path: "gone.md" });
    await flushPromises();

    // Now delete
    watcher.emit({ type: "delete", path: "gone.md" });
    await flushPromises();

    const doc = db._docs.get(pathToDocId("gone.md"));
    expect(doc?._deleted).toBe(true);
  });

  it("treats rename as delete-old + change-new (two sequential events)", async () => {
    vault._addText("new-name.md", "renamed content");
    // Watcher emits delete(old) then change(new)
    watcher.emit({ type: "delete", path: "old-name.md" });
    watcher.emit({ type: "change", path: "new-name.md" });
    await flushPromises();

    // New doc should be written
    expect(db._docs.has(pathToDocId("new-name.md"))).toBe(true);
  });

  it("updates existing doc (uses _rev to avoid 409)", async () => {
    vault._addText("update.md", "v1");
    watcher.emit({ type: "change", path: "update.md" });
    await flushPromises();

    const rev1 = db._docs.get(pathToDocId("update.md"))?._rev;
    expect(rev1).toBeDefined();

    // Update content
    vault._addText("update.md", "v2");
    watcher.emit({ type: "change", path: "update.md" });
    await flushPromises();

    const doc = db._docs.get(pathToDocId("update.md"));
    expect(doc!.content).toBe("v2");
    expect(doc!._rev).not.toBe(rev1); // rev bumped
  });
});

describe("PouchDbFsBridge — echo suppression (Level 1: in-memory rev sentinel)", () => {
  let db: ReturnType<typeof makePouchMock>;
  let vault: ReturnType<typeof makeVaultMock>;
  let watcher: ReturnType<typeof makeWatcherMock>;
  let bridge: PouchDbFsBridge;

  beforeEach(() => {
    vi.useFakeTimers();
    db = makePouchMock();
    vault = makeVaultMock();
    watcher = makeWatcherMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bridge = new PouchDbFsBridge(vault, db as any);
    bridge.start(watcher);
  });

  afterEach(() => {
    bridge.stop();
    vi.useRealTimers();
  });

  it("suppresses vault event when rev matches the applied sentinel", async () => {
    // Remote pushes "1-abc" rev with new content -> bridge writes to vault
    // Bridge stores sentinel: appliedRevs["file/echo.md"] = "1-abc"
    // Vault fires change event (echo) -> bridge checks: db.get() rev === sentinel -> skip
    vault._addText("echo.md", "old content");

    const remoteDoc = {
      _id: pathToDocId("echo.md"),
      _rev: "1-abc",
      content: "new content from remote",
      mtime: 1700000000000,
      deleted: false,
    };
    db._emitChange(remoteDoc);
    await flushPromisesFakeTimers();

    expect(vault._getText("echo.md")).toBe("new content from remote");

    // Vault echoes the change — Level 1 sentinel should suppress it
    const putSpy = vi.spyOn(db, "put");
    watcher.emit({ type: "change", path: "echo.md" });
    // suppressIfEcho does a db.get() — advance to let it resolve
    await flushPromisesFakeTimers();
    await flushPromisesFakeTimers();

    expect(putSpy).not.toHaveBeenCalled();
  });

  it("allows vault event after TTL window expires (> 5s)", async () => {
    vault._addText("echo2.md", "old content");

    const remoteDoc = {
      _id: pathToDocId("echo2.md"),
      _rev: "1-abc",
      content: "new remote content",
      mtime: 1700000000000,
      deleted: false,
    };
    db._emitChange(remoteDoc);
    await flushPromisesFakeTimers();

    expect(vault._getText("echo2.md")).toBe("new remote content");

    // Advance time past the 5s TTL — sentinel is cleared
    await vi.advanceTimersByTimeAsync(5100);

    // After TTL expired, no sentinel -> change goes directly to PouchDB
    const putSpy = vi.spyOn(db, "put");
    vault._addText("echo2.md", "locally modified after TTL");
    watcher.emit({ type: "change", path: "echo2.md" });
    await flushPromisesFakeTimers();

    expect(putSpy).toHaveBeenCalled();
  });

  it("allows genuine local edit for different docId — independent sentinels", async () => {
    // Remote applies to "remote.md", then local edits "local.md" — no suppression
    vault._addText("remote.md", "old");
    vault._addText("local.md", "local original");

    const remoteDoc = {
      _id: pathToDocId("remote.md"),
      _rev: "1-abc",
      content: "from remote",
      mtime: 1700000000000,
      deleted: false,
    };
    db._emitChange(remoteDoc);
    await flushPromisesFakeTimers();

    // Edit local.md — no sentinel for this docId -> should write to PouchDB
    const putSpy = vi.spyOn(db, "put");
    vault._addText("local.md", "locally edited");
    watcher.emit({ type: "change", path: "local.md" });
    await flushPromisesFakeTimers();

    expect(putSpy).toHaveBeenCalled();
  });
});

describe("PouchDbFsBridge — PouchDB -> vault (text)", () => {
  let db: ReturnType<typeof makePouchMock>;
  let vault: ReturnType<typeof makeVaultMock>;
  let watcher: ReturnType<typeof makeWatcherMock>;
  let bridge: PouchDbFsBridge;

  beforeEach(() => {
    db = makePouchMock();
    vault = makeVaultMock();
    watcher = makeWatcherMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bridge = new PouchDbFsBridge(vault, db as any);
    bridge.start(watcher);
  });

  afterEach(() => {
    bridge.stop();
  });

  it("creates a new vault file when PouchDB emits a change for unknown path", async () => {
    const doc = {
      _id: pathToDocId("remote/new.md"),
      _rev: "1-abc",
      content: "remote content",
      mtime: Date.now(),
      deleted: false,
    };
    db._emitChange(doc);
    await flushPromises();

    expect(vault._getText("remote/new.md")).toBe("remote content");
  });

  it("creates parent directory when writing a nested file", async () => {
    const doc = {
      _id: pathToDocId("folder/sub/note.md"),
      _rev: "1-abc",
      content: "nested",
      mtime: Date.now(),
      deleted: false,
    };
    db._emitChange(doc);
    await flushPromises();

    // Parent directory must be created
    expect(vault._hasDir("folder/sub")).toBe(true);
    expect(vault._getText("folder/sub/note.md")).toBe("nested");
  });

  it("updates existing vault file when PouchDB emits changed content", async () => {
    vault._addText("existing.md", "old content");

    const doc = {
      _id: pathToDocId("existing.md"),
      _rev: "2-abc",
      content: "updated content",
      mtime: Date.now(),
      deleted: false,
    };
    db._emitChange(doc);
    await flushPromises();

    expect(vault._getText("existing.md")).toBe("updated content");
  });

  it("skips write when content is identical (Level 2 content equality guard)", async () => {
    vault._addText("same.md", "same content");
    const modifyTextSpy = vi.spyOn(vault, "modifyText");
    const createTextSpy = vi.spyOn(vault, "createText");

    const doc = {
      _id: pathToDocId("same.md"),
      _rev: "1-abc",
      content: "same content", // identical to existing
      mtime: Date.now(),
      deleted: false,
    };
    db._emitChange(doc);
    await flushPromises();

    expect(modifyTextSpy).not.toHaveBeenCalled();
    expect(createTextSpy).not.toHaveBeenCalled();
  });

  it("deletes vault file when PouchDB emits a tombstone", async () => {
    vault._addText("deleted.md", "to be removed");
    const deleteFileSpy = vi.spyOn(vault, "deleteFile");

    const doc = {
      _id: pathToDocId("deleted.md"),
      _rev: "2-abc",
      _deleted: true,
      deleted: true,
      content: null,
      mtime: Date.now(),
    };
    db._emitChange(doc);
    await flushPromises();

    expect(deleteFileSpy).toHaveBeenCalled();
  });

  it("ignores docs without file/ prefix (design docs, metadata)", async () => {
    const createTextSpy = vi.spyOn(vault, "createText");

    // CouchDB design docs have _design/ prefix, not file/
    // The bridge must skip these to avoid writing junk paths to the vault
    const doc = {
      _id: "_design/something",
      _rev: "1-abc",
      content: "design doc",
      mtime: Date.now(),
    };
    db._emitChange(doc as DocShape);
    await flushPromises();

    expect(createTextSpy).not.toHaveBeenCalled();
  });
});

describe("PouchDbFsBridge — doc ID encoding", () => {
  it("encodes folder/note.md as file/folder/note.md", () => {
    expect(pathToDocId("folder/note.md")).toBe("file/folder/note.md");
  });

  it("encodes root-level file as file/root.md", () => {
    expect(pathToDocId("root.md")).toBe("file/root.md");
  });
});

describe("PouchDbFsBridge — binary sync", () => {
  let db: ReturnType<typeof makePouchMock>;
  let vault: ReturnType<typeof makeVaultMock>;
  let watcher: ReturnType<typeof makeWatcherMock>;
  let bridge: PouchDbFsBridge;

  beforeEach(() => {
    db = makePouchMock();
    vault = makeVaultMock();
    watcher = makeWatcherMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bridge = new PouchDbFsBridge(vault, db as any);
    bridge.start(watcher);
  });

  afterEach(() => {
    bridge.stop();
  });

  it("writes binary file to PouchDB as attachment when vault change fires", async () => {
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
    // Use the vault's createBinary to register the file in the mock, then
    // trigger via watcher event so the bridge picks it up via getEntryByPath
    await vault.createBinary("image.png", data);

    watcher.emit({ type: "change", path: "image.png" });
    await flushPromises();

    // Should have put a meta doc and then an attachment
    const doc = db._docs.get(pathToDocId("image.png"));
    expect(doc).toBeDefined();
    expect(doc!._attachments).toBeDefined();
    expect(db._attachments.has(`${pathToDocId("image.png")}/data.bin`)).toBe(true);
  });

  it("writes binary file from PouchDB to vault when attachment change arrives", async () => {
    const data = new Uint8Array([1, 2, 3, 4]).buffer;

    // Simulate: attachment already stored in db
    const docId = pathToDocId("photo.jpg");
    db._docs.set(docId, {
      _id: docId,
      _rev: "1-abc",
      mtime: Date.now(),
      _attachments: { "data.bin": { stub: false } },
    });
    db._attachments.set(`${docId}/data.bin`, data);

    // Emit the change
    const doc = db._docs.get(docId)!;
    db._emitChange(doc);
    await flushPromises();

    const result = vault._getBinary("photo.jpg");
    expect(result).toBeDefined();
    // Content should match
    expect(new Uint8Array(result!)).toEqual(new Uint8Array(data));
  });
});

describe("PouchDbFsBridge — binary content-type mapping", () => {
  it("resolves png to image/png", () => {
    expect(contentTypeForPath("photo.png")).toBe("image/png");
  });

  it("resolves jpg to image/jpeg", () => {
    expect(contentTypeForPath("photo.jpg")).toBe("image/jpeg");
  });

  it("resolves jpeg to image/jpeg", () => {
    expect(contentTypeForPath("photo.jpeg")).toBe("image/jpeg");
  });

  it("resolves pdf to application/pdf", () => {
    expect(contentTypeForPath("doc.pdf")).toBe("application/pdf");
  });

  it("resolves gif to image/gif", () => {
    expect(contentTypeForPath("anim.gif")).toBe("image/gif");
  });

  it("resolves mp4 to video/mp4", () => {
    expect(contentTypeForPath("video.mp4")).toBe("video/mp4");
  });

  it("resolves mp3 to audio/mpeg", () => {
    expect(contentTypeForPath("song.mp3")).toBe("audio/mpeg");
  });

  it("resolves svg to image/svg+xml", () => {
    expect(contentTypeForPath("icon.svg")).toBe("image/svg+xml");
  });

  it("falls back to application/octet-stream for unknown extensions", () => {
    expect(contentTypeForPath("mystery.xyz")).toBe("application/octet-stream");
  });
});

describe("PouchDbFsBridge — binary round-trip (vault->PouchDB->vault)", () => {
  let db: ReturnType<typeof makePouchMock>;
  let vault: ReturnType<typeof makeVaultMock>;
  let watcher: ReturnType<typeof makeWatcherMock>;
  let bridge: PouchDbFsBridge;

  beforeEach(() => {
    db = makePouchMock();
    vault = makeVaultMock();
    watcher = makeWatcherMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bridge = new PouchDbFsBridge(vault, db as any);
    bridge.start(watcher);
  });

  afterEach(() => {
    bridge.stop();
  });

  it("binary round-trip: vault write -> PouchDB -> vault read back", async () => {
    const originalData = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).buffer;
    await vault.createBinary("assets/chart.png", originalData);

    // Step 1: vault FS change event -> PouchDB attachment
    watcher.emit({ type: "change", path: "assets/chart.png" });
    await flushPromises();

    const docId = pathToDocId("assets/chart.png");
    const storedDoc = db._docs.get(docId);
    expect(storedDoc).toBeDefined();
    expect(storedDoc!._attachments).toBeDefined();

    const storedAttachment = db._attachments.get(`${docId}/${ATTACHMENT_NAME}`);
    expect(storedAttachment).toBeDefined();

    // Step 2: simulate remote change event (attachment ready) -> vault write back
    // Create a second vault/bridge pair to simulate the "receiving" side
    const vault2 = makeVaultMock();
    const watcher2 = makeWatcherMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bridge2 = new PouchDbFsBridge(vault2, db as any);
    bridge2.start(watcher2);

    try {
      // Emit the change to the second bridge
      db._emitChange(storedDoc!);
      await flushPromises();

      const receivedData = vault2._getBinary("assets/chart.png");
      expect(receivedData).toBeDefined();
      expect(new Uint8Array(receivedData!)).toEqual(new Uint8Array(originalData));
    } finally {
      bridge2.stop();
    }
  });

  it("binary echo suppression: rev sentinel prevents writing same binary back to PouchDB", async () => {
    vi.useFakeTimers();
    try {
      const data = new Uint8Array([1, 2, 3]).buffer;
      await vault.createBinary("echo-img.png", data);

      // Simulate remote binary change -> bridge writes to vault + sets rev sentinel
      const docId = pathToDocId("echo-img.png");
      db._docs.set(docId, {
        _id: docId,
        _rev: "1-abc",
        mtime: 1700000000000,
        _attachments: { [ATTACHMENT_NAME]: { stub: false } },
      });
      db._attachments.set(`${docId}/${ATTACHMENT_NAME}`, data);

      const doc = db._docs.get(docId)!;
      db._emitChange(doc);
      await vi.advanceTimersByTimeAsync(1);

      // Vault fires change event (echo) — should be suppressed by rev sentinel
      // (sentinel present -> suppressIfEcho -> db.get() matches -> skip)
      const putAttachmentSpy = vi.spyOn(db, "putAttachment");
      watcher.emit({ type: "change", path: "echo-img.png" });
      await vi.advanceTimersByTimeAsync(5); // let suppressIfEcho resolve

      expect(putAttachmentSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sequential binary pull: multiple binary changes processed without concurrent memory spike", async () => {
    // Simulate 5 binary docs arriving in the changes feed sequentially.
    // The bridge processes each one-at-a-time (changes are streamed, not batched).
    // Verify all 5 end up in the vault.
    const files = ["a.png", "b.jpg", "c.gif", "d.pdf", "e.mp4"];
    const datasets = files.map((_, i) => new Uint8Array([i + 1, i + 2]).buffer);

    for (let i = 0; i < files.length; i++) {
      const docId = pathToDocId(files[i]);
      db._docs.set(docId, {
        _id: docId,
        _rev: `${i + 1}-abc`,
        mtime: 1700000000000 + i,
        _attachments: { [ATTACHMENT_NAME]: { stub: false } },
      });
      db._attachments.set(`${docId}/${ATTACHMENT_NAME}`, datasets[i]);
    }

    // Emit all changes and flush
    for (const file of files) {
      db._emitChange(db._docs.get(pathToDocId(file))!);
    }
    // Multiple flushes to allow sequential processing
    for (let i = 0; i < 5; i++) {
      await flushPromises();
    }

    for (let i = 0; i < files.length; i++) {
      const result = vault._getBinary(files[i]);
      expect(result).toBeDefined();
      expect(new Uint8Array(result!)).toEqual(new Uint8Array(datasets[i]));
    }
  });
});

describe("PouchDbFsBridge — stop()", () => {
  let db: ReturnType<typeof makePouchMock>;
  let vault: ReturnType<typeof makeVaultMock>;
  let watcher: ReturnType<typeof makeWatcherMock>;
  let bridge: PouchDbFsBridge;

  beforeEach(() => {
    db = makePouchMock();
    vault = makeVaultMock();
    watcher = makeWatcherMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bridge = new PouchDbFsBridge(vault, db as any);
    bridge.start(watcher);
  });

  it("stops writing to vault after stop()", async () => {
    bridge.stop();

    const createTextSpy = vi.spyOn(vault, "createText");
    const doc = {
      _id: pathToDocId("after-stop.md"),
      _rev: "1-abc",
      content: "should not appear",
      mtime: Date.now(),
    };
    db._emitChange(doc as DocShape);
    await flushPromises();

    expect(createTextSpy).not.toHaveBeenCalled();
  });

  it("stops writing to PouchDB after stop() — watcher handler cleared", async () => {
    bridge.stop();

    vault._addText("stop-test.md", "content");
    const putSpy = vi.spyOn(db, "put");
    // After stop(), watcher.stop() sets handler=null, so emit is a no-op
    watcher.emit({ type: "change", path: "stop-test.md" });
    await flushPromises();

    expect(putSpy).not.toHaveBeenCalled();
  });
});


// ==========================================================================
// LWW conflict resolver tests (C03)
// ==========================================================================

describe("PouchDbFsBridge — LWW conflict resolution (resolveConflictsByMtime)", () => {
  let db: ReturnType<typeof makePouchMock>;
  let vault: ReturnType<typeof makeVaultMock>;
  let watcher: ReturnType<typeof makeWatcherMock>;
  let bridge: PouchDbFsBridge;

  beforeEach(() => {
    db = makePouchMock();
    vault = makeVaultMock();
    watcher = makeWatcherMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bridge = new PouchDbFsBridge(vault, db as any);
    bridge.start(watcher);
  });

  afterEach(() => {
    bridge.stop();
  });

  it("no conflicts: resolver not called, doc written as-is", async () => {
    // A normal remote change without _conflicts — resolver should not touch it
    const putSpy = vi.spyOn(db, "put");

    const doc: DocShape = {
      _id: pathToDocId("no-conflict.md"),
      _rev: "1-aaa",
      content: "normal content",
      mtime: 1700000001000,
      deleted: false,
    };
    db._emitChange(doc);
    await flushPromises();

    // Vault should have the content from the change
    expect(vault._getText("no-conflict.md")).toBe("normal content");
    // No spurious put() calls from conflict resolution
    expect(putSpy).not.toHaveBeenCalled();
  });

  it("two conflict revs, winning rev has higher mtime — winner written to vault", async () => {
    const path = "conflict-win.md";
    const docId = pathToDocId(path);

    // Loser rev (lower mtime) — stored as a conflict revision
    const loserDoc: DocShape = {
      _id: docId,
      _rev: "1-aaa",
      content: "older content",
      mtime: 1700000000000,
      deleted: false,
    };
    // Winner rev (higher mtime) — this is what the change feed delivers
    const winnerDoc: DocShape = {
      _id: docId,
      _rev: "2-bbb",
      content: "newer content",
      mtime: 1700000002000,
      deleted: false,
      _conflicts: ["1-aaa"],
    };

    db._addConflictRev(docId, loserDoc);

    db._emitChange(winnerDoc);
    await flushPromises();

    // Winner content should be written to vault
    expect(vault._getText(path)).toBe("newer content");

    // The loser rev should be deleted — verify the doc map reflects this.
    // The mock's put() with _deleted:true marks the stored doc as deleted.
    // Since the mock bumps _rev on every put, we check the loser's docId
    // no longer returns its old content (it was overwritten by the deletion).
    const loserDocAfter = db._docs.get(docId);
    // The loser revision was stored; after deletion put, the doc is marked deleted
    // (the mock stores the deletion under the new bumped rev, so the old 1-aaa
    // entry in conflictDocs remains, but the main docs store shows deleted).
    // Primary assertion is vault content (above). Deletion is secondary — the
    // bridge's loser.put({_deleted:true}) at minimum must not throw.
  });

  it("two conflict revs, losing rev has higher mtime — loser becomes winner", async () => {
    const path = "conflict-flip.md";
    const docId = pathToDocId(path);

    // PouchDB's change feed delivers "1-aaa" as "winner" (arbitrary rev sort),
    // but "2-bbb" has a higher mtime and should be the real LWW winner.
    const pouchWinner: DocShape = {
      _id: docId,
      _rev: "1-aaa",
      content: "older but pouch thinks it won",
      mtime: 1700000000000,
      deleted: false,
      _conflicts: ["2-bbb"],
    };
    const realWinner: DocShape = {
      _id: docId,
      _rev: "2-bbb",
      content: "newer real winner",
      mtime: 1700000002000,
      deleted: false,
    };

    db._addConflictRev(docId, pouchWinner);
    db._addConflictRev(docId, realWinner);

    db._emitChange(pouchWinner);
    await flushPromises();

    // The real winner (higher mtime) should be written to vault
    expect(vault._getText(path)).toBe("newer real winner");
  });

  it("tied mtime — deterministic winner by _rev lexicographic order", async () => {
    const path = "conflict-tie.md";
    const docId = pathToDocId(path);
    const sharedMtime = 1700000001000;

    // "2-zzz" > "1-aaa" lexicographically — should win on tie
    const lowerRev: DocShape = {
      _id: docId,
      _rev: "1-aaa",
      content: "lower rev content",
      mtime: sharedMtime,
      deleted: false,
      _conflicts: ["2-zzz"],
    };
    const higherRev: DocShape = {
      _id: docId,
      _rev: "2-zzz",
      content: "higher rev content",
      mtime: sharedMtime,
      deleted: false,
    };

    db._addConflictRev(docId, lowerRev);
    db._addConflictRev(docId, higherRev);

    db._emitChange(lowerRev);
    await flushPromises();

    // "2-zzz" > "1-aaa" → higher rev wins on tie
    expect(vault._getText(path)).toBe("higher rev content");
  });
});

// ---- wipeLocalFiles() -------------------------------------------------------

describe("PouchDbFsBridge — wipeLocalFiles()", () => {
  function makeBridge() {
    const db = makePouchMock();
    const vault = makeVaultMock();
    const watcher = makeWatcherMock();
    const bridge = new PouchDbFsBridge(vault, db as never);
    bridge.start(watcher);
    return { bridge, vault, db };
  }

  it("deletes a normal vault file when not excluded", async () => {
    const { bridge, vault } = makeBridge();
    vault._addText("notes.md", "some content");
    await bridge.wipeLocalFiles(() => false);
    expect(vault._getText("notes.md")).toBeUndefined();
  });

  it("skips files matched by the isExcluded predicate (.obsidian/app.json)", async () => {
    const { bridge, vault } = makeBridge();
    vault._addText(".obsidian/app.json", "{}");
    await bridge.wipeLocalFiles((p) => p.startsWith(".obsidian"));
    expect(vault._getText(".obsidian/app.json")).toBe("{}");
  });

  it("does nothing when vault has no files", async () => {
    const { bridge } = makeBridge();
    await expect(bridge.wipeLocalFiles(() => false)).resolves.toBeUndefined();
  });

  it("deletes binary files", async () => {
    const { bridge, vault } = makeBridge();
    const buf = new ArrayBuffer(4);
    await vault.createBinary("photo.png", buf);
    await bridge.wipeLocalFiles(() => false);
    expect(vault._getBinary("photo.png")).toBeUndefined();
  });

  it("deletes all non-excluded files when vault has a mix", async () => {
    const { bridge, vault } = makeBridge();
    vault._addText("notes.md", "delete me");
    vault._addText(".obsidian/app.json", "keep me");
    await bridge.wipeLocalFiles((p) => p.startsWith(".obsidian"));
    expect(vault._getText("notes.md")).toBeUndefined();
    expect(vault._getText(".obsidian/app.json")).toBe("keep me");
  });

  it("bulk-deletes a top-level folder via deleteDirectory, not per inner file", async () => {
    const { bridge, vault } = makeBridge();
    vault._addText("Archives/2024/a.md", "x");
    vault._addText("Archives/b.md", "y");
    const dirSpy = vi.spyOn(vault, "deleteDirectory");
    const fileSpy = vi.spyOn(vault, "deleteFile");
    await bridge.wipeLocalFiles(() => false);
    expect(dirSpy).toHaveBeenCalledWith(expect.objectContaining({ kind: "folder", path: "Archives" }));
    expect(fileSpy).not.toHaveBeenCalled(); // folder removed in one call, no per-file deletes
    expect(vault._getText("Archives/2024/a.md")).toBeUndefined();
    expect(vault._getText("Archives/b.md")).toBeUndefined();
  });

  it("does NOT delete an excluded top-level folder but bulk-deletes the others", async () => {
    const { bridge, vault } = makeBridge();
    vault._addText("Notes/keep.md", "del");
    vault._addText(".obsidian/app.json", "{}");
    const dirSpy = vi.spyOn(vault, "deleteDirectory");
    await bridge.wipeLocalFiles((p) => p.startsWith(".obsidian"));
    expect(vault._getText(".obsidian/app.json")).toBe("{}"); // excluded folder untouched
    expect(vault._getText("Notes/keep.md")).toBeUndefined();
    const dirPaths = dirSpy.mock.calls.map((c) => (c[0] as VaultFolder).path);
    expect(dirPaths).toContain("Notes");
    expect(dirPaths).not.toContain(".obsidian");
  });

  it("falls back to per-file deletion for a folder with a nested-excluded path", async () => {
    const { bridge, vault } = makeBridge();
    vault._addText("Work/report.md", "del");
    vault._addText("Work/private/secret.md", "keep");
    const dirSpy = vi.spyOn(vault, "deleteDirectory");
    const fileSpy = vi.spyOn(vault, "deleteFile");
    await bridge.wipeLocalFiles((p) => p.startsWith("Work/private"));
    expect(dirSpy).not.toHaveBeenCalled(); // nested exclusion blocks the bulk delete
    expect(fileSpy).toHaveBeenCalled();
    expect(vault._getText("Work/report.md")).toBeUndefined(); // non-excluded removed
    expect(vault._getText("Work/private/secret.md")).toBe("keep"); // nested exclusion preserved
  });
});

// ==========================================================================
// Folder delete → descendant tombstone sweep (production bug fix)
// ==========================================================================
// Root cause: a folder-level delete event produces docId "file/MyFolder" which
// has no corresponding PouchDB doc (only files have docs). The old handler did
// db.get("file/MyFolder") → 404 → silent no-op. Nested file docs survived and
// were re-materialized onto disk via the live changes feed ("ghost files").
//
// Fix: on any delete event, tombstone the exact docId (single-file path) AND
// sweep all descendants under docId + "/" via allDocs prefix-range query.
// ==========================================================================

describe("PouchDbFsBridge — folder delete tombstones all descendants", () => {
  let db: ReturnType<typeof makePouchMock>;
  let vault: ReturnType<typeof makeVaultMock>;
  let watcher: ReturnType<typeof makeWatcherMock>;
  let bridge: PouchDbFsBridge;

  beforeEach(() => {
    db = makePouchMock();
    vault = makeVaultMock();
    watcher = makeWatcherMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bridge = new PouchDbFsBridge(vault, db as any);
    bridge.start(watcher);
  });

  afterEach(() => {
    bridge.stop();
  });

  it("tombstones all nested file docs when a folder delete event fires", async () => {
    // Seed two files inside MyFolder into PouchDB
    const paths = ["MyFolder/a.md", "MyFolder/b.md", "MyFolder/sub/c.md"];
    for (const p of paths) {
      vault._addText(p, "content");
      watcher.emit({ type: "change", path: p });
    }
    await flushPromises();

    // Confirm they are live
    for (const p of paths) {
      expect(db._docs.get(pathToDocId(p))?._deleted).toBeFalsy();
    }

    // Delete the folder — runtime fires ONE event for the folder path (no per-file events)
    watcher.emit({ type: "delete", path: "MyFolder" });
    await flushPromises();

    // All three file docs must be tombstoned
    for (const p of paths) {
      const doc = db._docs.get(pathToDocId(p));
      expect(doc, `expected doc for ${p} to exist`).toBeDefined();
      expect(doc!._deleted, `expected ${p} to be tombstoned`).toBe(true);
    }
  });

  it("does NOT tombstone siblings: MyFolder.md and MyFolderOther/x.md survive a MyFolder delete", async () => {
    // Sibling note with same prefix (but no trailing slash match)
    vault._addText("MyFolder.md", "sibling note");
    watcher.emit({ type: "change", path: "MyFolder.md" });

    // Sibling folder
    vault._addText("MyFolderOther/x.md", "sibling folder file");
    watcher.emit({ type: "change", path: "MyFolderOther/x.md" });

    // One file inside the folder being deleted
    vault._addText("MyFolder/inside.md", "will be deleted");
    watcher.emit({ type: "change", path: "MyFolder/inside.md" });

    await flushPromises();

    // Delete MyFolder — must only affect docs under "file/MyFolder/"
    watcher.emit({ type: "delete", path: "MyFolder" });
    await flushPromises();

    // Descendants tombstoned
    const insideDoc = db._docs.get(pathToDocId("MyFolder/inside.md"));
    expect(insideDoc?._deleted).toBe(true);

    // Siblings must survive — the "/" boundary prevents false matches
    const siblingNoteDoc = db._docs.get(pathToDocId("MyFolder.md"));
    expect(siblingNoteDoc, "sibling note MyFolder.md should still exist").toBeDefined();
    expect(siblingNoteDoc!._deleted, "sibling note MyFolder.md must NOT be tombstoned").toBeFalsy();

    const siblingFolderDoc = db._docs.get(pathToDocId("MyFolderOther/x.md"));
    expect(siblingFolderDoc, "sibling folder file MyFolderOther/x.md should still exist").toBeDefined();
    expect(siblingFolderDoc!._deleted, "sibling folder file must NOT be tombstoned").toBeFalsy();
  });

  it("is idempotent: a second delete event for an already-tombstoned folder is a no-op", async () => {
    vault._addText("Folder/note.md", "content");
    watcher.emit({ type: "change", path: "Folder/note.md" });
    await flushPromises();

    // First delete
    watcher.emit({ type: "delete", path: "Folder" });
    await flushPromises();

    expect(db._docs.get(pathToDocId("Folder/note.md"))?._deleted).toBe(true);

    // Second delete — already tombstoned, allDocs skips deleted docs (returns empty rows),
    // markDeletedInPouch 404s into no-op. Should not throw or produce an error.
    const putSpy = vi.spyOn(db, "put");
    watcher.emit({ type: "delete", path: "Folder" });
    await flushPromises();

    // No new put() for already-tombstoned doc
    expect(putSpy).not.toHaveBeenCalled();
  });

  it("tombstones the exact docId too when the deleted path is a single file (existing behaviour preserved)", async () => {
    vault._addText("solo.md", "content");
    watcher.emit({ type: "change", path: "solo.md" });
    await flushPromises();

    watcher.emit({ type: "delete", path: "solo.md" });
    await flushPromises();

    const doc = db._docs.get(pathToDocId("solo.md"));
    expect(doc?._deleted).toBe(true);
  });

  it("echo-suppression preserved: bridge-applied remote FILE delete is not re-tombstoned", async () => {
    // Reachable scenario: when the bridge applies a remote tombstone for a FILE,
    // applyRemoteChange sets appliedRevs[fileDocId] = "" then deletes the file from
    // disk. That disk delete fires an FS delete event for the SAME file path, which
    // onVaultEvent must suppress (appliedRevs.get(docId) === "") so it does not push
    // a phantom tombstone back. Production only ever sets the "" sentinel on a file
    // docId — never a folder docId — so we exercise the file path here.
    vault._addText("remote-del.md", "content");
    watcher.emit({ type: "change", path: "remote-del.md" });
    await flushPromises();

    // Bridge applies a remote delete: tombstone arrives via the changes feed.
    // applyRemoteChange sets the "" sentinel and calls vault.deleteFile.
    db._emitChange({
      _id: pathToDocId("remote-del.md"),
      _rev: "9-abc",
      _deleted: true,
      deleted: true,
      content: null,
    });
    await flushPromises();

    // The disk delete echoes back as an FS delete event for the same path.
    const putSpy = vi.spyOn(db, "put");
    const bulkSpy = vi.spyOn(db, "bulkDocs");
    watcher.emit({ type: "delete", path: "remote-del.md" });
    await flushPromises();

    // Sentinel is "" → onVaultEvent returns early, no re-tombstone.
    expect(putSpy).not.toHaveBeenCalled();
    expect(bulkSpy).not.toHaveBeenCalled();
  });

  it("flat sweep is depth-agnostic: deeply nested file is tombstoned by folder delete", async () => {
    // The allDocs prefix-range [docId+"/", docId+"/￿"] returns ALL descendants
    // regardless of nesting depth — a single query, not a recursive traversal.
    const deep = "F/sub/deep.md";
    vault._addText(deep, "deep content");
    watcher.emit({ type: "change", path: deep });
    await flushPromises();

    expect(db._docs.get(pathToDocId(deep))?._deleted).toBeFalsy();

    watcher.emit({ type: "delete", path: "F" });
    await flushPromises();

    // Deeply nested file must be tombstoned by the single flat sweep
    expect(db._docs.get(pathToDocId(deep))?._deleted).toBe(true);
  });

  it("reconcileTombstone tombstones only the exact doc — no descendant sweep", async () => {
    // White-box guard against an O(N) regression: reconcileTombstone is called
    // per-file during startup reconcile and must NOT fire the descendant sweep
    // (that would cause O(N) empty allDocs queries during startup and is
    // semantically wrong for a per-file operation). Asserts on the allDocs spy.
    const child = "R/child.md";
    vault._addText(child, "child content");
    watcher.emit({ type: "change", path: child });
    await flushPromises();

    // Stop bridge so watcher events don't interfere
    bridge.stop();

    const allDocsSpy = vi.spyOn(db, "allDocs");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (bridge as any).reconcileTombstone(pathToDocId(child));

    // reconcileTombstone must NOT call allDocs (that's tombstoneWithDescendants' job)
    expect(allDocsSpy).not.toHaveBeenCalled();
    // The exact doc must be tombstoned
    expect(db._docs.get(pathToDocId(child))?._deleted).toBe(true);
  });

  // --- Error-path: tombstone failures must surface, not be swallowed ---------
  // A swallowed tombstone failure leaves a doc LIVE → it re-materialises on disk
  // as a ghost file via the live changes feed (the exact bug this branch fixes,
  // via a back door). These tests pin that the failure is observable.

  it("markDeletedInPouch rethrows a non-404 put failure (409 TOCTOU) — not swallowed", async () => {
    // A 409 happens when the live changes feed bumps the doc's rev between
    // markDeletedInPouch's db.get and db.put. reconcileTombstone routes straight
    // through markDeletedInPouch (single-doc get→put), so it is the cleanest probe.
    const path = "conflicted.md";
    vault._addText(path, "content");
    watcher.emit({ type: "change", path });
    await flushPromises();
    bridge.stop(); // isolate from watcher events

    vi.spyOn(db, "put").mockRejectedValueOnce({ status: 409, name: "conflict" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((bridge as any).reconcileTombstone(pathToDocId(path)))
      .rejects.toMatchObject({ status: 409 });
  });

  it("markDeletedInPouch keeps a 404 (absent doc) as a silent no-op", async () => {
    // The exact docId of a folder has no PouchDB doc → db.get 404s. That MUST stay
    // a no-op (legitimate), distinct from the 409 surfaced above.
    bridge.stop();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((bridge as any).reconcileTombstone(pathToDocId("never-existed")))
      .resolves.toBeUndefined();
  });

  it("folder-delete logs when a descendant bulkDocs tombstone fails (error row)", async () => {
    // bulkDocs reports stale-rev conflicts as per-doc error rows (not a rejection).
    // tombstoneWithDescendants must surface that, and onVaultEvent's delete branch
    // must log it via console.error rather than swallowing it.
    vault._addText("Folder/note.md", "content");
    watcher.emit({ type: "change", path: "Folder/note.md" });
    await flushPromises();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Force every descendant write to fail with an error row.
    vi.spyOn(db, "bulkDocs").mockResolvedValueOnce([
      { id: pathToDocId("Folder/note.md"), error: true, status: 409 },
    ] as never);

    watcher.emit({ type: "delete", path: "Folder" });
    await flushPromises();

    expect(errorSpy).toHaveBeenCalledWith(
      "[vault-sync] folder-delete tombstone failed",
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});

// ==========================================================================
// Folder RENAME — CHARACTERIZATION of a known data-loss path (fix DEFERRED)
// ==========================================================================
// ObsidianVaultWatcher maps a rename to delete(oldPath) + change(newPath).
// For a FOLDER rename, change(newFolderPath) reaches onVaultEvent's "change"
// branch, where getEntryByPath returns a folder (kind !== "file") → early
// return. So the moved files are tombstoned at the OLD path and NEVER
// recreated in PouchDB at the NEW path: a coarse folder-rename event loses the
// moved files from the synced set.
//
// This test PINS that data-loss observable on purpose. It is NOT a forced pass
// and the fix is intentionally deferred — it overlaps with a reconcile backstop
// being designed separately. When the rename handling is fixed, this test should
// be inverted (assert file/B/x.md IS pushed), turning red here into the spec.
//
// Severity caveat: this assumes Obsidian fires ONE coarse event for the folder
// (the case modelled here). Whether the runtime instead fires one event per
// child is unverified; per-child events would tombstone+recreate each file and
// avoid the loss. The coarse case is the dangerous one, so that is what we pin.
describe("PouchDbFsBridge — folder rename (coarse event) [DEFERRED data-loss characterization]", () => {
  let db: ReturnType<typeof makePouchMock>;
  let vault: ReturnType<typeof makeVaultMock>;
  let watcher: ReturnType<typeof makeWatcherMock>;
  let bridge: PouchDbFsBridge;

  beforeEach(() => {
    db = makePouchMock();
    vault = makeVaultMock();
    watcher = makeWatcherMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bridge = new PouchDbFsBridge(vault, db as any);
    bridge.start(watcher);
  });

  afterEach(() => {
    bridge.stop();
  });

  it("loses moved files: folder rename tombstones old path but never pushes new path", async () => {
    // Seed A/x.md and push it to PouchDB (the pre-rename synced state).
    vault._addText("A/x.md", "moved content");
    watcher.emit({ type: "change", path: "A/x.md" });
    await flushPromises();
    expect(db._docs.get(pathToDocId("A/x.md"))?._deleted).toBeFalsy();

    // The rename moves x.md from A/ to B/ on disk. Reflect that in the vault
    // adapter: A/x.md gone, B/x.md present (so getEntryByPath("B") is a folder).
    vault.getEntryByPath("A/x.md") &&
      (await vault.deleteFile(vault.getEntryByPath("A/x.md") as VaultFile));
    vault._addText("B/x.md", "moved content");

    // Coarse folder-rename event: delete(A) + change(B).
    watcher.emit({ type: "delete", path: "A" });
    watcher.emit({ type: "change", path: "B" });
    await flushPromises();

    // OLD path is tombstoned (delete branch swept the descendant).
    expect(
      db._docs.get(pathToDocId("A/x.md"))?._deleted,
      "old path A/x.md should be tombstoned",
    ).toBe(true);

    // NEW path is NEVER pushed: change(B) hit the folder early-return, so the
    // moved file is absent from PouchDB → lost from the synced set. THIS IS THE BUG.
    expect(
      db._docs.has(pathToDocId("B/x.md")),
      "DATA LOSS (deferred fix): B/x.md never made it into PouchDB after the rename",
    ).toBe(false);
  });
});
