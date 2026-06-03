/**
 * R1.0 — REAL-ARTIFACT probe: does live db.sync(retry:true) emit `error` on a stall?
 *
 * THE EMPIRICAL QUESTION:
 *   When CouchDB becomes unreachable mid live-sync (after phase-1 has completed and the handle
 *   is fully caught-up / paused), does PouchDB emit `error` on the sync handle?
 *   Does the handle self-resume (without cancel/recreate) when CouchDB comes back?
 *
 * WHY IT MATTERS:
 *   Every #74 resilience unit test manually emits `error` on a mock handle — none proves a real
 *   db.sync produces one. If retry:true swallows error (emitting only paused/active), then the
 *   engine's scheduleRestart("live") is dead code for a stall and the daemon can freeze silently.
 *
 * DESIGN NOTES:
 *   - Must wait for genuine idle (paused with no err + doc_count == expected) before killing couch,
 *     otherwise we re-test the phase-1 race.
 *   - doc_count cannot measure self-resume (already maxed). Uses a canary doc instead:
 *     after docker start, write a canary to local and poll remote — if canary appears without any
 *     handle cancel/recreate, push-side self-resumed.
 *   - ALL events are logged with their full argument payload and relative timestamp.
 *
 * Usage (CouchDB must be running):
 *   node spikes/resilience-verify/verify-live-stall.mjs
 *
 * Env overrides:
 *   SCRATCH_URL=http://smoke:smokepass@localhost:5986
 *   COUCH_CONTAINER=spike-smoke-couchdb
 */

import { spawnSync } from "child_process";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

const SCRATCH = process.env.SCRATCH_URL ?? "http://smoke:smokepass@localhost:5986";
const CONTAINER = process.env.COUCH_CONTAINER ?? "spike-smoke-couchdb";

const DOC_COUNT = 30;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const ts = () => `+${(Date.now() - T0).toString().padStart(6)}ms`;
const log = (msg) => console.log(`[${ts()}] ${msg}`);

function docker(cmd) {
  log(`docker ${cmd} ${CONTAINER}`);
  const result = spawnSync("docker", [cmd, CONTAINER], { timeout: 30_000 });
  const ok = result.status === 0;
  log(`docker ${cmd} ${ok ? "OK" : `FAILED (${result.stderr?.toString()?.trim()})`}`);
  return ok;
}

const _require = createRequire(import.meta.url);
const PouchDB = _require("pouchdb-node");

async function seedRemote(remoteUrl) {
  log(`Seeding ${DOC_COUNT} docs to remote...`);
  const remote = new PouchDB(remoteUrl);
  const docs = [];
  for (let i = 0; i < DOC_COUNT; i++) {
    docs.push({ _id: `note-${i}.md`, content: "x".repeat(200) });
  }
  await remote.bulkDocs(docs);
  const info = await remote.info();
  log(`Remote seeded: ${info.doc_count} docs`);
  return remote;
}

async function main() {
  process.exitCode = 1;

  const suffix = Date.now().toString(36);
  const remoteUrl = `${SCRATCH}/vault-stall-${suffix}`;
  const localDir = `/tmp/vault-stall-${suffix}`;

  // Parse credentials from SCRATCH URL
  const scratchUrl = new URL(SCRATCH);
  const couchBase = `${scratchUrl.protocol}//${scratchUrl.hostname}:${scratchUrl.port}`;
  const remoteWithAuth = (() => {
    const proto = couchBase.startsWith("https://") ? "https://" : "http://";
    const host = couchBase.slice(proto.length);
    const user = scratchUrl.username || "smoke";
    const pass = scratchUrl.password || "smokepass";
    return `${proto}${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}/vault-stall-${suffix}`;
  })();

  let remote;
  let local;
  let syncHandle = null;

  // ── Observation state ──────────────────────────────────────────────────────
  const events = []; // { t, event, argStr }
  let idleConfirmed = false;
  let killTime = null;
  let canarySelfResumed = false;

  function recordEvent(event, arg) {
    const t = Date.now() - T0;
    const argStr = arg instanceof Error
      ? `Error(${arg.message})`
      : arg === undefined || arg === null
        ? "(none)"
        : typeof arg === "object"
          ? JSON.stringify(arg).slice(0, 200)
          : String(arg);
    log(`EVENT [${event}] arg=${argStr}`);
    events.push({ t, event, argStr });
  }

  function attachLiveHandlers(handle) {
    handle.on("change", (info) => {
      const dw = info?.change?.docs_written ?? 0;
      const pending = info?.change?.pending ?? info?.pending ?? "?";
      recordEvent("change", { docs_written: dw, pending });
    });
    handle.on("active", () => recordEvent("active", undefined));
    // Capture paused with full argument — PouchDB may pass an Error here for retry:true stalls
    handle.on("paused", (err) => recordEvent("paused", err));
    handle.on("error", (err) => recordEvent("error", err));
    handle.on("denied", (info) => recordEvent("denied", info));
    handle.on("complete", (info) => recordEvent("complete", info));
  }

  try {
    remote = await seedRemote(remoteUrl);
    local = new PouchDB(localDir);

    // =========================================================
    // PHASE 1: Initial text pull (replicate.from, live:false, retry:false)
    // Mirrors exactly what the engine does before live sync.
    // =========================================================
    log("\n=== PHASE 1: Initial pull (replicate.from, retry:false) ===");

    await new Promise((resolve, reject) => {
      const rep = local.replicate.from(remoteWithAuth, {
        live: false,
        retry: false,
        checkpoint: "target",
      });
      rep.on("complete", () => {
        log("Phase-1 complete");
        resolve();
      });
      rep.on("error", (err) => {
        log(`Phase-1 ERROR: ${err?.message}`);
        reject(err);
      });
    });

    const docsAfterPhase1 = (await local.info()).doc_count;
    log(`Local after phase-1: ${docsAfterPhase1} docs (expected ${DOC_COUNT})`);

    // =========================================================
    // PHASE 2: Start live sync — mirrors engine.startLiveSync()
    // =========================================================
    log("\n=== PHASE 2: Start live sync (db.sync, live:true, retry:true) ===");

    syncHandle = local.sync(remoteWithAuth, { live: true, retry: true });
    attachLiveHandlers(syncHandle);

    // Wait for genuine idle: paused with no-err AND doc_count matches expected.
    log("Waiting for live sync to reach idle (paused, no error)...");

    const idleDeadline = Date.now() + 30_000;
    while (Date.now() < idleDeadline) {
      await sleep(500);
      const info = await local.info();
      const lastPaused = [...events].reverse().find(e => e.event === "paused");
      const cleanPaused = lastPaused && lastPaused.argStr === "(none)";
      if (info.doc_count >= DOC_COUNT && cleanPaused) {
        idleConfirmed = true;
        log(`Idle confirmed: doc_count=${info.doc_count}, last paused=(no-err)`);
        break;
      }
    }

    if (!idleConfirmed) {
      log("WARNING: Could not confirm clean idle before kill. Proceeding (results may overlap phase-1 catchup).");
      await sleep(3000);
    }

    const eventsBeforeKillCount = events.length;
    log(`Events before kill (${eventsBeforeKillCount}): ${events.map(e => e.event).join(", ")}`);

    // =========================================================
    // PHASE 3: Kill CouchDB — simulate connectivity outage
    // =========================================================
    log("\n=== PHASE 3: Kill CouchDB mid live-sync ===");
    killTime = Date.now() - T0;
    docker("stop");

    // Observe for 20s what events fire after the kill
    log("Observing events for 20s after kill...");
    await sleep(20_000);

    const eventsAfterKill = events.slice(eventsBeforeKillCount);
    log(`Events during outage (${eventsAfterKill.length}): ${eventsAfterKill.map(e => `${e.event}(${e.argStr.slice(0, 60)})`).join(", ") || "(none)"}`);

    const errorFiredDuringOutage = eventsAfterKill.some(e => e.event === "error");
    const pausedFiredDuringOutage = eventsAfterKill.some(e => e.event === "paused");
    const pausedWithErrDuringOutage = eventsAfterKill.some(e => e.event === "paused" && e.argStr !== "(none)");

    log(`--- Outage event summary ---`);
    log(`  error fired:        ${errorFiredDuringOutage}`);
    log(`  paused fired:       ${pausedFiredDuringOutage}`);
    log(`  paused(err) fired:  ${pausedWithErrDuringOutage}`);

    // =========================================================
    // PHASE 4: Restore CouchDB — test self-resume via canary doc
    // =========================================================
    log("\n=== PHASE 4: Restart CouchDB — observe self-resume ===");
    docker("start");

    log("Waiting 5s for CouchDB to start...");
    await sleep(5_000);

    // Write a canary doc to LOCAL LevelDB (no couch needed for the write itself).
    // Only a still-active live sync handle can push this to the remote.
    // We do NOT cancel/recreate the handle at any point — that would invalidate the test.
    const canaryId = `canary-recovery-${suffix}`;
    log(`Writing canary doc to LOCAL: ${canaryId}`);
    await local.put({ _id: canaryId, probe: "live-stall-r1.0", ts: Date.now() });

    // Poll the REMOTE via a FRESH connection — if the canary appears, the handle self-pushed.
    log("Polling remote for canary (up to 60s)...");
    const canaryDeadline = Date.now() + 60_000;
    let canaryFoundAt = null;

    while (Date.now() < canaryDeadline) {
      await sleep(2_000);
      try {
        const freshRemote = new PouchDB(remoteWithAuth);
        try {
          const doc = await freshRemote.get(canaryId);
          if (doc) {
            canaryFoundAt = Date.now() - T0;
            canarySelfResumed = true;
            log(`CANARY FOUND on remote at +${canaryFoundAt}ms`);
            break;
          }
        } catch (e) {
          if (e.name !== "not_found") log(`Remote canary check: ${e.name} (${e.message})`);
        } finally {
          try { await freshRemote.close?.(); } catch { /* ignore */ }
        }
      } catch (e) {
        log(`Fresh remote connection failed: ${e.message}`);
      }
    }

    if (!canarySelfResumed) {
      log("Canary NOT found on remote within 60s — handle did NOT self-resume for push.");
    }

    const eventsAfterRecovery = events.slice(eventsBeforeKillCount + eventsAfterKill.length);
    log(`Events after recovery: ${eventsAfterRecovery.map(e => `${e.event}(${e.argStr.slice(0, 60)})`).join(", ") || "(none)"}`);

    // =========================================================
    // VERDICT
    // =========================================================
    log("\n");
    log("=".repeat(60));
    log("VERDICT — R1.0 live db.sync(retry:true) stall probe");
    log("=".repeat(60));
    log(`\nAll events timeline (relative to T0, kill at +${killTime}ms):`);
    for (const e of events) {
      const marker = e.t > killTime ? " ← AFTER KILL" : "";
      log(`  +${String(e.t).padStart(6)}ms  ${e.event.padEnd(10)} ${e.argStr.slice(0, 100)}${marker}`);
    }

    log("\n--- Headline answers ---");
    log(`Q1: Did 'error' fire on live handle during outage?   ${errorFiredDuringOutage ? "YES" : "NO"}`);
    log(`Q2: Did 'paused' fire?                              ${pausedFiredDuringOutage ? "YES" : "NO"}`);
    log(`Q3: Did 'paused(err)' fire?                         ${pausedWithErrDuringOutage ? "YES" : "NO"}`);
    log(`Q4: Did handle self-resume (canary pushed to remote)? ${canarySelfResumed ? "YES (at +" + canaryFoundAt + "ms)" : "NO (60s timeout)"}`);

    log("\n--- RC1 verdict ---");
    if (errorFiredDuringOutage && canarySelfResumed) {
      log("BRANCH A: 'error' fires AND handle self-resumes.");
      log("  → scheduleRestart('live') in the engine IS reachable on a real stall.");
      log("  → The engine's error→scheduleRestart path works for this outage type.");
      log("  SCOPE LIMIT: docker stop = clean TCP reset. See below.");
      process.exitCode = 0;
    } else if (!errorFiredDuringOutage && canarySelfResumed) {
      log("BRANCH C (unlisted in plan): 'error' SWALLOWED, but retry:true self-resumes without intervention.");
      log("  → scheduleRestart('live') is dead code for a clean ECONNREFUSED stall.");
      log("  → PouchDB's retry:true heals the handle autonomously.");
      log("  → For clean TCP outages: no engine intervention needed, and no watchdog needed.");
      log("  SCOPE LIMIT: docker stop is the friendliest outage. See below.");
      process.exitCode = 0;
    } else if (!errorFiredDuringOutage && !canarySelfResumed) {
      log("BRANCH B (plan's silent stall): 'error' swallowed AND handle did NOT self-resume.");
      log("  → SILENT STALL CONFIRMED for a clean ECONNREFUSED outage.");
      log("  → A liveness watchdog (RC1.1) IS warranted.");
      process.exitCode = 0;
    } else {
      // error fired but canary not found
      log("BRANCH D: 'error' fires but handle did NOT self-resume.");
      log("  → The engine's scheduleRestart path IS reachable, but the handle froze afterward.");
      log("  → A watchdog as belt-and-suspenders is warranted.");
      process.exitCode = 0;
    }

    if (!idleConfirmed) {
      log("\nWARNING: Clean idle was not confirmed before kill.");
      log("  Results may reflect live-sync catchup behavior, not idle-live stall behavior.");
    }

    log("\nSCOPE LIMIT (always applies):");
    log("  docker stop = clean TCP reset (ECONNREFUSED immediately). Does NOT reproduce:");
    log("  - Half-open TCP sockets (most common production stall mode)");
    log("  - DNS failure / resolution timeout");
    log("  - WebKit 'Load failed' mode observed in production memory notes");
    log("  A clean self-resume here does NOT refute the stall risk for those harder failure modes.");
    log("  A watchdog remains a safe defence regardless of this result.");

  } catch (err) {
    log(`FATAL: ${err.message}\n${err.stack}`);
    process.exitCode = 3;
  } finally {
    if (syncHandle) {
      try { syncHandle.cancel(); } catch { /* ignore */ }
      syncHandle = null;
    }
    // Always leave CouchDB running
    try { docker("start"); } catch { /* ensure couch is running */ }
    try { await remote?.destroy(); } catch { /* ignore */ }
    try { await local?.destroy(); } catch { /* ignore */ }
    // PouchDB keep-alives may block exit
    setTimeout(() => process.exit(process.exitCode ?? 1), 3000);
  }
}

main();
