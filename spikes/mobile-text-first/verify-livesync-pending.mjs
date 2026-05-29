// REAL-engine verification for the startLiveSync pending-field blocker (Refs #72).
//
// Unlike the sibling verify-*.mjs harnesses (which re-implement the engine's replication
// shape inline), this drives the ACTUAL PouchDbSyncEngine — bundled on the fly via esbuild,
// the same way dist/headless.js is built — against a REAL writable CouchDB with a binary
// backlog large enough to force intermediate db.sync `change` events carrying pending>0.
//
// Why a real CouchDB and not two local LevelDB dirs: empirically, LevelDB-to-LevelDB
// db.sync leaves info.change.pending UNDEFINED (the pending count is a CouchDB _changes
// server feature; local-to-local replication does not compute it). So the nested-pending
// signal — the whole discriminator — only appears against a real couch. That is also why
// this lives here as a runnable harness, not as a vitest suite member: it requires the
// smoke couch, and a suite test that skips-when-unreachable would be green-but-blind
// (forbidden by the project's testing-standards). The portable CI regression guard is the
// unit test in src/PouchDbSyncEngine.test.ts (nested-shape mock, proven RED before the fix).
//
// THE DISCRIMINATOR: maxPendingObserved must be > 0. On the buggy FLAT read
// (this.liveSyncPending = info.pending ?? 0) it is ALWAYS 0 (info.pending is undefined on
// db.sync changes); on the fixed NESTED read (info.change?.pending ?? info.pending ?? 0) it
// takes real nonzero values during backfill. Confirmed RED (maxPendingObserved=0) against
// the reverted buggy engine and GREEN (>0) against the fix.
//
// Usage (writable LOCAL smoke couch only — never prod; db.sync writes + checkpoints):
//   export SMOKE_COUCH_URL="http://smoke:smokepass@localhost:5986"
//   node spikes/mobile-text-first/verify-livesync-pending.mjs

import esbuild from "esbuild";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const SMOKE_COUCH_URL = process.env.SMOKE_COUCH_URL ?? "http://smoke:smokepass@localhost:5986";

const TEXT_DOC_COUNT = 40;
// A few hundred binaries so the pull backlog exceeds one replication batch and db.sync emits
// intermediate `change` events with pending>0 (the probe saw a single pending=0 change for 60).
const BINARY_DOC_COUNT = 400;
const ATTACHMENT_BYTES = 24 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bundleEngine() {
  // Bundle the engine to a temp CJS file. `obsidian` is externalized exactly as the headless
  // daemon build does (esbuild.config.mjs): the engine's obsidian usage is confined to
  // register()/ObsidianVaultWatcher, which this harness never calls. pouchdb-node is injected.
  const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "engine-bundle-")), "engine.cjs");
  await esbuild.build({
    entryPoints: [path.join(REPO, "src/PouchDbSyncEngine.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    outfile,
    external: ["obsidian", "pouchdb-browser", "pouchdb-node", "leveldown", "fsevents"],
    logLevel: "warning",
  });
  return outfile;
}

async function main() {
  const PouchDB = (await import("pouchdb-node")).default;

  // Reachability probe via PouchDB (Node fetch rejects URLs with embedded credentials).
  try {
    await new PouchDB(`${SMOKE_COUCH_URL}/_users`).info();
  } catch {
    console.error(`FATAL: CouchDB not reachable at ${SMOKE_COUCH_URL}. Start the smoke couch and retry.`);
    process.exit(2);
  }

  const bundlePath = await bundleEngine();
  const { PouchDbSyncEngine } = await import(pathToFileURL(bundlePath).href);

  const remoteName = `vault-verify-pending-${Date.now().toString(36)}`;
  const remoteUrl = `${SMOKE_COUCH_URL}/${remoteName}`;
  const remote = new PouchDB(remoteUrl);
  const localDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-verify-local-"));
  const localDb = new PouchDB(localDir);

  try {
    // Seed the throwaway remote: text docs (phase-1) + binary docs (the backfill).
    const text = [];
    for (let i = 0; i < TEXT_DOC_COUNT; i++) text.push({ _id: `note-${i}.md`, content: "x".repeat(400) });
    await remote.bulkDocs(text);
    const buf = Buffer.alloc(ATTACHMENT_BYTES, 7);
    for (let i = 0; i < BINARY_DOC_COUNT; i++) {
      await remote.put({
        _id: `asset-${i}.bin`,
        _attachments: { "d.bin": { content_type: "application/octet-stream", data: buf.toString("base64") } },
      });
    }

    const settings = {
      couchDbUrl: SMOKE_COUCH_URL,
      couchDbName: remoteName,
      couchDbUser: "",
      couchDbPassword: "",
      syncDebounceMs: 500,
      excludePatterns: [],
    };
    // Bridge is never started (we don't call register()), so a stub suffices.
    const stubBridge = { start() {}, stop() {}, setDb() {} };
    const engine = new PouchDbSyncEngine(settings, localDb, stubBridge);

    // start(): empty local db -> phase-1 text pull (selector) -> startLiveSync() backfill.
    await engine.start();

    let maxPendingObserved = -1;
    let okWhileBinariesPending = false;
    for (let i = 0; i < 200; i++) {
      await sleep(100);
      const pending = engine.liveSyncPending; // private field, read directly for verification
      if (pending > maxPendingObserved) maxPendingObserved = pending;
      const diag = engine.getDiagnostics();
      const localBinaries = (await localDb.allDocs({ include_docs: true })).rows
        .filter((r) => r.doc && r.doc._attachments).length;
      if (localBinaries < BINARY_DOC_COUNT && (diag.state === "ok" || diag.syncPhase === "complete")) {
        okWhileBinariesPending = true;
      }
      if (localBinaries >= BINARY_DOC_COUNT && diag.syncPhase === "complete") break;
    }
    engine.stop();

    const finalLocalBinaries = (await localDb.allDocs({ include_docs: true })).rows
      .filter((r) => r.doc && r.doc._attachments).length;
    const finalDiag = engine.getDiagnostics();

    console.log(`\n--- verify-livesync-pending results ---`);
    console.log(`maxPendingObserved      = ${maxPendingObserved}   (DISCRIMINATOR: must be > 0; buggy flat read => 0)`);
    console.log(`okWhileBinariesPending  = ${okWhileBinariesPending}   (must be false: never "Synced" mid-backfill)`);
    console.log(`finalLocalBinaries      = ${finalLocalBinaries} / ${BINARY_DOC_COUNT}`);
    console.log(`final syncPhase / state = ${finalDiag.syncPhase} / ${finalDiag.state}   (must be complete / ok)`);

    const pass =
      maxPendingObserved > 0 &&
      okWhileBinariesPending === false &&
      finalLocalBinaries === BINARY_DOC_COUNT &&
      finalDiag.syncPhase === "complete" &&
      finalDiag.state === "ok";
    console.log(pass ? "\nPASS: engine read real pending>0 via nested shape; no premature 'Synced'." : "\nFAIL");
    process.exitCode = pass ? 0 : 1;
  } finally {
    await remote.destroy().catch(() => {});
    await localDb.destroy().catch(() => {});
    try { fs.rmSync(localDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

main().catch((e) => { console.error("FATAL:", e.message, e.stack); process.exit(3); });
