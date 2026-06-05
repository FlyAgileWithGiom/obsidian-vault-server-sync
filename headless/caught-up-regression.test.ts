/**
 * Real-CouchDB regression test for the caught-up scenario.
 *
 * Bug: when the initial pull already fetched everything from the server, the live
 * db.sync fires only `active` → `paused` with ZERO `change` events. The old
 * liveSyncPending===0 guard never fires because liveSyncPending stays at
 * PENDING_UNKNOWN (-1), leaving the sync indicator permanently at "Syncing..."/
 * "binary-backfill".
 *
 * Fix: liveSyncContacted flag (set by `active` or `change`) combined with
 * pending-agnostic noOutstandingWork gate lets the paused handler latch ok even
 * when no change event fired.
 *
 * Run gated test:
 *   COUCHDB_URL=http://smoke:smokepass@localhost:5986 npx vitest run headless/caught-up-regression.test.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, afterEach } from "vitest";

const COUCH_URL = process.env["COUCHDB_URL"];

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-sync-caught-up-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Non-critical
    }
  }
  tempDirs.length = 0;
});

describe.skipIf(!COUCH_URL)(
  "caught-up scenario: engine reaches ok/complete after initial pull (real CouchDB)",
  () => {
    const couchBase = COUCH_URL ?? "http://smoke:smokepass@localhost:5986";
    const dbName = `vault-sync-caught-up-test-${Date.now()}`;
    const remoteUrl = `${couchBase}/${dbName}`;

    afterEach(async () => {
      try {
        const PouchDB = require("pouchdb-node") as typeof import("pouchdb-node");
        const remote = new PouchDB(remoteUrl);
        await (remote as unknown as { destroy(): Promise<void> }).destroy();
      } catch {
        // ignore
      }
    });

    it(
      "engine reaches state='ok' and syncPhase='complete' when already caught up",
      async () => {
        const PouchDB = require("pouchdb-node") as typeof import("pouchdb-node");
        const { PouchDbFsBridge } = await import("../src/PouchDbFsBridge");
        const { PouchDbSyncEngine } = await import("../src/PouchDbSyncEngine");
        const { FilesystemVaultAdapter } = await import("./VaultAdapter");
        const { FsWatcher } = await import("./FsWatcher");

        // -- 1. Seed a couple of docs in the remote CouchDB --
        const remote = new PouchDB(remoteUrl);
        await (remote as unknown as PouchDB).put({
          _id: "file/note-a.md",
          content: "Note A",
          mtime: 1000,
        });
        await (remote as unknown as PouchDB).put({
          _id: "file/note-b.md",
          content: "Note B",
          mtime: 2000,
        });

        // -- 2. Set up vault dir and local PouchDB --
        const vaultDir = makeTempDir();
        const pouchDir = makeTempDir();

        const settings = {
          couchDbUrl: couchBase,
          couchDbName: dbName,
          couchDbUser: "",
          couchDbPassword: "",
          excludePatterns: [],
        };

        const vaultAdapter = new FilesystemVaultAdapter(vaultDir);
        let callCount = 0;
        const dbFactory = () => {
          callCount++;
          return new PouchDB(pouchDir) as unknown as import("../src/pouchdb-browser").default;
        };
        const db = dbFactory();
        const bridge = new PouchDbFsBridge(vaultAdapter, db as never);

        // Start the bridge with a real FsWatcher so the PouchDB changes listener fires.
        const fsWatcher = new FsWatcher(vaultDir, []);
        bridge.start(fsWatcher);

        const engine = new PouchDbSyncEngine(
          settings,
          db as never,
          bridge as never,
          dbFactory as never,
        );

        // -- 3. Start the engine (doc_count=0 → runs initial pull first) --
        engine.start();

        // -- 4. Poll until state=ok or timeout --
        // The initial pull fetches all docs (caught-up before live sync starts).
        // The subsequent live db.sync should then fire active→paused and latch ok.
        const deadline = Date.now() + 20_000;
        let finalDiag = engine.getDiagnostics();
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200));
          finalDiag = engine.getDiagnostics();
          if (finalDiag.state === "ok") break;
        }

        engine.stop();

        // -- 5. Assert: engine reached ok/complete (not stuck on syncing/binary-backfill) --
        expect(finalDiag.state).toBe("ok");
        expect(finalDiag.syncPhase).toBe("complete");
      },
      30_000,
    );
  },
);
