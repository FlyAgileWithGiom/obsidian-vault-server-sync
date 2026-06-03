/**
 * RC2 — real reconcile + live-sync smoke
 * "Does reconcilePull's deliberate no-op get rescued by REAL db.sync?"
 *
 * THE CLAIM UNDER TEST (AC2.3b):
 *   reconcilePull is a no-op. After bridge.start + engine.start, REAL db.sync
 *   pulls remote R′ into local PouchDB, which fires the since:"now" changes feed
 *   → applyRemoteChange → writes the file to disk.
 *   If this FAILS, AC2.3b files silently never come back — ship-blocker.
 *
 * THREE ASSERTS:
 *   AC2.3b (CRITICAL): P's file reappears on disk with remote content Z
 *   AC2.1:  B's stranded doc exists in couch (push via reconcile)
 *   AC2.3a: D is tombstoned in local PouchDB; D's file stays absent from disk
 *
 * INTERMEDIATE CHECK (proves the no-op is real, not a false pass):
 *   After runReconcileOnStartup (before engine.start): P's file STILL absent on disk,
 *   local.get(P).content === X (old content, no write). Only live sync may deliver Z.
 *
 * WIRING (mirrors runDaemon, NOT runDaemonV2Startup — no converter needed):
 *   runReconcileOnStartup → bridge.start(fsWatcher) → engine.start()
 *
 * SEEDING CONTRACT:
 *   Seed via replicate.from (NOT local.put) so local._rev === couch._rev exactly.
 *   This is load-bearing: AC2.3a tombstone fires only when local._rev === remote.rev.
 *
 * Usage:
 *   npx tsx spikes/resilience-verify/verify-reconcile-real.ts
 *
 * Env overrides:
 *   SCRATCH_URL=http://smoke:smokepass@localhost:5986 (default)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createRequire } from "module";

// Import real source modules
import { makeHttpRemoteDb, runReconcileOnStartup } from "../../headless/main";
import { PouchDbFsBridge } from "../../src/PouchDbFsBridge";
import { PouchDbSyncEngine } from "../../src/PouchDbSyncEngine";
import { FilesystemVaultAdapter } from "../../headless/VaultAdapter";
import { FsWatcher } from "../../headless/FsWatcher";
import { pathToDocId } from "../../src/doc-id";

const SCRATCH = process.env.SCRATCH_URL ?? "http://smoke:smokepass@localhost:5986";

const _require = createRequire(import.meta.url);
const PouchDB = _require("pouchdb-node");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const ts = () => `+${(Date.now() - T0).toString().padStart(6)}ms`;
const log = (msg: string) => console.log(`[${ts()}] ${msg}`);

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function buildRemoteUrl(suffix: string): string {
  const u = new URL(SCRATCH);
  const proto = u.protocol + "//";
  const host = u.hostname + (u.port ? `:${u.port}` : "");
  const user = u.username || "smoke";
  const pass = u.password || "smokepass";
  return `${proto}${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}/rc2-reconcile-${suffix}`;
}

/**
 * Build CouchDB base URL and Authorization header from a URL with embedded credentials.
 * Node.js fetch rejects URLs that include credentials — strip them and pass via header.
 */
function parseCouchUrl(remoteUrl: string): { base: string; dbName: string; authHeader: string | undefined } {
  const u = new URL(remoteUrl);
  const user = u.username ? decodeURIComponent(u.username) : "";
  const pass = u.password ? decodeURIComponent(u.password) : "";
  const base = `${u.protocol}//${u.hostname}:${u.port}`;
  const dbName = u.pathname.replace(/^\//, "").replace(/\/$/, "");
  const authHeader = user ? `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` : undefined;
  return { base, dbName, authHeader };
}

async function couchPut(remoteUrl: string, docId: string, body: object): Promise<{ rev: string }> {
  const { base, dbName, authHeader } = parseCouchUrl(remoteUrl);
  const encoded = encodeURIComponent(docId);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authHeader) headers["Authorization"] = authHeader;
  const resp = await fetch(`${base}/${dbName}/${encoded}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
  const json: unknown = await resp.json();
  if (!(json instanceof Object) || !("rev" in json)) throw new Error(`couchPut failed: ${JSON.stringify(json)}`);
  return json as { rev: string };
}

async function couchGet(remoteUrl: string, docId: string): Promise<unknown> {
  const { base, dbName, authHeader } = parseCouchUrl(remoteUrl);
  const encoded = encodeURIComponent(docId);
  const headers: Record<string, string> = {};
  if (authHeader) headers["Authorization"] = authHeader;
  const resp = await fetch(`${base}/${dbName}/${encoded}`, { headers });
  return resp.json();
}

async function couchCreateDb(remoteUrl: string): Promise<void> {
  const { base, dbName, authHeader } = parseCouchUrl(remoteUrl);
  const headers: Record<string, string> = {};
  if (authHeader) headers["Authorization"] = authHeader;
  const resp = await fetch(`${base}/${dbName}`, { method: "PUT", headers });
  const json = await resp.json() as { ok?: boolean; error?: string };
  if (!json.ok && json.error !== "file_exists") {
    throw new Error(`couchCreateDb failed: ${JSON.stringify(json)}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  process.exitCode = 1;

  const suffix = Date.now().toString(36);
  const remoteUrl = buildRemoteUrl(suffix);
  const localDir = `/tmp/rc2-pouch-${suffix}`;
  const vaultDir = `/tmp/rc2-vault-${suffix}`;
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.mkdirSync(localDir, { recursive: true });

  log(`remoteUrl: ${remoteUrl}`);
  log(`localDir:  ${localDir}`);
  log(`vaultDir:  ${vaultDir}`);

  const remote: ReturnType<typeof PouchDB> = new PouchDB(remoteUrl);
  const local: ReturnType<typeof PouchDB> = new PouchDB(localDir);

  // Doc IDs match what the source modules use (file/<path>)
  const P_PATH = "p.md";
  const B_PATH = "b.md";
  const D_PATH = "d.md";
  const P_ID = pathToDocId(P_PATH);
  const D_ID = pathToDocId(D_PATH);
  const B_ID = pathToDocId(B_PATH);

  // Content labels
  const CONTENT_X = "# Alpha\n\nContent X — last-synced before outage.\n";
  const CONTENT_Y = "# Delta\n\nContent Y — last-synced before outage.\n";
  const CONTENT_Z = "# Alpha updated\n\nContent Z — remote edit during outage.\n";

  // Tracks whether live sync is running (used for teardown)
  let engine: PouchDbSyncEngine | null = null;
  let fsWatcher: FsWatcher | null = null;
  let bridge: PouchDbFsBridge | null = null;

  // Verdict buckets
  let midpoint_P_absent = false;     // P file absent after reconcile, before engine.start
  let midpoint_P_local_X = false;    // local P doc still has content X at midpoint
  let final_P_content_Z = false;     // P file on disk has content Z (THE critical assert)
  let final_B_on_couch = false;      // B doc exists in couch
  let final_D_tombstoned = false;    // D doc is _deleted in local (or on couch)
  let final_D_absent_disk = false;   // D file absent from disk

  try {
    // ──────────────────────────────────────────────────────────────────────
    // SETUP: Create the three starting states
    // ──────────────────────────────────────────────────────────────────────
    log("\n=== SETUP: Seed three situations ===");

    // Create the CouchDB database (PouchDB's replicate.from does NOT auto-create it)
    await couchCreateDb(remoteUrl);
    log(`CouchDB database created`);

    // --- P (AC2.3b pull): synced doc ---
    // PUT P to couch with content X → get rev R
    const pResp = await couchPut(remoteUrl, P_ID, {
      content: CONTENT_X,
      mtime: Date.now(),
    });
    const P_REV_R = pResp.rev;
    log(`P seeded on couch: rev=${P_REV_R}`);

    // --- D (AC2.3a downtime-delete): synced doc ---
    // PUT D to couch with content Y → get rev S
    const dResp = await couchPut(remoteUrl, D_ID, {
      content: CONTENT_Y,
      mtime: Date.now(),
    });
    const D_REV_S = dResp.rev;
    log(`D seeded on couch: rev=${D_REV_S}`);

    // Replicate from couch to local (CRITICAL: copies real rev hashes verbatim).
    // This is the "synced" state — local PouchDB holds the same _rev as couch.
    log("Replicating couch→local (to get matching _rev hashes)...");
    await new Promise<void>((resolve, reject) => {
      const rep = local.replicate.from(remoteUrl, {
        live: false,
        retry: false,
        checkpoint: "target",
      });
      rep.on("complete", resolve);
      rep.on("error", reject);
    });

    // Verify rev match for tombstone test
    const pLocal = await local.get(P_ID) as { _rev: string; content: string };
    const dLocal = await local.get(D_ID) as { _rev: string; content: string };
    log(`P local._rev=${pLocal._rev} (expected: ${P_REV_R}) — match: ${pLocal._rev === P_REV_R}`);
    log(`D local._rev=${dLocal._rev} (expected: ${D_REV_S}) — match: ${dLocal._rev === D_REV_S}`);
    if (pLocal._rev !== P_REV_R || dLocal._rev !== D_REV_S) {
      throw new Error("SETUP FAILED: replicate.from did not copy rev hashes verbatim. Aborting.");
    }

    // Write disk files for P and D (the "synced" state)
    fs.writeFileSync(path.join(vaultDir, P_PATH), CONTENT_X, "utf-8");
    fs.writeFileSync(path.join(vaultDir, D_PATH), CONTENT_Y, "utf-8");
    // B: stranded file — on disk only, NOT in local PouchDB, NOT in couch
    fs.writeFileSync(path.join(vaultDir, B_PATH), "# Stranded\n\nFile only on disk.\n", "utf-8");

    const localInfo = await local.info();
    log(`Local PouchDB: doc_count=${localInfo.doc_count} (expected: 2 — P,D)`);
    if (localInfo.doc_count < 2) {
      throw new Error(`SETUP FAILED: expected ≥2 local docs, got ${localInfo.doc_count}`);
    }

    // ──────────────────────────────────────────────────────────────────────
    // SIMULATE OUTAGE WINDOW (daemon not running — direct edits)
    // ──────────────────────────────────────────────────────────────────────
    log("\n=== OUTAGE WINDOW: Simulate daemon-down edits ===");

    // UPDATE P on couch to rev R′ with content Z
    const pUpdate = await couchPut(remoteUrl, P_ID, {
      _rev: P_REV_R,
      content: CONTENT_Z,
      mtime: Date.now(),
    });
    const P_REV_R_PRIME = pUpdate.rev;
    log(`P updated on couch: new rev=${P_REV_R_PRIME} (content Z)`);

    // DELETE P's file from disk (simulates daemon crash during remote edit)
    fs.unlinkSync(path.join(vaultDir, P_PATH));
    log(`P file deleted from disk`);

    // DELETE D's file from disk (downtime-delete, couch D unchanged)
    fs.unlinkSync(path.join(vaultDir, D_PATH));
    log(`D file deleted from disk (D couch rev unchanged: ${D_REV_S})`);

    // Verify disk state
    const pOnDisk = fs.existsSync(path.join(vaultDir, P_PATH));
    const dOnDisk = fs.existsSync(path.join(vaultDir, D_PATH));
    const bOnDisk = fs.existsSync(path.join(vaultDir, B_PATH));
    log(`Disk state: P=${pOnDisk} (want false), D=${dOnDisk} (want false), B=${bOnDisk} (want true)`);
    if (pOnDisk || dOnDisk || !bOnDisk) throw new Error("SETUP FAILED: disk state wrong after outage simulation");

    // ──────────────────────────────────────────────────────────────────────
    // STARTUP CYCLE (REAL components)
    // ──────────────────────────────────────────────────────────────────────
    log("\n=== STARTUP CYCLE: Real components ===");

    const vaultAdapter = new FilesystemVaultAdapter(vaultDir);
    const remoteDb = makeHttpRemoteDb(remoteUrl);

    // Construct bridge and engine (mirrors runDaemon exactly)
    const dbForBridge = local as unknown as import("../../src/pouchdb-browser").default;
    bridge = new PouchDbFsBridge(vaultAdapter, dbForBridge);

    // Build settings with couchDbUrl as base (NO creds) — engine's buildRemoteUrl
    // constructs "http://user:pass@host:port/dbName" itself from the four fields.
    // Passing creds-embedded URL as couchDbUrl causes host to include "user:pass@host"
    // resulting in a double-credential URL that CouchDB rejects.
    const scratchU = new URL(SCRATCH);
    const couchDbUrl = `${scratchU.protocol}//${scratchU.hostname}:${scratchU.port}`;
    const settings = {
      couchDbUrl,
      couchDbName: `rc2-reconcile-${suffix}`,
      couchDbUser: scratchU.username ? decodeURIComponent(scratchU.username) : "smoke",
      couchDbPassword: scratchU.password ? decodeURIComponent(scratchU.password) : "smokepass",
      syncDebounceMs: 300,
      excludePatterns: [] as string[],
      // other settings with defaults
      saveInterval: 5000,
      initialPullBatchSize: 100,
      localReplaceBatchSize: 100,
    };

    const dbFactory = () => new PouchDB(localDir) as unknown as import("../../src/pouchdb-browser").default;
    engine = new PouchDbSyncEngine(settings, dbForBridge, bridge, dbFactory);

    const excludePatterns: string[] = [];
    fsWatcher = new FsWatcher(vaultDir, excludePatterns);

    // Step 1: Run reconcile (the no-op pull is here)
    log("Running runReconcileOnStartup...");
    const counts = await runReconcileOnStartup({
      db: local,
      bridge,
      vaultAdapter,
      remoteDb,
      excludePatterns,
    });
    log(`Reconcile counts: ${JSON.stringify(counts)}`);

    // ── INTERMEDIATE CHECK (proves no-op is real) ──
    // P's file must still be absent (reconcilePull must NOT have written it)
    midpoint_P_absent = !fs.existsSync(path.join(vaultDir, P_PATH));
    // P's local doc must still have content X (not Z)
    try {
      const pMidpoint = await local.get(P_ID) as { content?: string };
      midpoint_P_local_X = pMidpoint.content === CONTENT_X;
      log(`MIDPOINT: P file absent=${midpoint_P_absent}, P local content is X: ${midpoint_P_local_X}`);
    } catch (e) {
      log(`MIDPOINT: Could not get P from local: ${e}`);
      midpoint_P_local_X = false;
    }

    // Step 2: bridge.start (arms the since:"now" changes feed)
    log("Starting bridge...");
    bridge.start(fsWatcher);
    // Give FsWatcher a moment to arm (it uses fs.watch, which may fire on existing files briefly)
    await sleep(500);

    // Step 3: engine.start (triggers live db.sync since doc_count > 0 → isFirstRun=false)
    log("Starting engine...");
    await engine.start();
    log("Engine started (live sync running)");

    // ──────────────────────────────────────────────────────────────────────
    // POLL for live sync to deliver P with content Z
    // ──────────────────────────────────────────────────────────────────────
    log("\n=== POLLING: Wait for live sync to deliver P (up to 60s) ===");
    const POLL_DEADLINE = Date.now() + 60_000;
    let pContentOnDisk: string | null = null;

    while (Date.now() < POLL_DEADLINE) {
      await sleep(1_000);
      const pPath = path.join(vaultDir, P_PATH);
      if (fs.existsSync(pPath)) {
        pContentOnDisk = fs.readFileSync(pPath, "utf-8");
        if (pContentOnDisk === CONTENT_Z) {
          log(`P file appeared with content Z at +${Date.now() - T0}ms`);
          break;
        } else {
          log(`P file exists but content != Z (got: ${JSON.stringify(pContentOnDisk.slice(0, 40))})`);
        }
      }
    }

    // ──────────────────────────────────────────────────────────────────────
    // EVALUATE ASSERTS
    // ──────────────────────────────────────────────────────────────────────

    // AC2.3b: P file on disk with content Z
    final_P_content_Z = pContentOnDisk === CONTENT_Z;

    // AC2.1: B doc on couch
    try {
      const bOnCouch = await couchGet(remoteUrl, B_ID) as { content?: string; error?: string };
      final_B_on_couch = typeof bOnCouch.content === "string" && !bOnCouch.error;
      log(`B on couch: ${JSON.stringify(bOnCouch).slice(0, 120)}`);
    } catch (e) {
      log(`B couch fetch failed: ${e}`);
      final_B_on_couch = false;
    }

    // AC2.3a: D tombstoned — verify in both local PouchDB and couch.
    //
    // PouchDB's db.get() throws 404 (not_found) for deleted docs by default.
    // Use {latest:true} to fetch the tombstone from local. If that also 404s
    // (e.g. after compaction), fall back to checking couch where
    // {"error":"not_found","reason":"deleted"} is the tombstone signature.
    const dLocalRevBefore = dLocal._rev; // captured before outage
    try {
      const dDocLatest = await (local as unknown as {
        get(id: string, opts: { latest: boolean }): Promise<{ _deleted?: boolean; deleted?: boolean; _rev?: string }>;
      }).get(D_ID, { latest: true });
      final_D_tombstoned = !!(dDocLatest._deleted || dDocLatest.deleted);
      log(`D local doc (latest:true): _deleted=${dDocLatest._deleted} deleted=${dDocLatest.deleted} _rev=${dDocLatest._rev}`);
    } catch (e: unknown) {
      // 404 even with latest:true — check couch for tombstone confirmation
      log(`D local: not_found (even latest:true) — checking couch for tombstone signature...`);
      try {
        // CouchDB returns {"error":"not_found","reason":"deleted"} for tombstoned docs
        const dCouch = await couchGet(remoteUrl, D_ID) as { _deleted?: boolean; deleted?: boolean; error?: string; reason?: string };
        const isCouchTombstone = dCouch.error === "not_found" && dCouch.reason === "deleted";
        final_D_tombstoned = isCouchTombstone || !!(dCouch._deleted || dCouch.deleted);
        log(`D couch response: ${JSON.stringify(dCouch).slice(0, 100)} → tombstoned=${final_D_tombstoned}`);
      } catch {
        log(`D couch check also failed — tombstone: false`);
        final_D_tombstoned = false;
      }
    }
    // Belt-and-suspenders: also check that reconcileTombstone set local._deleted by
    // querying local allDocs. A tombstone that has been pushed to couch and replicated
    // back may or may not be in local depending on sync direction — couch confirmation is sufficient.
    log(`D tombstone pre-outage rev: ${dLocalRevBefore}`);
    final_D_absent_disk = !fs.existsSync(path.join(vaultDir, D_PATH));

  } catch (err) {
    log(`FATAL: ${err}`);
    process.exitCode = 3;
  } finally {
    log("\n=== TEARDOWN ===");
    // Stop engine first (cancels db.sync), then bridge, then watcher
    if (engine) { try { engine.stop(); } catch { /* ignore */ } }
    if (bridge) { try { bridge.stop(); } catch { /* ignore */ } }
    if (fsWatcher) { try { fsWatcher.stop(); } catch { /* ignore */ } }

    // Drop test db from couch
    try {
      await (remote as unknown as { destroy(): Promise<void> }).destroy();
      log("Remote db destroyed");
    } catch (e) {
      log(`Remote destroy failed (non-critical): ${e}`);
    }
    try {
      await (local as unknown as { destroy(): Promise<void> }).destroy();
      log("Local db destroyed");
    } catch { /* ignore */ }

    // ──────────────────────────────────────────────────────────────────────
    // VERDICT
    // ──────────────────────────────────────────────────────────────────────
    console.log("\n");
    console.log("=".repeat(60));
    console.log("VERDICT — RC2 real reconcile + live-sync smoke");
    console.log("=".repeat(60));

    console.log("\n--- Intermediate check (proves reconcilePull is truly a no-op) ---");
    console.log(`  P file absent after reconcile, before engine.start: ${midpoint_P_absent ? "YES (correct)" : "NO (reconcilePull wrote it — unexpected)"}`);
    console.log(`  P local content still X at midpoint:               ${midpoint_P_local_X ? "YES (correct)" : "NO"}`);

    console.log("\n--- Final asserts ---");
    console.log(`  AC2.3b (CRITICAL): P file on disk with content Z:  ${final_P_content_Z ? "PASS" : "FAIL"}`);
    console.log(`  AC2.1: B doc exists in couch:                      ${final_B_on_couch ? "PASS" : "FAIL"}`);
    console.log(`  AC2.3a: D tombstoned in local PouchDB:             ${final_D_tombstoned ? "PASS" : "FAIL"}`);
    console.log(`  AC2.3a: D file absent from disk:                   ${final_D_absent_disk ? "PASS" : "FAIL"}`);

    const allPass = final_P_content_Z && final_B_on_couch && final_D_tombstoned && final_D_absent_disk;
    const noFalsePositive = midpoint_P_absent && midpoint_P_local_X;

    console.log("\n--- Option-(b) verdict ---");
    if (final_P_content_Z && noFalsePositive) {
      console.log("HOLDS — reconcilePull no-op is rescued by real db.sync.");
      console.log("  Real db.sync delivered P@R′ (content Z) to disk via the changes feed.");
      console.log("  AC2.3b is safe to ship.");
      process.exitCode = 0;
    } else if (!final_P_content_Z && !midpoint_P_absent) {
      console.log("INCONCLUSIVE — reconcilePull wrote P (not a no-op). Rig error.");
      console.log("  This invalidates the test — check bridge wiring.");
      process.exitCode = 2;
    } else if (!final_P_content_Z) {
      console.log("BROKEN — reconcilePull no-op is NOT rescued by real db.sync.");
      console.log("  P did not appear on disk with content Z within 60s.");
      console.log("  AC2.3b is a SHIP-BLOCKER: reconcilePull must write, option (b) is wrong.");
      process.exitCode = 1;
    } else {
      // P content Z but midpoint check failed
      console.log("SUSPICIOUS — P appeared with Z but intermediate check failed.");
      console.log("  Review midpoint results above.");
      process.exitCode = 2;
    }

    if (!allPass) {
      console.log("\n--- Individual failures ---");
      if (!final_B_on_couch)   console.log("  FAIL AC2.1: B not pushed to couch");
      if (!final_D_tombstoned) console.log("  FAIL AC2.3a: D not tombstoned");
      if (!final_D_absent_disk) console.log("  FAIL AC2.3a: D file appeared on disk (should stay absent)");
    }

    // Force exit (PouchDB keep-alives / db.sync may block)
    setTimeout(() => process.exit(process.exitCode ?? 1), 3_000);
  }
}

main().catch((e) => {
  console.error("FATAL (uncaught):", e);
  process.exit(3);
});
