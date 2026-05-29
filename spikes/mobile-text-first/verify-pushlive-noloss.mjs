// c5 real-artifact verification, part 2 (Refs #72) -- the two checks verify-c5.mjs cannot do
// against READ-ONLY prod, because they require WRITING to the remote:
//
//   pushStaysLiveDuringBackfill -- the plan's stated correctness hinge (section 8): with a
//     binary pull backlog present, a LOCAL edit must propagate to the remote WHILE the
//     binaries are still backfilling. A naive phase-2-then-livesync design strands edits for
//     the whole backfill; Pattern B's single live db.sync must push concurrently with pull.
//
//   noDataLoss -- two-phase to completion leaves local doc-set == remote doc-set; and a
//     cancel-mid-pull-then-restart loses nothing (resumes, completes).
//
// These run against the WRITABLE TEST couch (localhost:5986), seeded with a controlled
// corpus: text docs + a handful of attachment docs large enough to create a real, slow-ish
// pull backlog so a concurrent push has a window to be observed mid-backfill. We reproduce
// the ENGINE's exact call shapes:
//   - phase-1: replicate.from(remote, {live:false, retry:false, selector:TEXT_SELECTOR, checkpoint:'target'})
//   - live   : db.sync(remote, {live:true, retry:true})
// (PouchDbSyncEngine.runInitialPull -> startLiveSync, Pattern B.)
//
// Exits NON-ZERO on any failure.
//
// Usage:
//   export SCRATCH_URL="http://smoke:smokepass@localhost:5986"
//   node verify-pushlive-noloss.mjs

import PouchDB from "pouchdb-node";

const SCRATCH = process.env.SCRATCH_URL;
if (!SCRATCH) {
  console.error("Set SCRATCH_URL (writable test couch) env var");
  process.exit(2);
}

// Engine's exported selector shape (kept identical by reference to PouchDbSyncEngine.TEXT_SELECTOR).
const TEXT_SELECTOR = { _attachments: { $exists: false } };

const TEXT_DOC_COUNT = 40;
const BINARY_DOC_COUNT = 25;
// Each attachment ~400 KB -> ~10 MB binary backlog: big enough that the pull is not
// instantaneous, giving a concurrent push a real window to land before pull drains.
const ATTACHMENT_BYTES = 400 * 1024;

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}  --  ${detail}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freshDbUrl(base) {
  return `${SCRATCH}/${base}-${Date.now().toString(36)}`;
}

async function seedRemote(remoteUrl) {
  const remote = new PouchDB(remoteUrl);
  // Text docs (no _attachments) -> phase-1 selector pulls these.
  const textDocs = [];
  for (let i = 0; i < TEXT_DOC_COUNT; i++) {
    textDocs.push({ _id: `note-${String(i).padStart(3, "0")}.md`, content: `# Note ${i}\n${"text ".repeat(200)}` });
  }
  await remote.bulkDocs(textDocs);
  // Binary docs (with _attachments) -> the live db.sync backfill backlog.
  const buf = Buffer.alloc(ATTACHMENT_BYTES, 7);
  for (let i = 0; i < BINARY_DOC_COUNT; i++) {
    await remote.put({
      _id: `asset-${String(i).padStart(3, "0")}.bin`,
      _attachments: { "data.bin": { content_type: "application/octet-stream", data: buf.toString("base64") } },
    });
  }
  const info = await remote.info();
  console.log(`[seed] remote doc_count=${info.doc_count} (${TEXT_DOC_COUNT} text + ${BINARY_DOC_COUNT} binary, ~${(BINARY_DOC_COUNT * ATTACHMENT_BYTES / 1e6).toFixed(1)}MB attachments)`);
  return remote;
}

function phase1Pull(scratch, remoteUrl) {
  // Exact engine runInitialPull shape.
  return new Promise((resolve, reject) => {
    const rep = scratch.replicate.from(remoteUrl, { live: false, retry: false, selector: TEXT_SELECTOR, checkpoint: "target" });
    rep.on("complete", (info) => resolve(info));
    rep.on("error", reject);
  });
}

// ---- Check 1: pushStaysLiveDuringBackfill ----------------------------------
async function pushStaysLiveCheck() {
  console.log("\n=== pushStaysLiveDuringBackfill ===");
  const remoteUrl = freshDbUrl("vault-pushlive-remote");
  const localUrl = freshDbUrl("vault-pushlive-local");
  const remote = await seedRemote(remoteUrl);
  const scratch = new PouchDB(localUrl);

  // Phase-1: text-only pull (engine shape). Vault now "usable"; binaries NOT yet local.
  await phase1Pull(scratch, remoteUrl);
  const afterP1 = await scratch.info();
  const localAtt = (await scratch.allDocs({ include_docs: true })).rows.filter((r) => r.doc && r.doc._attachments).length;
  console.log(`[phase1] local doc_count=${afterP1.doc_count}, attachment docs locally=${localAtt} (expect 0 -> binaries still pending)`);

  // Start live db.sync EXACTLY as startLiveSync() does -> binary backfill begins now.
  const live = scratch.sync(remoteUrl, { live: true, retry: true });

  // Immediately write a LOCAL edit -- this must push to remote WHILE binaries are still
  // backfilling, not after the whole backlog drains.
  const editId = `local-edit-${Date.now()}.md`;
  await scratch.put({ _id: editId, content: "edit made during binary backfill" });
  const editAt = Date.now();

  // Poll remote for the edit; capture whether binaries were still pending when it landed.
  let pushedAt = null;
  let binariesStillPendingAtPush = null;
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    let onRemote = false;
    try { await remote.get(editId); onRemote = true; } catch { /* not yet */ }
    if (onRemote && pushedAt === null) {
      pushedAt = Date.now();
      // How many binaries had arrived locally at the moment push completed?
      const rows = (await scratch.allDocs({ include_docs: true })).rows;
      const attLocal = rows.filter((r) => r.doc && r.doc._attachments).length;
      binariesStillPendingAtPush = attLocal < BINARY_DOC_COUNT;
      break;
    }
  }
  live.cancel();

  const pushed = pushedAt !== null;
  record(
    "pushStaysLiveDuringBackfill: local edit reaches remote during backfill",
    pushed && binariesStillPendingAtPush === true,
    pushed
      ? `edit landed on remote ${pushedAt - editAt}ms after write; binaries still pending at that moment=${binariesStillPendingAtPush}`
      : "local edit NEVER reached remote within 30s -- push is NOT live during backfill",
  );

  await remote.destroy().catch(() => {});
  await scratch.destroy().catch(() => {});
}

// ---- Check 2: noDataLoss ----------------------------------------------------
async function noDataLossCheck() {
  console.log("\n=== noDataLoss ===");

  // (a) two-phase to completion: local doc-set == remote doc-set.
  const remoteUrl = freshDbUrl("vault-noloss-remote");
  const localUrl = freshDbUrl("vault-noloss-local");
  const remote = await seedRemote(remoteUrl);
  const scratch = new PouchDB(localUrl);

  await phase1Pull(scratch, remoteUrl);

  // Live db.sync drains the binary backlog; wait until local non-deleted doc set matches remote.
  const live = scratch.sync(remoteUrl, { live: true, retry: true });
  const remoteInfo = await remote.info();
  const remoteDocCount = remoteInfo.doc_count;
  let localDocCount = 0;
  for (let i = 0; i < 240; i++) {
    await sleep(250);
    localDocCount = (await scratch.info()).doc_count;
    if (localDocCount >= remoteDocCount) break;
  }
  live.cancel();
  await sleep(300);

  // Compare the live (non-deleted) id sets explicitly, not just counts.
  const localIds = new Set((await scratch.allDocs()).rows.map((r) => r.id));
  const remoteIds = new Set((await remote.allDocs()).rows.map((r) => r.id));
  const missing = [...remoteIds].filter((id) => !localIds.has(id));
  record(
    "noDataLoss: after two-phase completion local doc-set == remote doc-set",
    missing.length === 0 && localIds.size === remoteIds.size,
    `localDocs=${localIds.size} remoteDocs=${remoteIds.size} missingLocally=${missing.length}${missing.length ? " ::" + missing.slice(0, 5).join(",") : ""}`,
  );

  await remote.destroy().catch(() => {});
  await scratch.destroy().catch(() => {});

  // (b) cancel mid-pull then restart -> resumes, completes, no loss.
  const r2Url = freshDbUrl("vault-noloss-resume-remote");
  const l2Url = freshDbUrl("vault-noloss-resume-local");
  const remote2 = await seedRemote(r2Url);
  const scratch2 = new PouchDB(l2Url);

  // Start a binary pull and cancel after the first change batch (mid-pull interruption).
  let midCount = 0;
  await new Promise((resolve) => {
    const rep = scratch2.replicate.from(r2Url, { live: false, retry: false, selector: { _attachments: { $exists: true } }, checkpoint: "target", batch_size: 5 });
    rep.on("change", () => rep.cancel());
    rep.on("complete", () => resolve());
    rep.on("error", () => resolve());
  });
  midCount = (await scratch2.info()).doc_count;
  console.log(`[resume] after mid-pull cancel: local doc_count=${midCount}`);

  // Restart full two-phase (phase-1 text + live sync) and drive to completion.
  await phase1Pull(scratch2, r2Url);
  const live2 = scratch2.sync(r2Url, { live: true, retry: true });
  const remote2Count = (await remote2.info()).doc_count;
  let final2 = 0;
  for (let i = 0; i < 240; i++) {
    await sleep(250);
    final2 = (await scratch2.info()).doc_count;
    if (final2 >= remote2Count) break;
  }
  live2.cancel();
  await sleep(300);

  const local2Ids = new Set((await scratch2.allDocs()).rows.map((r) => r.id));
  const remote2Ids = new Set((await remote2.allDocs()).rows.map((r) => r.id));
  const missing2 = [...remote2Ids].filter((id) => !local2Ids.has(id));
  record(
    "noDataLoss: cancel-mid-pull then restart resumes to full completeness",
    missing2.length === 0 && local2Ids.size === remote2Ids.size && final2 >= midCount,
    `midCount=${midCount} -> final local=${local2Ids.size} remote=${remote2Ids.size} missing=${missing2.length}`,
  );

  await remote2.destroy().catch(() => {});
  await scratch2.destroy().catch(() => {});
}

async function main() {
  await pushStaysLiveCheck();
  await noDataLossCheck();

  const failed = results.filter((r) => !r.pass);
  console.log("\n" + JSON.stringify({ checks: results.length, passed: results.length - failed.length, failed: failed.length }, null, 2));
  if (failed.length > 0) {
    console.error(`\n${failed.length} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nALL CHECKS PASSED -- push stays live during backfill; two-phase + resume lose no data.");
}

main().catch((e) => { console.error("FATAL:", e.message, e.stack); process.exit(3); });
