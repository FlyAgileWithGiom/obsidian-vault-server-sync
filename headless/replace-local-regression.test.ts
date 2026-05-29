/**
 * Regression test for "database is destroyed" bug in replaceLocalFromServer().
 *
 * Bug (prod iOS, v2.0.0): after db.destroy(), runInitialPull() called
 * db.replicate.from() on the destroyed handle → "Initial sync failed: database
 * is destroyed". Root cause: the engine held a stale db reference post-destroy.
 *
 * Fix: dbFactory recreates the db; bridge.setDb() re-arms the changes listener.
 *
 * Uses real pouchdb-node + LevelDB (fs.mkdtempSync) so PouchDB's actual
 * "database is destroyed" error is reproducible. pouchdb-node does not support
 * adapter:'memory', so temp dirs are used and cleaned up in afterEach.
 *
 * This test MUST fail on the pre-fix code and pass after the fix.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, afterEach } from "vitest";

// Minimal VaultAdapter stub — bridge methods won't be called in this test
// because we don't start the bridge.
const stubVault = {
  getEntryByPath: () => null,
  readText: async () => "",
  readBinary: async () => new ArrayBuffer(0),
  createText: async () => {},
  modifyText: async () => {},
  createBinary: async () => {},
  modifyBinary: async () => {},
  deleteFile: async () => {},
  createDirectory: async () => {},
};

// Minimal bridge stub — we only need setDb and stop; startChangesListener is
// not exercised here because the bridge is never started.
function makeStubBridge() {
  return {
    start: () => {},
    stop: () => {},
    setDb: (_db: unknown) => {},
  };
}

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-sync-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Non-critical: OS may clean up eventually
    }
  }
  tempDirs.length = 0;
});

describe("replaceLocalFromServer() — real PouchDB regression", () => {
  it("BEFORE fix: reproduces 'database is destroyed' on pre-fix code path", async () => {
    // This test documents what the broken code does. We simulate it manually
    // (don't import the fixed engine) to confirm the real error exists.
    const PouchDB = require("pouchdb-node") as typeof import("pouchdb-node");

    const dir = makeTempDir();
    const db = new PouchDB(dir);

    // Seed a doc
    await db.put({ _id: "file/hello.md", content: "hi" });
    const infoBefore = await db.info();
    expect(infoBefore.doc_count).toBe(1);

    // Simulate the bug: destroy then use the same handle
    await (db as unknown as { destroy(): Promise<void> }).destroy();

    let caughtError: string | null = null;
    try {
      await db.info(); // This is what runInitialPull triggers via db.replicate.from
    } catch (e) {
      caughtError = e instanceof Error ? e.message : String(e);
    }

    // Confirm the real error that was hitting iOS prod
    expect(caughtError).toMatch(/database is destroyed/i);
  });

  it("AFTER fix: replaceLocalFromServer() succeeds with a fresh db — no 'database is destroyed'", async () => {
    const PouchDB = require("pouchdb-node") as typeof import("pouchdb-node");
    const { PouchDbFsBridge } = await import("../src/PouchDbFsBridge");
    const { PouchDbSyncEngine } = await import("../src/PouchDbSyncEngine");

    const dir = makeTempDir();
    // dir2 for the "fresh" db the factory creates (leveldb dirs must be unique)
    const dir2 = makeTempDir();

    const settings = {
      couchDbUrl: "http://localhost:19999", // non-existent — replicate will fail fast
      couchDbName: "test-vault",
      couchDbUser: "",
      couchDbPassword: "",
      syncDebounceMs: 500,
      excludePatterns: [],
    };

    let callCount = 0;
    const dbFactory = () => {
      callCount++;
      // First call: reuse dir so engine.db starts with same db
      // Subsequent calls (from factory in replaceLocalFromServer): use dir2
      const target = callCount === 1 ? dir : dir2;
      return new PouchDB(target) as unknown as import("../src/pouchdb-browser").default;
    };

    const db = dbFactory();
    // Seed a doc into the initial db
    await (db as unknown as PouchDB).put({ _id: "file/test.md", content: "original" });

    const bridge = new PouchDbFsBridge(stubVault as never, db as never);
    const engine = new PouchDbSyncEngine(settings, db as never, bridge as never, dbFactory as never);

    // Run replaceLocalFromServer — this destroys dir db and creates dir2 db.
    // runInitialPull will attempt replication to localhost:19999 which fails,
    // but it must NOT fail with "database is destroyed" — the error should be
    // a network error about the unreachable host.
    await engine.replaceLocalFromServer();

    const diag = engine.getDiagnostics();

    // The critical assertion: no "database is destroyed" in lastError
    expect(diag.lastError).not.toMatch(/database is destroyed/i);

    // The factory must have been called to create the second db instance
    expect(callCount).toBeGreaterThanOrEqual(2);

    // The new db (dir2) must be functional — info() must resolve
    const dir2Db = new PouchDB(dir2);
    const info = await dir2Db.info();
    expect(info).toBeDefined();
    await (dir2Db as unknown as { destroy(): Promise<void> }).destroy();
  });
});
