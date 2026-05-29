/**
 * C05 — Daemon integration tests
 *
 * Wires together real components against a real filesystem (tmpdir):
 *   FsWatcher (real fs.watch) + FilesystemVaultAdapter + PouchDbFsBridge
 *   + mock PouchDB (in-memory, same shape as unit tests)
 *
 * Validates the end-to-end sync paths:
 *   - FS write -> FsWatcher -> bridge -> PouchDB write
 *   - Remote PouchDB change -> bridge -> vault FS write
 *   - Echo-loop suppression: remote write does NOT loop back to PouchDB
 *
 * NOTE: These tests use real fs.watch and have an inherent timing dependency.
 * They tolerate up to 2s for FSEvents latency + 100ms debounce + async.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FsWatcher } from "./FsWatcher";
import { FilesystemVaultAdapter } from "./VaultAdapter";
import { PouchDbFsBridge } from "../src/PouchDbFsBridge";
import { pathToDocId } from "../src/doc-id";

// ---- Minimal PouchDB mock (same shape as PouchDbFsBridge.test.ts) --------

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

function makePouchMock() {
  const docs = new Map<string, DocShape>();
  let revCounter = 0;

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

  function emitChange(doc: DocShape) {
    if (cancelled) return;
    if (!doc._deleted) {
      docs.set(doc._id, { ...doc });
    }
    const event = { id: doc._id, seq: revCounter, deleted: !!doc._deleted, doc };
    for (const h of changeListeners) h(event);
  }

  return {
    async get(id: string): Promise<DocShape> {
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

    changes(_opts: unknown): typeof changesHandle {
      cancelled = false;
      return changesHandle;
    },

    _docs: docs,
    _emitChange: emitChange,
  };
}

// ---- Polling helper (mirrors headless/main.test.ts waitFor) --------------

function waitFor(predicate: () => boolean, timeoutMs = 2500): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(check, 50);
    };
    check();
  });
}

// ---- Test suite ----------------------------------------------------------

describe("Daemon integration — FS <-> PouchDB bridge (C05)", () => {
  let vaultDir: string;
  let vault: FilesystemVaultAdapter;
  let watcher: FsWatcher;
  let db: ReturnType<typeof makePouchMock>;
  let bridge: PouchDbFsBridge;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-integration-"));
    vault = new FilesystemVaultAdapter(vaultDir);
    watcher = new FsWatcher(vaultDir, []);
    db = makePouchMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bridge = new PouchDbFsBridge(vault, db as any);

    // Allow fs.watch to arm before running test body
    bridge.start(watcher);
  });

  afterEach(() => {
    bridge.stop();
    try { fs.rmSync(vaultDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("FS write -> FsWatcher -> bridge -> PouchDB write", async () => {
    // Allow fs.watch to arm (macOS cold-start latency)
    await new Promise((r) => setTimeout(r, 200));

    const filePath = path.join(vaultDir, "hello.md");
    fs.writeFileSync(filePath, "Hello from vault");

    const docId = pathToDocId("hello.md");
    await waitFor(() => db._docs.has(docId));

    const doc = db._docs.get(docId)!;
    expect(doc.content).toBe("Hello from vault");
    expect(doc._rev).toBeTruthy();
  });

  it("FS delete -> FsWatcher -> bridge -> PouchDB tombstone", async () => {
    await new Promise((r) => setTimeout(r, 200));

    // Create and wait for it to be in PouchDB
    const filePath = path.join(vaultDir, "bye.md");
    fs.writeFileSync(filePath, "will be deleted");
    const docId = pathToDocId("bye.md");
    await waitFor(() => db._docs.has(docId));

    // Now delete
    fs.rmSync(filePath);
    await waitFor(() => {
      const doc = db._docs.get(docId);
      return doc?._deleted === true;
    });

    const doc = db._docs.get(docId)!;
    expect(doc._deleted).toBe(true);
  });

  it("remote PouchDB change -> bridge -> vault FS write", async () => {
    await new Promise((r) => setTimeout(r, 200));

    const docId = pathToDocId("remote.md");
    db._emitChange({
      _id: docId,
      _rev: "1-remote",
      content: "Content from remote",
      mtime: Date.now(),
      deleted: false,
    });

    // Poll vault filesystem for the new file
    await waitFor(() => fs.existsSync(path.join(vaultDir, "remote.md")));

    const content = fs.readFileSync(path.join(vaultDir, "remote.md"), "utf-8");
    expect(content).toBe("Content from remote");
  });

  it("echo-loop suppression: remote write does NOT loop back to PouchDB", async () => {
    await new Promise((r) => setTimeout(r, 200));

    const docId = pathToDocId("no-echo.md");
    const putCallsBefore = db._docs.size;

    // Remote change -> bridge writes to FS -> FsWatcher fires -> should NOT write back to PouchDB
    db._emitChange({
      _id: docId,
      _rev: "1-remote",
      content: "remote content",
      mtime: Date.now(),
      deleted: false,
    });

    // Wait for the file to appear (bridge applied the remote change)
    await waitFor(() => fs.existsSync(path.join(vaultDir, "no-echo.md")));

    // Give the echo event time to propagate through fs.watch + debounce
    await new Promise((r) => setTimeout(r, 600));

    // PouchDB should still have exactly 1 doc for this id (the one emitted by remote)
    // If echo suppression failed, the bridge would have done a put() creating a 2nd revision
    const doc = db._docs.get(docId);
    expect(doc?._rev).toBe("1-remote"); // rev unchanged = no loopback put() happened
  });

  it("update propagates: FS modify -> PouchDB write updates existing doc", async () => {
    await new Promise((r) => setTimeout(r, 200));

    const filePath = path.join(vaultDir, "update.md");
    const docId = pathToDocId("update.md");

    // First write
    fs.writeFileSync(filePath, "version 1");
    await waitFor(() => db._docs.has(docId));
    const rev1 = db._docs.get(docId)!._rev!;

    // Second write
    fs.writeFileSync(filePath, "version 2");
    await waitFor(() => db._docs.get(docId)?.content === "version 2");

    const rev2 = db._docs.get(docId)!._rev!;
    expect(rev2).not.toBe(rev1); // rev bumped on update
    expect(db._docs.get(docId)!.content).toBe("version 2");
  });
});

describe("Daemon integration — content-null guard: seeded docs without content do not overwrite vault files (C05-guard)", () => {
  let vaultDir: string;
  let vault: FilesystemVaultAdapter;
  let watcher: FsWatcher;
  let db: ReturnType<typeof makePouchMock>;
  let bridge: PouchDbFsBridge;

  beforeEach(async () => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-test-"));
    vault = new FilesystemVaultAdapter(vaultDir);
    watcher = new FsWatcher(vaultDir, []);
    db = makePouchMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bridge = new PouchDbFsBridge(vault, db as any);
    bridge.start(watcher);
    // Allow fs.watch to arm
    await new Promise((r) => setTimeout(r, 200));
  });

  afterEach(() => {
    bridge.stop();
    try { fs.rmSync(vaultDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("positive control: remote doc WITH content writes to vault (proves delivery works)", async () => {
    // Sanity check: a normal remote doc does land on disk.
    // If this fails, the guard tests below are meaningless (delivery is broken).
    const docId = pathToDocId("positive-control.md");
    db._emitChange({
      _id: docId,
      _rev: "1-abc",
      content: "real content here",
      mtime: Date.now(),
    });

    await waitFor(() => fs.existsSync(path.join(vaultDir, "positive-control.md")));
    const written = fs.readFileSync(path.join(vaultDir, "positive-control.md"), "utf-8");
    expect(written).toBe("real content here");
  });

  it("content===null guard: seeded text doc without content does not overwrite existing vault file", async () => {
    // Simulate what the converter seeds: a doc with no content field (revMap migration).
    // This doc should NOT overwrite an existing vault file with an empty/null write.
    const filePath = path.join(vaultDir, "protected.md");
    fs.writeFileSync(filePath, "real content — must survive");

    // Emit a change for this doc with content: null (no content, as seeded by converter)
    const docId = pathToDocId("protected.md");
    db._emitChange({
      _id: docId,
      _rev: "1-seeded",
      content: null,      // no content — this is what converter seeds
      mtime: Date.now(),
    });

    // Give the bridge time to process the change
    await new Promise((r) => setTimeout(r, 400));

    // The file must still contain the original content
    const actual = fs.readFileSync(filePath, "utf-8");
    expect(actual).toBe("real content — must survive");
  });

  it("content===undefined guard: seeded text doc without content field does not overwrite existing vault file", async () => {
    // Variant: content field entirely absent (undefined) — same guard triggers
    const filePath = path.join(vaultDir, "protected-undef.md");
    fs.writeFileSync(filePath, "original content");

    const docId = pathToDocId("protected-undef.md");
    db._emitChange({
      _id: docId,
      _rev: "1-seeded",
      // no content key at all
      mtime: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 400));

    const actual = fs.readFileSync(filePath, "utf-8");
    expect(actual).toBe("original content");
  });

  it("binary guard: seeded binary doc without _attachments does not overwrite existing binary file", async () => {
    // For binary files (e.g. .png), the guard is: !_attachments -> return.
    // A seeded doc without attachments must not erase the real binary on disk.
    const filePath = path.join(vaultDir, "image.png");
    const originalBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02]); // fake PNG header
    fs.writeFileSync(filePath, originalBytes);

    const docId = pathToDocId("image.png");
    db._emitChange({
      _id: docId,
      _rev: "1-seeded",
      mtime: Date.now(),
      // _attachments absent — binary guard triggers
    });

    await new Promise((r) => setTimeout(r, 400));

    const actual = fs.readFileSync(filePath);
    expect(Buffer.compare(actual, originalBytes)).toBe(0); // bytes unchanged
  });
});
