/**
 * Tests for headless/converter.ts — state.json revMap -> PouchDB migration.
 *
 * Uses a hand-rolled PouchDB mock so we can control doc_count and bulkDocs
 * behaviour without spinning up LevelDB in the test environment.
 * Uses tmp directories (os.tmpdir()) for filesystem operations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { runConverter, type ConverterResult, type RemoteDbForPhantomCheck } from "./converter";

// ---- Minimal PouchDB mock -----------------------------------------------

type BulkDoc = {
  _id: string;
  _rev?: string;
  mtime?: number;
  [key: string]: unknown;
};

function makePouchMock(initialDocCount = 0) {
  const insertedDocs: BulkDoc[] = [];
  let shouldBulkFail = false;

  return {
    async info() {
      return { db_name: "test", doc_count: initialDocCount + insertedDocs.length, update_seq: 0 };
    },

    async bulkDocs(
      docs: BulkDoc[],
      _opts: { new_edits: boolean },
    ): Promise<Array<{ ok?: boolean; error?: boolean; id?: string; rev?: string }>> {
      if (shouldBulkFail) throw new Error("bulkDocs simulated failure");
      for (const d of docs) insertedDocs.push(d);
      return docs.map(d => ({ ok: true, id: d._id, rev: d._rev }));
    },

    // Test helpers
    _insertedDocs: insertedDocs,
    _forceBulkFail() { shouldBulkFail = true; },
  };
}

// ---- Remote mock for phantom check ---------------------------------------

type AllDocsRow =
  | { id: string; key: string; value: { rev: string; deleted?: boolean } }
  | { key: string; error: string };

/**
 * Build a remote mock that answers allDocs with configurable existing/not-found/deleted ids.
 * existingIds: set of ids that "exist" actively in CouchDB (return a value row)
 * deletedIds: set of ids that are tombstoned in CouchDB (return value.deleted: true)
 * All other ids in the keys array get a { key, error: "not_found" } row.
 *
 * Real-world: many "phantom" entries (e.g. .git/* files) appear as deleted docs
 * in CouchDB (they were pushed once, then deleted via daemon tombstone), rather
 * than pure not_found.
 */
function makeRemoteMock(existingIds: Set<string>, deletedIds: Set<string> = new Set()) {
  const batchCalls: string[][] = [];

  const mock: RemoteDbForPhantomCheck & { _batchCalls: string[][] } = {
    _batchCalls: batchCalls,

    async allDocs(opts: { keys: string[]; include_docs: false }) {
      batchCalls.push([...opts.keys]);
      const rows: AllDocsRow[] = opts.keys.map(key => {
        if (existingIds.has(key)) {
          return { id: key, key, value: { rev: "1-abc" } };
        }
        if (deletedIds.has(key)) {
          // Mimics CouchDB response for a deleted doc: value contains rev + deleted:true
          return { id: key, key, value: { rev: "2-deleted", deleted: true } };
        }
        return { key, error: "not_found" };
      });
      return { rows };
    },
  };

  return mock;
}

// ---- State file helpers ---------------------------------------------------

function makeStateJson(revMap: Record<string, unknown>): string {
  return JSON.stringify({ "vault-sync-revmap": JSON.stringify(revMap) });
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "converter-test-"));
}

// ---- Tests ----------------------------------------------------------------

describe("Converter — runConverter()", () => {
  let tmpDir: string;
  let statePath: string;
  let pouchDir: string;
  let db: ReturnType<typeof makePouchMock>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    statePath = path.join(tmpDir, "state.json");
    pouchDir = path.join(tmpDir, "pouch");
    db = makePouchMock();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("no-op when state.json is absent", async () => {
    // statePath does not exist
    const result = await runConverter(statePath, pouchDir, db as never);
    expect(result.noStateFile).toBe(true);
    expect(result.migrated).toBe(0);
    expect(db._insertedDocs).toHaveLength(0);
  });

  it("no-op when state.json is malformed JSON", async () => {
    fs.writeFileSync(statePath, "this is not json");
    const result = await runConverter(statePath, pouchDir, db as never);
    expect(result.noStateFile).toBe(true);
    expect(result.migrated).toBe(0);
  });

  it("no-op when vault-sync-revmap key is absent from state.json", async () => {
    fs.writeFileSync(statePath, JSON.stringify({ "some-other-key": "value" }));
    const result = await runConverter(statePath, pouchDir, db as never);
    expect(result.noStateFile).toBe(true);
    expect(result.migrated).toBe(0);
  });

  it("migrates 3 known entries via bulkDocs with new_edits:false", async () => {
    const revMap = {
      "file/notes/a.md": { state: "known", rev: "2-aaa", mtime: 1700000001000 },
      "file/notes/b.md": { state: "known", rev: "1-bbb", mtime: 1700000002000 },
      "file/notes/c.md": { state: "known", rev: "3-ccc", mtime: 1700000003000 },
    };
    fs.writeFileSync(statePath, makeStateJson(revMap));

    const bulkDocsSpy = vi.spyOn(db, "bulkDocs");
    const result = await runConverter(statePath, pouchDir, db as never);

    expect(result.migrated).toBe(3);
    expect(result.tombstonedSkipped).toBe(0);
    expect(result.orphanSkipped).toBe(0);
    expect(result.alreadyMigrated).toBe(false);

    // Verify bulkDocs was called with new_edits: false
    expect(bulkDocsSpy).toHaveBeenCalledWith(
      expect.any(Array),
      { new_edits: false },
    );

    // Verify the inserted docs have the correct _id and _rev
    const ids = db._insertedDocs.map(d => d._id).sort();
    expect(ids).toEqual(["file/notes/a.md", "file/notes/b.md", "file/notes/c.md"].sort());

    const revs = Object.fromEntries(db._insertedDocs.map(d => [d._id, d._rev]));
    expect(revs["file/notes/a.md"]).toBe("2-aaa");
    expect(revs["file/notes/b.md"]).toBe("1-bbb");
    expect(revs["file/notes/c.md"]).toBe("3-ccc");
  });

  it("skips tombstoned entries (Decision D3)", async () => {
    const revMap = {
      "file/alive.md": { state: "known", rev: "1-aaa", mtime: 1700000001000 },
      "file/dead.md": { state: "tombstoned", rev: "2-bbb", tombstonedAt: 1700000000000 },
    };
    fs.writeFileSync(statePath, makeStateJson(revMap));

    const result = await runConverter(statePath, pouchDir, db as never);

    expect(result.migrated).toBe(1);
    expect(result.tombstonedSkipped).toBe(1);
    expect(result.orphanSkipped).toBe(0);

    // Only alive.md should be inserted
    expect(db._insertedDocs).toHaveLength(1);
    expect(db._insertedDocs[0]._id).toBe("file/alive.md");
  });

  it("skips orphan entries (Decision D3)", async () => {
    const revMap = {
      "file/known.md": { state: "known", rev: "1-aaa", mtime: 1700000001000 },
      "file/orphan.md": { state: "orphan", rev: "1-xxx" },
    };
    fs.writeFileSync(statePath, makeStateJson(revMap));

    const result = await runConverter(statePath, pouchDir, db as never);

    expect(result.migrated).toBe(1);
    expect(result.orphanSkipped).toBe(1);
    expect(db._insertedDocs).toHaveLength(1);
    expect(db._insertedDocs[0]._id).toBe("file/known.md");
  });

  it("idempotent: skips migration when PouchDB already has docs", async () => {
    const revMap = {
      "file/a.md": { state: "known", rev: "1-aaa", mtime: 1700000001000 },
    };
    fs.writeFileSync(statePath, makeStateJson(revMap));

    // PouchDB reports doc_count > 0 — already migrated
    const dbWithDocs = makePouchMock(100);
    const result = await runConverter(statePath, pouchDir, dbWithDocs as never);

    expect(result.alreadyMigrated).toBe(true);
    expect(result.migrated).toBe(0);
    expect(dbWithDocs._insertedDocs).toHaveLength(0);

    // state.json should NOT be renamed (we didn't touch PouchDB)
    expect(fs.existsSync(statePath)).toBe(true);
  });

  it("renames state.json to state.json.migrated after success", async () => {
    const revMap = {
      "file/a.md": { state: "known", rev: "1-aaa", mtime: 1700000001000 },
    };
    fs.writeFileSync(statePath, makeStateJson(revMap));

    await runConverter(statePath, pouchDir, db as never);

    expect(fs.existsSync(statePath)).toBe(false);
    expect(fs.existsSync(statePath + ".migrated")).toBe(true);
  });

  it("writes .migration-complete marker to pouchDir after success", async () => {
    const revMap = {
      "file/a.md": { state: "known", rev: "1-aaa", mtime: 1700000001000 },
    };
    fs.writeFileSync(statePath, makeStateJson(revMap));

    await runConverter(statePath, pouchDir, db as never);

    const markerPath = path.join(pouchDir, ".migration-complete");
    expect(fs.existsSync(markerPath)).toBe(true);
    // Marker contains ISO timestamp
    const markerContent = fs.readFileSync(markerPath, "utf-8");
    expect(markerContent).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("does not rename state.json when bulkDocs fails", async () => {
    const revMap = {
      "file/a.md": { state: "known", rev: "1-aaa", mtime: 1700000001000 },
    };
    fs.writeFileSync(statePath, makeStateJson(revMap));

    db._forceBulkFail();
    await runConverter(statePath, pouchDir, db as never);

    // state.json must remain — safe to retry on next daemon start
    expect(fs.existsSync(statePath)).toBe(true);
    expect(fs.existsSync(statePath + ".migrated")).toBe(false);
  });

  it("dry-run: returns correct counts without writing to PouchDB or FS", async () => {
    const revMap = {
      "file/a.md": { state: "known", rev: "1-aaa", mtime: 1700000001000 },
      "file/b.md": { state: "known", rev: "2-bbb", mtime: 1700000002000 },
      "file/c.md": { state: "tombstoned", rev: "3-ccc", tombstonedAt: 1700000000000 },
      "file/d.md": { state: "orphan", rev: "4-ddd" },
    };
    fs.writeFileSync(statePath, makeStateJson(revMap));

    const result: ConverterResult = await runConverter(statePath, pouchDir, db as never, true);

    expect(result.migrated).toBe(2);
    expect(result.tombstonedSkipped).toBe(1);
    expect(result.orphanSkipped).toBe(1);
    expect(result.phantomSkipped).toBe(0);

    // No writes to PouchDB
    expect(db._insertedDocs).toHaveLength(0);

    // state.json not renamed
    expect(fs.existsSync(statePath)).toBe(true);

    // No marker written
    const markerPath = path.join(pouchDir, ".migration-complete");
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  // ---- Phantom filter tests -----------------------------------------------

  describe("Phantom filter (remoteDb provided)", () => {
    it("skips known entry absent from CouchDB (phantom), migrates one present", async () => {
      const revMap = {
        "file/real.md": { state: "known", rev: "1-aaa", mtime: 1700000001000 },
        ".DS_Store":    { state: "known", rev: "1-bbb", mtime: 1700000002000 },
      };
      fs.writeFileSync(statePath, makeStateJson(revMap));

      // CouchDB only knows file/real.md
      const remoteDb = makeRemoteMock(new Set(["file/real.md"]));
      const result = await runConverter(statePath, pouchDir, db as never, false, remoteDb);

      expect(result.migrated).toBe(1);
      expect(result.phantomSkipped).toBe(1);
      expect(result.tombstonedSkipped).toBe(0);
      expect(result.orphanSkipped).toBe(0);

      // Only real.md should be inserted
      expect(db._insertedDocs).toHaveLength(1);
      expect(db._insertedDocs[0]._id).toBe("file/real.md");
    });

    it("dry-run with remoteDb reports phantomSkipped without writing", async () => {
      const revMap = {
        "file/real.md": { state: "known", rev: "1-aaa", mtime: 1700000001000 },
        ".git/HEAD":    { state: "known", rev: "1-bbb", mtime: 1700000002000 },
        ".git/config":  { state: "known", rev: "1-ccc", mtime: 1700000003000 },
        "file/dead.md": { state: "tombstoned", rev: "2-ddd", tombstonedAt: 1700000000000 },
      };
      fs.writeFileSync(statePath, makeStateJson(revMap));

      const remoteDb = makeRemoteMock(new Set(["file/real.md"]));
      const result = await runConverter(statePath, pouchDir, db as never, true, remoteDb);

      expect(result.migrated).toBe(1);
      expect(result.phantomSkipped).toBe(2);
      expect(result.tombstonedSkipped).toBe(1);
      expect(result.orphanSkipped).toBe(0);

      // No writes in dry-run
      expect(db._insertedDocs).toHaveLength(0);
      expect(fs.existsSync(statePath)).toBe(true);
    });

    it("batches allDocs calls: 250 known entries -> 5 batches (50 each)", async () => {
      // Build 250 known entries: first 200 are phantoms, last 50 exist in CouchDB.
      // PHANTOM_BATCH_SIZE = 50 → batches: [0..49], [50..99], [100..149], [150..199], [200..249]
      const revMap: Record<string, unknown> = {};
      const existingIds = new Set<string>();

      for (let i = 0; i < 250; i++) {
        const id = `file/doc-${i}.md`;
        revMap[id] = { state: "known", rev: `1-${i.toString(16).padStart(3, "0")}`, mtime: 1700000000000 + i };
        if (i >= 200) existingIds.add(id);
      }
      fs.writeFileSync(statePath, makeStateJson(revMap));

      const remoteDb = makeRemoteMock(existingIds);
      const result = await runConverter(statePath, pouchDir, db as never, false, remoteDb);

      // 5 batches of 50 each
      expect(remoteDb._batchCalls).toHaveLength(5);
      for (const batch of remoteDb._batchCalls) {
        expect(batch).toHaveLength(50);
      }

      expect(result.phantomSkipped).toBe(200);
      expect(result.migrated).toBe(50);
    });

    it("skips entries that are deleted in CouchDB (value.deleted=true)", async () => {
      // Real-world scenario: .git/* files were pushed to CouchDB then deleted
      // remotely. The daemon's state.json still has them as "known".
      // allDocs returns them with value.deleted:true — they must be skipped.
      const revMap = {
        "file/real.md":  { state: "known", rev: "1-aaa", mtime: 1700000001000 },
        "file/.git/HEAD": { state: "known", rev: "4-bbb", mtime: 1700000002000 },
      };
      fs.writeFileSync(statePath, makeStateJson(revMap));

      const existingIds = new Set(["file/real.md"]);
      const deletedIds = new Set(["file/.git/HEAD"]);
      const remoteDb = makeRemoteMock(existingIds, deletedIds);
      const result = await runConverter(statePath, pouchDir, db as never, false, remoteDb);

      expect(result.phantomSkipped).toBe(1);
      expect(result.migrated).toBe(1);

      expect(db._insertedDocs).toHaveLength(1);
      expect(db._insertedDocs[0]._id).toBe("file/real.md");
    });

    it("without remoteDb, no phantom check is performed (phantomSkipped=0)", async () => {
      const revMap = {
        ".DS_Store": { state: "known", rev: "1-aaa", mtime: 1700000001000 },
        ".git/HEAD": { state: "known", rev: "1-bbb", mtime: 1700000002000 },
      };
      fs.writeFileSync(statePath, makeStateJson(revMap));

      // No remoteDb — both entries migrated regardless
      const result = await runConverter(statePath, pouchDir, db as never, false, undefined);

      expect(result.phantomSkipped).toBe(0);
      expect(result.migrated).toBe(2);
    });

    // ---- Retry / abort tests ------------------------------------------------

    /**
     * Build a remote mock that fails the first `failCount` calls then succeeds normally.
     * Used to simulate transient CouchDB timeouts followed by recovery.
     */
    function makeRetryMock(existingIds: Set<string>, failCount: number) {
      let callCount = 0;
      const batchCalls: string[][] = [];

      const mock: RemoteDbForPhantomCheck & { _batchCalls: string[][] } = {
        _batchCalls: batchCalls,

        async allDocs(opts: { keys: string[]; include_docs: false }) {
          batchCalls.push([...opts.keys]);
          if (callCount < failCount) {
            callCount++;
            throw new Error(`simulated allDocs timeout (attempt ${callCount})`);
          }
          callCount++;
          const rows = opts.keys.map(key =>
            existingIds.has(key)
              ? { id: key, key, value: { rev: "1-abc" } }
              : { key, error: "not_found" },
          );
          return { rows };
        },
      };

      return mock;
    }

    it("retries on transient failure and succeeds: batch timeout then success on 2nd attempt", async () => {
      // Arrange: one real doc, one phantom; allDocs fails once then succeeds
      const revMap = {
        "file/real.md": { state: "known", rev: "1-aaa", mtime: 1700000001000 },
        ".DS_Store":    { state: "known", rev: "1-bbb", mtime: 1700000002000 },
      };
      fs.writeFileSync(statePath, makeStateJson(revMap));

      const remoteDb = makeRetryMock(new Set(["file/real.md"]), 1 /* fail once */);

      // Use fake timers to fast-forward the backoff sleep (1s on retry 1)
      vi.useFakeTimers();
      const resultPromise = runConverter(statePath, pouchDir, db as never, false, remoteDb);
      // Advance past the 1s backoff for the first retry
      await vi.advanceTimersByTimeAsync(1_500);
      const result = await resultPromise;
      vi.useRealTimers();

      // Should have succeeded on retry: phantom detected correctly, none migrated by mistake
      expect(result.phantomSkipped).toBe(1);
      expect(result.migrated).toBe(1);

      // _batchCalls length = 2: initial attempt (failed) + 1 retry (succeeded)
      expect(remoteDb._batchCalls).toHaveLength(2);

      // State file renamed (migration completed successfully)
      expect(fs.existsSync(statePath + ".migrated")).toBe(true);
    });

    it("aborts converter after 3 retries exhausted: no phantom migrated by mistake", async () => {
      // Arrange: one phantom entry; allDocs always fails (simulates persistent CouchDB outage)
      const revMap = {
        ".DS_Store": { state: "known", rev: "1-aaa", mtime: 1700000001000 },
      };
      fs.writeFileSync(statePath, makeStateJson(revMap));

      // Fail more times than PHANTOM_BATCH_MAX_RETRIES (3) allows
      const remoteDb = makeRetryMock(new Set(), 10 /* always fails */);

      vi.useFakeTimers();
      const resultPromise = runConverter(statePath, pouchDir, db as never, false, remoteDb);

      // Attach rejection handler BEFORE advancing timers to prevent unhandled rejection.
      // The promise may settle during advanceTimersByTimeAsync microtask flush.
      const rejectionAssertion = expect(resultPromise).rejects.toThrow(
        /phantom check failed for batch.*aborting migration/,
      );

      // Advance past all backoffs: 1s + 2s + 4s = 7s total
      await vi.advanceTimersByTimeAsync(10_000);
      await rejectionAssertion;
      vi.useRealTimers();

      // Critical: no phantom was migrated to PouchDB
      expect(db._insertedDocs).toHaveLength(0);

      // state.json NOT renamed — safe to retry when CouchDB recovers
      expect(fs.existsSync(statePath)).toBe(true);
      expect(fs.existsSync(statePath + ".migrated")).toBe(false);

      // Total calls: 1 initial + 3 retries = 4 attempts
      expect(remoteDb._batchCalls).toHaveLength(4);
    });
  });
});
