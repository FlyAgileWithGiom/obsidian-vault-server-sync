// c5 real-artifact verification (Refs #72, plan section 7).
//
// A vitest CANNOT prove the bandwidth saving: a mocked PouchDB returns whatever the mock
// returns. The ship-blocking question -- "does the wire carry tens of MB, not 8 GB?" -- is
// only answerable against the REAL artifact. This script runs the decisive measurements and
// EXITS NON-ZERO on failure, so it is a runnable proof rather than a numbers dump (which is
// why it lives in spikes/ and not in the vitest suite: it hits prod read-only, is slow
// ~10-20 min, and is network-dependent).
//
// It drives the production-mirroring REPLICATION PATH (scratch.replicate.from(remote,
// {selector, checkpoint:'target'})) -- the exact call shape PouchDbSyncEngine.runInitialPull
// issues -- not a bespoke probe. Wire bytes are summed via a fetch wrapper on the remote.
//
// Usage:
//   export PROD_URL="https://livesync:...@sync.fly-agile.com/vault-obsidiannotes"   # READ-ONLY
//   export SCRATCH_URL="http://smoke:smokepass@localhost:5986"                       # writable
//   node verify-c5.mjs            # runs all checks
//   node verify-c5.mjs phase1     # just the phase-1 wire-byte + zero-attachments check
//   node verify-c5.mjs revsdiff   # just the Pattern B revs_diff economy gate
//
// Checks (each prints PASS/FAIL and the measured number it asserts on):
//   1. phase-1 wire bytes are tens of MB, ORDERS OF MAGNITUDE below 8 GB.
//   2. scratch DB after phase-1 holds ZERO docs with _attachments (server-side filter real).
//   3. Pattern B gate: a re-pull against a text-seeded DB does NOT re-download text bodies
//      (revs_diff economy) -- if this FAILS, c2 must switch to Pattern A.

import PouchDB from "pouchdb-node";

const PROD = process.env.PROD_URL;
const SCRATCH = process.env.SCRATCH_URL;
const which = process.argv[2] || "all";

if (!PROD || !SCRATCH) {
  console.error("Set PROD_URL (read-only) and SCRATCH_URL (writable) env vars");
  process.exit(2);
}

const TEXT_SELECTOR = { _attachments: { $exists: false } };

// Thresholds. The DB file is 8.59 GB; phase-1 measured 64 MB in the spike. A 512 MB ceiling
// is ~17x the spike result yet ~17x BELOW the full DB -- a generous band that still fails
// loudly if server-side filtering ever breaks and the wire carries the whole vault.
const PHASE1_WIRE_CEILING_MB = 512;
const FULL_DB_FLOOR_MB = 2000; // a "filter broke" pull would exceed this; phase-1 must not.
// Re-pull doc-body ceiling: revs already local should cost revs_diff/changes METADATA only.
// A handful of live edits between seed and re-pull may bring a few real bodies; 5 MB is a
// safe ceiling vs the 56.8 MB of text bodies a full re-download would carry.
const REVSDIFF_BULKGET_CEILING_MB = 5;

let wireBytes = 0;
let bulkGetBytes = 0;
let bulkGetCalls = 0;

function resetCounters() { wireBytes = 0; bulkGetBytes = 0; bulkGetCalls = 0; }

function countingFetch(url, opts) {
  const u = typeof url === "string" ? url : url.url;
  const isBulkGet = /_bulk_get/.test(u);
  if (isBulkGet) bulkGetCalls++;
  return PouchDB.fetch(url, opts).then((res) => {
    const cl = res.headers.get("content-length");
    if (cl) {
      const n = parseInt(cl, 10);
      wireBytes += n;
      if (isBulkGet) bulkGetBytes += n;
      return res;
    }
    return res.clone().arrayBuffer().then((buf) => {
      wireBytes += buf.byteLength;
      if (isBulkGet) bulkGetBytes += buf.byteLength;
      return res;
    });
  });
}

const mb = (b) => +(b / 1e6).toFixed(2);

function pull(scratch, remote, opts, label) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const rep = scratch.replicate.from(remote, opts);
    rep.on("change", (info) => {
      const t = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`  [${label}] docs_written=${info.docs_written} pending=${info.pending} wire=${mb(wireBytes)}MB bulkGet=${mb(bulkGetBytes)}MB t=${t}s`);
    });
    rep.on("complete", (info) => resolve(info));
    rep.on("error", (e) => reject(e));
  });
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}  --  ${detail}`);
}

async function countAttachmentDocs(scratch) {
  // Page through allDocs and count docs whose stored value carries _attachments.
  const res = await scratch.allDocs({ include_docs: true });
  return res.rows.filter((r) => r.doc && r.doc._attachments).length;
}

async function phase1Check() {
  const name = "vault-c5-phase1";
  await new PouchDB(`${SCRATCH}/${name}`).destroy().catch(() => {});
  const scratch = new PouchDB(`${SCRATCH}/${name}`);
  const remote = new PouchDB(PROD, { fetch: countingFetch });
  resetCounters();
  console.log("[phase1] text-selector replicate.from (engine runInitialPull shape)...");
  await pull(scratch, remote, { live: false, retry: false, selector: TEXT_SELECTOR, checkpoint: "target", batch_size: 100 }, "phase1");

  const info = await scratch.info();
  const attDocs = await countAttachmentDocs(scratch);
  const wireMb = mb(wireBytes);

  record(
    "phase-1 wire bytes are tens of MB, not GB",
    wireMb < PHASE1_WIRE_CEILING_MB && wireMb < FULL_DB_FLOOR_MB,
    `wire=${wireMb}MB (ceiling ${PHASE1_WIRE_CEILING_MB}MB; full-DB floor ${FULL_DB_FLOOR_MB}MB; DB file is ~8590MB)`,
  );
  record(
    "scratch holds ZERO docs with _attachments after phase-1",
    attDocs === 0,
    `attachmentDocs=${attDocs} doc_count=${info.doc_count}`,
  );
}

async function revsDiffCheck() {
  const name = "vault-c5-revsdiff";
  await new PouchDB(`${SCRATCH}/${name}`).destroy().catch(() => {});
  const scratch = new PouchDB(`${SCRATCH}/${name}`);
  const remote = new PouchDB(PROD, { fetch: countingFetch });

  resetCounters();
  console.log("[revsdiff] seeding scratch with text docs (phase-1)...");
  await pull(scratch, remote, { live: false, retry: false, selector: TEXT_SELECTOR, checkpoint: "target", batch_size: 100 }, "seed");
  const seeded = await scratch.info();
  console.log(`  seeded doc_count=${seeded.doc_count} seedWire=${mb(wireBytes)}MB`);

  // Re-pull with checkpoint:false -> full changes-feed walk from seq 0, forcing revs_diff
  // against the already-present text revs (isolates revs_diff economy from checkpoint-skip).
  //
  // Plan section 7 framed this gate against the *unfiltered* live db.sync. Re-pulling with
  // the TEXT selector is a deliberately cleaner proxy: revs_diff skips already-present revs
  // independent of the selector, so a filtered-text re-pull isolates the exact claim ("text
  // bodies not re-downloaded") without the binary traffic of an unfiltered pull muddying the
  // _bulk_get byte count. Same load-bearing assumption, measured with less noise.
  resetCounters();
  console.log("[revsdiff] re-pull text with checkpoint:false (forces revs_diff walk)...");
  await pull(scratch, remote, { live: false, retry: false, selector: TEXT_SELECTOR, checkpoint: false, batch_size: 100 }, "repull");

  record(
    "Pattern B gate: present text revs NOT re-downloaded (revs_diff economy)",
    mb(bulkGetBytes) < REVSDIFF_BULKGET_CEILING_MB,
    `repullBulkGet=${mb(bulkGetBytes)}MB over ${bulkGetCalls} _bulk_get calls (ceiling ${REVSDIFF_BULKGET_CEILING_MB}MB) -- FAIL means switch c2 to Pattern A`,
  );
}

async function main() {
  if (which === "all" || which === "phase1") await phase1Check();
  if (which === "all" || which === "revsdiff") await revsDiffCheck();

  const failed = results.filter((r) => !r.pass);
  console.log("\n" + JSON.stringify({ checks: results.length, passed: results.length - failed.length, failed: failed.length }, null, 2));
  if (failed.length > 0) {
    console.error(`\n${failed.length} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nALL CHECKS PASSED -- phase-1 transfers tens of MB, server-side filter real, Pattern B economy holds.");
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(3); });
