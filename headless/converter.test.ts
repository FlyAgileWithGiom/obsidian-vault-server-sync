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
import { runConverter, type ConverterResult } from "./converter";

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

    // No writes to PouchDB
    expect(db._insertedDocs).toHaveLength(0);

    // state.json not renamed
    expect(fs.existsSync(statePath)).toBe(true);

    // No marker written
    const markerPath = path.join(pouchDir, ".migration-complete");
    expect(fs.existsSync(markerPath)).toBe(false);
  });
});
