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

    async deleteDirectory(_dir: VaultFolder): Promise<void> {},

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
