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
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FsWatcher } from "./FsWatcher";
import { FilesystemVaultAdapter } from "./VaultAdapter";
import { PouchDbFsBridge } from "../src/PouchDbFsBridge";
import { pathToDocId } from "../src/doc-id";
import { runDaemonV2Startup, runReconcileOnStartup } from "./main";

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

    /** Returns doc_count for the non-first-run gate in runReconcileOnStartup. */
    async info(): Promise<{ doc_count: number }> {
      const nonDeleted = [...docs.values()].filter(d => !d._deleted).length;
      return { doc_count: nonDeleted };
    },

    /**
     * Minimal allDocs for localDocIds enumeration.
     * Returns only non-deleted docs (matches real PouchDB behaviour for default query).
     */
    async allDocs(_opts: { include_docs: false }): Promise<{ rows: Array<{ id: string }> }> {
      const rows = [...docs.entries()]
        .filter(([, d]) => !d._deleted)
        .map(([id]) => ({ id }));
      return { rows };
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

// ---------------------------------------------------------------------------
// RC2 Cycle 3 — startup reconciliation end-to-end (RC2 AC2.1 / AC2.3a / AC2.3b)
// ---------------------------------------------------------------------------
//
// Uses real FilesystemVaultAdapter + tmpdir + mock PouchDB.
// The "live sync" delivery for pull actions is simulated by db._emitChange(remoteDoc)
// after runDaemonV2Startup returns — at that point the changes feed is armed.
// ---------------------------------------------------------------------------

describe("RC2 — startup reconciliation (AC2.1, AC2.3a, AC2.3b)", () => {
  let vaultDir: string;
  let vault: FilesystemVaultAdapter;
  let db: ReturnType<typeof makePouchMock>;
  let bridge: PouchDbFsBridge;

  // Helper to build the runReconcile closure just as the real daemon does it.
  // Injects a stub remoteDb so tests control what fetchRemoteRevs returns.
  function makeRunReconcile(stubRemoteRevs: Map<string, { rev: string; deleted: boolean }>) {
    return () => runReconcileOnStartup({
      db,
      bridge,
      vaultAdapter: vault,
      remoteDb: {
        async allDocs(opts: { keys: string[] }) {
          // Return stub rows matching the keys asked for
          const rows = opts.keys.map((key: string) => {
            const entry = stubRemoteRevs.get(key);
            if (!entry) return { key, error: "not_found" };
            return { id: key, key, value: { rev: entry.rev, deleted: entry.deleted } };
          });
          return { rows };
        },
      },
      excludePatterns: [],
    });
  }

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc2-reconcile-"));
    vault = new FilesystemVaultAdapter(vaultDir);
    db = makePouchMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bridge = new PouchDbFsBridge(vault, db as any);
    // NOTE: bridge.start is called inside runDaemonV2Startup in tests below.
  });

  afterEach(() => {
    bridge.stop();
    try { fs.rmSync(vaultDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("AC2.1 — stranded file on disk (not in DB, not in remote) gets pushed to PouchDB", async () => {
    // Pre-seed one doc A in DB + matching disk file (should NOT get a redundant write).
    const docA = pathToDocId("a.md");
    await db.put({ _id: docA, _rev: undefined, content: "content-a", mtime: Date.now() });
    fs.writeFileSync(path.join(vaultDir, "a.md"), "content-a");

    // B is the stranded file: on disk, NOT in DB, NOT in remote rev map.
    fs.writeFileSync(path.join(vaultDir, "b.md"), "content-b");

    const remoteRevs = new Map([
      // A is known remotely at the same rev (identical → skip for A)
      [docA, { rev: db._docs.get(docA)!._rev!, deleted: false }],
      // B is absent from remote — stranded push case (AC2.1)
    ]);

    const putCountBefore = [...db._docs.values()].length;

    await runDaemonV2Startup({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bridge: bridge as any,
      runReconcile: makeRunReconcile(remoteRevs),
      fsWatcher: new FsWatcher(vaultDir, []),
      engine: { start: vi.fn(async () => {}) },
    });

    // B must now be in PouchDB
    const docB = pathToDocId("b.md");
    expect(db._docs.has(docB)).toBe(true);
    expect(db._docs.get(docB)?.content).toBe("content-b");

    // A must NOT have gotten a redundant write (doc count grew by exactly 1)
    expect(db._docs.size).toBe(putCountBefore + 1);
  });

  it("AC2.3a — downtime-delete propagation: DB+remote have doc D (same rev), D absent on disk → tombstone", async () => {
    // Pre-seed doc D in DB; the file is NOT on disk (user deleted it during downtime).
    const docD = pathToDocId("d.md");
    await db.put({ _id: docD, _rev: undefined, content: "content-d", mtime: Date.now() });
    const revD = db._docs.get(docD)!._rev!;
    // Crucially: no file d.md on disk

    const remoteRevs = new Map([
      // Remote has D at the SAME rev as local → user deleted on disk → tombstone (AC2.3a)
      [docD, { rev: revD, deleted: false }],
    ]);

    await runDaemonV2Startup({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bridge: bridge as any,
      runReconcile: makeRunReconcile(remoteRevs),
      fsWatcher: new FsWatcher(vaultDir, []),
      engine: { start: vi.fn(async () => {}) },
    });

    // D must be tombstoned in PouchDB
    const docInDb = db._docs.get(docD);
    expect(docInDb?._deleted).toBe(true);
  });

  it("AC2.3b — downtime-remote-edit pull: DB has doc C at rev R, remote has different rev, C absent on disk → file lands on disk after live sync", async () => {
    // Pre-seed doc C in DB at rev R1; the file is NOT on disk.
    const docC = pathToDocId("c.md");
    await db.put({ _id: docC, _rev: undefined, content: "old-content", mtime: Date.now() });
    const revC = db._docs.get(docC)!._rev!;

    // Remote has C at a DIFFERENT rev (moved during outage) → pull action (AC2.3b)
    const remoteRevs = new Map([
      [docC, { rev: "99-remote-newer", deleted: false }],
    ]);

    await runDaemonV2Startup({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bridge: bridge as any,
      runReconcile: makeRunReconcile(remoteRevs),
      fsWatcher: new FsWatcher(vaultDir, []),
      engine: { start: vi.fn(async () => {}) },
    });

    // At this point bridge.start has been called and the changes feed is armed.
    // The reconcile pull action is a near-no-op (by design — live sync delivers).
    // Simulate live sync delivering the new remote doc via the changes feed:
    const newRemoteDoc = {
      _id: docC,
      _rev: "99-remote-newer",
      content: "new-content-from-remote",
      mtime: Date.now(),
    };
    db._emitChange(newRemoteDoc);

    // The file must land on disk (applyRemoteChange path via bridge.start)
    await waitFor(() => fs.existsSync(path.join(vaultDir, "c.md")));

    const written = fs.readFileSync(path.join(vaultDir, "c.md"), "utf-8");
    expect(written).toBe("new-content-from-remote");

    // Suppress unused variable warning
    void revC;
  });

  it("guard — DB-only doc NOT tombstoned when its rev differs from remote (AC2.3b branch, not AC2.3a)", async () => {
    // Pre-seed doc E in DB; no file on disk; remote has E at a DIFFERENT rev.
    // This must produce pull (not tombstone) — guard against blanket-delete.
    const docE = pathToDocId("e.md");
    await db.put({ _id: docE, _rev: undefined, content: "old-e", mtime: Date.now() });

    const remoteRevs = new Map([
      // Remote has E at a different rev — should be PULL, not TOMBSTONE
      [docE, { rev: "77-different", deleted: false }],
    ]);

    await runDaemonV2Startup({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bridge: bridge as any,
      runReconcile: makeRunReconcile(remoteRevs),
      fsWatcher: new FsWatcher(vaultDir, []),
      engine: { start: vi.fn(async () => {}) },
    });

    // E must NOT be tombstoned (rev differs → pull path)
    const docInDb = db._docs.get(docE);
    expect(docInDb?._deleted).not.toBe(true);
    expect(docInDb?.content).toBe("old-e"); // local doc preserved
  });
});

// ---------------------------------------------------------------------------
// RC2 Cycle 4 — non-destructive conflict handling (AC2.4) + echo no-op proof (AC2.7)
// ---------------------------------------------------------------------------
//
// AC2.4: both sides changed (disk diverged from localDB AND remote rev moved during outage)
//   → a conflict-copy file is created and pushed; the original doc is NOT overwritten.
//
// Control: local ≠ localDB but localrev === remoterev (remote did not move)
//   → plain push, no conflict-copy created.
//
// AC2.7: reconcile-pushed file does NOT echo back through the PouchDB→FS apply path
//   (ordering guarantee: reconcile runs before bridge.start).
// ---------------------------------------------------------------------------

describe("RC2 Cycle 4 — non-destructive conflict handling (AC2.4, control, AC2.7)", () => {
  let vaultDir: string;
  let vault: FilesystemVaultAdapter;
  let db: ReturnType<typeof makePouchMock>;
  let bridge: PouchDbFsBridge;

  function makeRunReconcile(stubRemoteRevs: Map<string, { rev: string; deleted: boolean }>) {
    return () => runReconcileOnStartup({
      db,
      bridge,
      vaultAdapter: vault,
      remoteDb: {
        async allDocs(opts: { keys: string[] }) {
          const rows = opts.keys.map((key: string) => {
            const entry = stubRemoteRevs.get(key);
            if (!entry) return { key, error: "not_found" };
            return { id: key, key, value: { rev: entry.rev, deleted: entry.deleted } };
          });
          return { rows };
        },
      },
      excludePatterns: [],
    });
  }

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc2-cycle4-"));
    vault = new FilesystemVaultAdapter(vaultDir);
    db = makePouchMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bridge = new PouchDbFsBridge(vault, db as any);
    // NOTE: bridge.start is called inside runDaemonV2Startup in tests below.
  });

  afterEach(() => {
    bridge.stop();
    try { fs.rmSync(vaultDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("AC2.4 — both-sides-changed: conflict-copy created, original doc untouched, counter=1", async () => {
    // Setup: local PouchDB has doc P at rev R with content X.
    // Disk has divergent content Y (user edited during outage).
    // Remote has P at a DIFFERENT rev R' (remote also moved during outage).
    const docP = pathToDocId("p.md");
    await db.put({ _id: docP, _rev: undefined, content: "content-X", mtime: Date.now() });
    const revR = db._docs.get(docP)!._rev!;

    // Write divergent content to disk (Y ≠ X)
    fs.writeFileSync(path.join(vaultDir, "p.md"), "content-Y");

    const remoteRevs = new Map([
      // Remote has P at a DIFFERENT rev (R' ≠ R → both sides changed → conflict-copy)
      [docP, { rev: "99-remote-R-prime", deleted: false }],
    ]);

    await runDaemonV2Startup({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bridge: bridge as any,
      runReconcile: makeRunReconcile(remoteRevs),
      fsWatcher: new FsWatcher(vaultDir, []),
      engine: { start: vi.fn(async () => {}) },
    });

    // (a) A conflict-copy file must exist (name includes "reconcile-conflict")
    const allFiles = fs.readdirSync(vaultDir);
    const conflictFiles = allFiles.filter(f => f.includes("reconcile-conflict") && f.startsWith("p"));
    expect(conflictFiles.length).toBe(1);

    // (b) The conflict-copy must have been pushed to PouchDB (has a doc entry)
    const conflictFileName = conflictFiles[0];
    const conflictDocId = pathToDocId(conflictFileName);
    expect(db._docs.has(conflictDocId)).toBe(true);
    expect(db._docs.get(conflictDocId)?.content).toBe("content-Y");

    // (c) Original doc P must NOT have been overwritten — same content X, same rev R
    //     (live sync will pull R' into it later; reconcile must not clobber the local doc)
    const originalDoc = db._docs.get(docP);
    expect(originalDoc?.content).toBe("content-X");
    expect(originalDoc?._rev).toBe(revR);

    // (d) FSEvents settling proof: p.md is on disk with content Y and has NO echo sentinel
    //     for its own docId (sentinel is only set for the conflict-copy).
    //     If a stale FSEvent fires for p.md after bridge.start, onVaultEvent would push Y
    //     into P — re-assert after 600ms to prove this does NOT happen.
    //
    //     NOTE: the conflict-copy sentinel set in reconcilePush prevents echo for the copy
    //     file; the original p.md doc is protected because reconcile never touches it
    //     (conflict-copy path leaves the original doc untouched on purpose).
    await new Promise((r) => setTimeout(r, 600));
    const originalDocAfterWait = db._docs.get(docP);
    expect(originalDocAfterWait?.content).toBe("content-X");
    expect(originalDocAfterWait?._rev).toBe(revR);
  });

  it("control — local≠localDB but localrev===remoterev: plain push, no conflict-copy", async () => {
    // Setup: local PouchDB has doc Q at rev R with content X.
    // Disk has divergent content Y (user edited during outage).
    // Remote has Q at THE SAME rev R (remote did NOT move → clean local edit → push).
    const docQ = pathToDocId("q.md");
    await db.put({ _id: docQ, _rev: undefined, content: "content-X", mtime: Date.now() });
    const revR = db._docs.get(docQ)!._rev!;

    // Write divergent content to disk (Y ≠ X)
    fs.writeFileSync(path.join(vaultDir, "q.md"), "content-Y");

    const remoteRevs = new Map([
      // Remote has Q at the SAME rev as local (R === R → remote did not move → push, not conflict)
      [docQ, { rev: revR, deleted: false }],
    ]);

    await runDaemonV2Startup({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bridge: bridge as any,
      runReconcile: makeRunReconcile(remoteRevs),
      fsWatcher: new FsWatcher(vaultDir, []),
      engine: { start: vi.fn(async () => {}) },
    });

    // No conflict-copy file must exist
    const allFiles = fs.readdirSync(vaultDir);
    const conflictFiles = allFiles.filter(f => f.includes("reconcile-conflict"));
    expect(conflictFiles.length).toBe(0);

    // The original doc must have been PUSHED (content updated to Y)
    const updatedDoc = db._docs.get(docQ);
    expect(updatedDoc?.content).toBe("content-Y");
  });

  it("AC2.7 — conflict-copy file written by reconcile does NOT echo back to PouchDB", async () => {
    // The echo-suppression ordering guarantee:
    //   reconcile runs BEFORE bridge.start arms the FS watcher and changes feed.
    //   Therefore, createText() during conflict-copy has no watcher to trigger —
    //   the written file cannot loop back through PouchDB→FS apply.
    //
    // Proof: after runDaemonV2Startup, the conflict-copy doc's _rev in PouchDB must
    // be unchanged after a ~600ms wait (same as the existing echo-loop test).

    const docT = pathToDocId("t.md");
    await db.put({ _id: docT, _rev: undefined, content: "content-old", mtime: Date.now() });
    const revT = db._docs.get(docT)!._rev!;

    // Disk diverged (Y ≠ old), remote moved (R' ≠ R) → conflict-copy scenario
    fs.writeFileSync(path.join(vaultDir, "t.md"), "content-diverged");

    const remoteRevs = new Map([
      [docT, { rev: "99-remote-moved", deleted: false }],
    ]);

    await runDaemonV2Startup({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bridge: bridge as any,
      runReconcile: makeRunReconcile(remoteRevs),
      fsWatcher: new FsWatcher(vaultDir, []),
      engine: { start: vi.fn(async () => {}) },
    });

    // Find the conflict-copy doc in PouchDB and capture its _rev immediately after startup
    const allFiles = fs.readdirSync(vaultDir);
    const conflictFile = allFiles.find(f => f.includes("reconcile-conflict") && f.startsWith("t"));
    expect(conflictFile).toBeDefined();

    const conflictDocId = pathToDocId(conflictFile!);
    const revAfterStartup = db._docs.get(conflictDocId)?._rev;
    expect(revAfterStartup).toBeTruthy();

    // Wait for the debounce + potential echo window (mirrors existing echo test)
    await new Promise((r) => setTimeout(r, 600));

    // Rev must be unchanged — no loopback put() happened
    const revAfterWait = db._docs.get(conflictDocId)?._rev;
    expect(revAfterWait).toBe(revAfterStartup);

    // Suppress unused variable warning (revT used to prove original not touched)
    void revT;
  });
});
