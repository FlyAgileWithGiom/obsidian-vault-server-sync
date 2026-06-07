/**
 * Regression tests for replaceLocalFromServer().
 *
 * Covers two scenarios:
 *
 * 1. "database is destroyed" regression (v2.0.0 bug) — uses real pouchdb-node
 *    with a temp LevelDB dir to reproduce the original error.
 *
 * 2. Wipe-and-pull integration (replaces BUG-77 prune-orphans approach) — uses
 *    real CouchDB (localhost:5985, admin:devpass) to validate that after
 *    replaceLocalFromServer():
 *      - LOCAL-ONLY orphan files are deleted from disk
 *      - files seeded on the server appear on disk after re-pull
 *      - excluded paths (.obsidian/) are untouched
 *
 * The wipe-and-pull test is tagged @localdb and skipped when COUCHDB_URL is
 * not set (CI without a CouchDB service). To run locally:
 *   COUCHDB_URL=http://admin:devpass@localhost:5985 npm test
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, afterEach } from "vitest";

// Minimal VaultAdapter stub — bridge methods won't be called in this test
// because we don't start the bridge.
const stubVault = {
  getFiles: () => [],
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

// Minimal bridge stub — we only need setDb, stop, and wipeLocalFiles; the
// bridge is never started in this test.
function makeStubBridge() {
  return {
    start: () => {},
    stop: () => {},
    setDb: (_db: unknown) => {},
    wipeLocalFiles: async () => {},
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

// ---- Wipe-and-pull integration test (real CouchDB) -------------------------
// Skipped unless COUCHDB_URL is set, e.g.:
//   COUCHDB_URL=http://admin:devpass@localhost:5985 npm test

const COUCH_URL = process.env["COUCHDB_URL"];

describe.skipIf(!COUCH_URL)("replaceLocalFromServer() — wipe-and-pull real CouchDB", () => {
  const couchBase = COUCH_URL ?? "http://admin:devpass@localhost:5985";
  const dbName = "vault-sync-wipe-test";
  const remoteUrl = `${couchBase}/${dbName}`;

  afterEach(async () => {
    // Clean up test DB
    try {
      const PouchDB = require("pouchdb-node") as typeof import("pouchdb-node");
      const remote = new PouchDB(remoteUrl);
      await (remote as unknown as { destroy(): Promise<void> }).destroy();
    } catch {
      // ignore
    }
  });

  it("wipes LOCAL-ONLY orphan, pulls server docs, leaves excluded path untouched", async () => {
    const PouchDB = require("pouchdb-node") as typeof import("pouchdb-node");
    const { PouchDbFsBridge } = await import("../src/PouchDbFsBridge");
    const { PouchDbSyncEngine } = await import("../src/PouchDbSyncEngine");
    const { FilesystemVaultAdapter } = await import("./VaultAdapter");
    const { FsWatcher } = await import("./FsWatcher");

    // -- 1. Seed the remote CouchDB: one root doc + one doc inside a folder --
    const remote = new PouchDB(remoteUrl);
    await (remote as unknown as PouchDB).put({ _id: "file/server-note.md", content: "from server", mtime: 1000 });
    await (remote as unknown as PouchDB).put({ _id: "file/Notes/server-nested.md", content: "nested from server", mtime: 1000 });

    // Capture the authoritative server doc set BEFORE the replace (server-safety baseline).
    const serverIdsBefore = (await (remote as unknown as PouchDB).allDocs()).rows.map((r) => r.id).sort();

    // -- 2. Set up local vault dir --
    const vaultDir = makeTempDir();
    const pouchDir = makeTempDir();

    // Create a LOCAL-ONLY orphan file at root (not on server)
    const orphanPath = path.join(vaultDir, "orphan-local.md");
    fs.writeFileSync(orphanPath, "I am local only");

    // Create a LOCAL-ONLY orphan FOLDER (exercises the bulk deleteDirectory path)
    const orphanDir = path.join(vaultDir, "OldStuff");
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.writeFileSync(path.join(orphanDir, "a.md"), "old a");
    fs.writeFileSync(path.join(orphanDir, "b.md"), "old b");

    // Create an excluded file (.obsidian/) that must survive
    const obsidianDir = path.join(vaultDir, ".obsidian");
    fs.mkdirSync(obsidianDir, { recursive: true });
    const obsidianFile = path.join(obsidianDir, "app.json");
    fs.writeFileSync(obsidianFile, '{"theme":"default"}');

    // -- 3. Create local PouchDB, bridge, engine --
    const settings = {
      couchDbUrl: couchBase,
      couchDbName: dbName,
      couchDbUser: "",
      couchDbPassword: "",
      excludePatterns: [".obsidian/"],
    };

    const vaultAdapter = new FilesystemVaultAdapter(vaultDir);
    let callCount = 0;
    const dbFactory = () => {
      callCount++;
      return new PouchDB(pouchDir) as unknown as import("../src/pouchdb-browser").default;
    };
    const db = dbFactory();
    const bridge = new PouchDbFsBridge(vaultAdapter, db as never);

    // Start the bridge with a real FsWatcher so the PouchDB changes listener is
    // active: replicated docs from the server will be applied to disk.
    const excludePatterns = [".obsidian/"];
    const fsWatcher = new FsWatcher(vaultDir, excludePatterns);
    bridge.start(fsWatcher);

    const engine = new PouchDbSyncEngine(settings, db as never, bridge as never, dbFactory as never);

    await engine.replaceLocalFromServer();

    // Allow the bridge's change listener callbacks (fire-and-forget applyRemoteChange
    // calls) to complete before asserting on the filesystem state.
    await new Promise((r) => setTimeout(r, 500));

    engine.stop();

    // -- 4. Assert: local-only orphans GONE (root file + bulk-deleted folder) --
    expect(fs.existsSync(orphanPath)).toBe(false);
    expect(fs.existsSync(orphanDir)).toBe(false);

    // -- 5. Assert: excluded path (.obsidian/) untouched --
    expect(fs.existsSync(obsidianFile)).toBe(true);
    expect(fs.readFileSync(obsidianFile, "utf-8")).toBe('{"theme":"default"}');

    // -- 6. Assert: server docs present on disk after pull (root + nested) --
    const pulledFile = path.join(vaultDir, "server-note.md");
    expect(fs.existsSync(pulledFile)).toBe(true);
    expect(fs.readFileSync(pulledFile, "utf-8")).toBe("from server");
    const pulledNested = path.join(vaultDir, "Notes", "server-nested.md");
    expect(fs.existsSync(pulledNested)).toBe(true);

    // -- 7. SERVER SAFETY: the server doc set must be UNCHANGED — the local wipe
    //       must never push deletions upstream. (Re-open the remote handle fresh.)
    const remoteAfter = new PouchDB(remoteUrl);
    const serverIdsAfter = (await (remoteAfter as unknown as PouchDB).allDocs()).rows.map((r) => r.id).sort();
    expect(serverIdsAfter).toEqual(serverIdsBefore);
    expect(serverIdsAfter).toContain("file/server-note.md");
    expect(serverIdsAfter).toContain("file/Notes/server-nested.md");
  }, 30_000);
});
