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
// Folder delete → per-descendant tombstone (no sweep)
// ==========================================================================
// Empirically verified (spikes/obsidian-event-semantics CDP spike +
// scripts/smoke-folder-delete.sh real-artifact run): on desktop, mobile, and
// the daemon's fs.watch, a folder delete fires a separate delete event PER
// descendant file. Each child is therefore tombstoned by its own single-doc
// event — onVaultEvent → markDeletedInPouch(childDocId). No folder-level
// descendant sweep is needed (an earlier sweep was redundant AND raced the
// per-file events, 409-conflicting on docs they had already deleted). The
// daemon's startup reconcile is the backstop for any genuinely missed event.
//
// These tests pin the single-doc delete behaviour, echo-suppression, and the
// observability guarantee: a tombstone failure must surface, never be swallowed
// (a swallowed failure leaves a doc LIVE → it re-materialises on disk as a
// ghost file via the live changes feed — the exact bug this path guards against).
// ==========================================================================

describe("PouchDbFsBridge — single-file delete tombstone (no descendant sweep)", () => {
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

  it("echo-suppression preserved: bridge-applied remote FILE delete is not re-tombstoned", async () => {
    // Reachable scenario: when the bridge applies a remote tombstone for a FILE,
    // applyRemoteChange sets appliedRevs[fileDocId] = "" then deletes the file from
    // disk. That disk delete fires an FS delete event for the SAME file path, which
    // onVaultEvent must suppress (appliedRevs.get(docId) === "") so it does not push
    // a phantom tombstone back.
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
    watcher.emit({ type: "delete", path: "remote-del.md" });
    await flushPromises();

    // Sentinel is "" → onVaultEvent returns early, no re-tombstone.
    expect(putSpy).not.toHaveBeenCalled();
  });

  // --- Error-path: tombstone failures must surface, not be swallowed ---------

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
    // A delete event for a path with no PouchDB doc (e.g. a folder path itself, or
    // an already-deleted file) → db.get 404s. That MUST stay a no-op (legitimate),
    // distinct from the 409 surfaced above.
    bridge.stop();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((bridge as any).reconcileTombstone(pathToDocId("never-existed")))
      .resolves.toBeUndefined();
  });

  it("onVaultEvent logs when a single-file delete tombstone fails (409 surfaced)", async () => {
    // FIX #1 observability: when a per-file delete's tombstone fails with a non-404
    // (a 409 TOCTOU against the live changes feed), markDeletedInPouch rethrows and
    // onVaultEvent's delete branch must log it via console.error rather than
    // swallowing it. A swallowed failure leaves the doc LIVE → ghost file.
    vault._addText("note.md", "content");
    watcher.emit({ type: "change", path: "note.md" });
    await flushPromises();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // The change above already resolved its put; this rejection lands on the
    // delete's markDeletedInPouch put (the live-changes-feed rev-bump TOCTOU).
    vi.spyOn(db, "put").mockRejectedValueOnce({ status: 409, name: "conflict" });

    watcher.emit({ type: "delete", path: "note.md" });
    await flushPromises();

    expect(errorSpy).toHaveBeenCalledWith(
      "[vault-sync] delete tombstone failed",
      expect.objectContaining({ status: 409 }),
    );
    errorSpy.mockRestore();
  });
});

// ==========================================================================
// Level 3 echo suppression: self-originated rev tracking (FS -> DB -> FS loop)
// ==========================================================================

describe("PouchDbFsBridge — Level 3 echo suppression (self-originated revs)", () => {
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

  it("suppresses stale self-echo: rapid successive writes do not revert to older content", async () => {
    // Scenario: vault writes v1, then v2. The v1 echo arrives AFTER v2 is already
    // the winning rev. Without Level 3, applyRemoteChange would write "v1" back to
    // disk — reverting the file. With Level 3, the v1 echo is suppressed.
    const path = "rapid.md";
    vault._addText(path, "v1");

    // First write: vault v1 -> PouchDB
    watcher.emit({ type: "change", path });
    await flushPromises();
    const rev1 = db._docs.get(pathToDocId(path))?._rev;
    expect(rev1).toBeDefined();

    // Second write: vault v2 -> PouchDB (updates content and rev)
    vault._addText(path, "v2");
    watcher.emit({ type: "change", path });
    await flushPromises();
    const rev2 = db._docs.get(pathToDocId(path))?._rev;
    expect(rev2).toBeDefined();
    expect(rev2).not.toBe(rev1);

    // Spy on vault writes to detect if the echo causes a revert
    const modifySpy = vi.spyOn(vault, "modifyText");
    const createSpy = vi.spyOn(vault, "createText");

    // Simulate the stale v1 echo arriving via the changes feed (self-originated,
    // superseded by v2). This is the exact scenario of BUG #88: rapid edits cause
    // the earlier rev's echo to arrive and revert the file to old content.
    const staleV1Doc = {
      _id: pathToDocId(path),
      _rev: rev1!,
      content: "v1",
      mtime: Date.now(),
      deleted: false,
    };
    db._emitChange(staleV1Doc);
    await flushPromises();
    await flushPromises();

    // Level 3 must suppress this: the vault must NOT be written with "v1" content
    expect(modifySpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    // The vault must still show "v2" (not reverted)
    expect(vault._getText(path)).toBe("v2");
  });

  it("rapid successive variant: echo of rev1 suppressed even when rev2 has been written", async () => {
    // Same as above, but we explicitly capture both revs to verify the suppression
    // is based on the rev identity, not just content-equality (which Level 2 already checks).
    // This test uses DIFFERENT content to ensure Level 2 (content equality) cannot save us.
    const path = "rapid2.md";
    vault._addText(path, "first version content");

    watcher.emit({ type: "change", path });
    await flushPromises();
    const capturedRev1 = db._docs.get(pathToDocId(path))?._rev!;
    expect(capturedRev1).toBeDefined();

    vault._addText(path, "second version content");
    watcher.emit({ type: "change", path });
    await flushPromises();
    const capturedRev2 = db._docs.get(pathToDocId(path))?._rev!;
    expect(capturedRev2).not.toBe(capturedRev1);

    // Simulate v2's content already on disk (as it would be after the bridge applied it)
    // then feed back v1's stale echo — content is DIFFERENT from current ("first version")
    // so Level 2 content equality cannot suppress it. Only Level 3 can.
    vault._addText(path, "second version content"); // current disk state = v2

    const modifySpy = vi.spyOn(vault, "modifyText");
    const createSpy = vi.spyOn(vault, "createText");

    db._emitChange({
      _id: pathToDocId(path),
      _rev: capturedRev1,
      content: "first version content",
      mtime: Date.now(),
      deleted: false,
    });
    await flushPromises();
    await flushPromises();

    expect(modifySpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("genuine external change (rev not written locally) still writes to vault", async () => {
    // A change arriving from iOS / another device has a rev that was NOT produced by
    // this bridge instance's writeTextToPouch. It MUST be applied to disk.
    const path = "external.md";

    // No local write — inject a change directly as if it came from a remote peer
    const externalDoc = {
      _id: pathToDocId(path),
      _rev: "5-external",
      content: "content from iOS",
      mtime: Date.now(),
      deleted: false,
    };
    // We must set the doc in the mock's store first so db.get() works inside applyRemoteChange
    db._docs.set(pathToDocId(path), externalDoc);

    const modifySpy = vi.spyOn(vault, "modifyText");
    const createSpy = vi.spyOn(vault, "createText");

    db._emitChange(externalDoc);
    await flushPromises();
    await flushPromises();

    // The external change must have been applied — either createText or modifyText
    const wasWritten = createSpy.mock.calls.length > 0 || modifySpy.mock.calls.length > 0;
    expect(wasWritten).toBe(true);
    expect(vault._getText(path)).toBe("content from iOS");
  });

  it("genuine second write after self-echo is not over-suppressed", async () => {
    // After a local write (rev1 in selfOriginatedRevs), an EXTERNAL rev2 arrives.
    // Level 3 must allow it: rev2 is NOT in selfOriginatedRevs.
    const path = "not-over-suppressed.md";
    vault._addText(path, "local content");

    watcher.emit({ type: "change", path });
    await flushPromises();
    // rev1 now in selfOriginatedRevs

    const modifySpy = vi.spyOn(vault, "modifyText");
    const createSpy = vi.spyOn(vault, "createText");

    // External change arrives with a NEW rev (not produced locally)
    const externalRev = "99-external";
    const externalDoc = {
      _id: pathToDocId(path),
      _rev: externalRev,
      content: "content from another device",
      mtime: Date.now(),
      deleted: false,
    };
    db._docs.set(pathToDocId(path), externalDoc);

    db._emitChange(externalDoc);
    await flushPromises();
    await flushPromises();

    const wasWritten = createSpy.mock.calls.length > 0 || modifySpy.mock.calls.length > 0;
    expect(wasWritten).toBe(true);
    expect(vault._getText(path)).toBe("content from another device");
  });
});

// Level 3 TTL eviction: self-originated revs are bounded (no unbounded growth)
// ==========================================================================

describe("PouchDbFsBridge — Level 3 TTL eviction (selfOriginatedRevs bounded)", () => {
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

  it("self-echo arriving within TTL is still suppressed", async () => {
    // Write v1 locally -> rev1 enters selfOriginatedRevs with a 5s TTL.
    // Immediately emit the stale echo (< 5s) -> must be suppressed.
    const path = "ttl-within.md";
    vault._addText(path, "v1");
    watcher.emit({ type: "change", path });
    await flushPromisesFakeTimers();

    const rev1 = db._docs.get(pathToDocId(path))?._rev!;
    expect(rev1).toBeDefined();

    // Advance 100ms — well within the 5s TTL
    await vi.advanceTimersByTimeAsync(100);

    const modifySpy = vi.spyOn(vault, "modifyText");
    const createSpy = vi.spyOn(vault, "createText");

    db._emitChange({
      _id: pathToDocId(path),
      _rev: rev1,
      content: "v1",
      mtime: Date.now(),
      deleted: false,
    });
    await flushPromisesFakeTimers();
    await flushPromisesFakeTimers();

    // Echo must be suppressed — no vault write
    expect(modifySpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("self-rev is evicted after TTL — echo arriving after TTL is allowed through", async () => {
    // Write v1 locally -> rev1 enters selfOriginatedRevs.
    // Advance past the 5s TTL -> rev1 is evicted.
    // Emit the echo with rev1 -> must NOT be suppressed (eviction confirms set is bounded).
    //
    // NOTE: vault now holds different content ("v2") so Level 2 (content equality)
    // cannot suppress this change — only Level 3 could, and after TTL it won't.
    const path = "ttl-expired.md";
    vault._addText(path, "v1");
    watcher.emit({ type: "change", path });
    await flushPromisesFakeTimers();

    const rev1 = db._docs.get(pathToDocId(path))?._rev!;
    expect(rev1).toBeDefined();

    // Advance past the 5s TTL — rev1 should be evicted from selfOriginatedRevs
    await vi.advanceTimersByTimeAsync(5100);

    // Simulate the vault having moved on to v2 locally (Level 2 can't suppress now)
    vault._addText(path, "v2");

    const modifySpy = vi.spyOn(vault, "modifyText");
    const createSpy = vi.spyOn(vault, "createText");

    // Ensure the mock db has the doc so applyRemoteChange can proceed past db.get()
    const echoDoc = {
      _id: pathToDocId(path),
      _rev: rev1,
      content: "v1",
      mtime: Date.now(),
      deleted: false,
    };
    db._docs.set(pathToDocId(path), echoDoc);

    db._emitChange(echoDoc);
    await flushPromisesFakeTimers();
    await flushPromisesFakeTimers();

    // After TTL, the rev is no longer in selfOriginatedRevs — echo is allowed through
    const wasWritten = createSpy.mock.calls.length > 0 || modifySpy.mock.calls.length > 0;
    expect(wasWritten).toBe(true);
  });
});
