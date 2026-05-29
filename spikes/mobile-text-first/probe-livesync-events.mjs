// Raw event-order probe: capture the FULL ordered sequence of db.sync events (change/paused/
// active/complete) with their info shapes, against a real text-seeded backlog, to determine
// empirically whether `paused` can fire BEFORE the first `change` at startup (the precondition
// for startLiveSync's premature-"ok" latch). Logs everything; draws no PASS/FAIL -- this is
// observation feeding the verdict.
//
// Usage: export SCRATCH_URL="http://smoke:smokepass@localhost:5986"; node probe-livesync-events.mjs

import PouchDB from "pouchdb-node";

const SCRATCH = process.env.SCRATCH_URL;
if (!SCRATCH) { console.error("Set SCRATCH_URL"); process.exit(2); }
const TEXT_SELECTOR = { _attachments: { $exists: false } };
const TEXT_DOC_COUNT = 30;
const BINARY_DOC_COUNT = 60;
const ATTACHMENT_BYTES = 800 * 1024; // ~48 MB -> backfill takes a few seconds even on localhost
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (b) => `${SCRATCH}/${b}-${Date.now().toString(36)}`;

async function seedRemote(remoteUrl) {
  const remote = new PouchDB(remoteUrl);
  const text = [];
  for (let i = 0; i < TEXT_DOC_COUNT; i++) text.push({ _id: `note-${i}.md`, content: "x".repeat(500) });
  await remote.bulkDocs(text);
  const buf = Buffer.alloc(ATTACHMENT_BYTES, 9);
  for (let i = 0; i < BINARY_DOC_COUNT; i++) {
    await remote.put({ _id: `asset-${i}.bin`, _attachments: { "d.bin": { content_type: "application/octet-stream", data: buf.toString("base64") } } });
  }
  return remote;
}

async function main() {
  const remoteUrl = u("vault-probe-remote");
  const localUrl = u("vault-probe-local");
  const remote = await seedRemote(remoteUrl);
  const scratch = new PouchDB(localUrl);

  await new Promise((res, rej) => {
    const rep = scratch.replicate.from(remoteUrl, { live: false, retry: false, selector: TEXT_SELECTOR, checkpoint: "target" });
    rep.on("complete", res); rep.on("error", rej);
  });
  console.log(`[phase1] local doc_count=${(await scratch.info()).doc_count}; ${BINARY_DOC_COUNT} binaries (~${(BINARY_DOC_COUNT*ATTACHMENT_BYTES/1e6).toFixed(0)}MB) pending`);

  const t0 = Date.now();
  const log = (s) => console.log(`+${String(Date.now()-t0).padStart(5)}ms  ${s}`);
  const seq = [];

  const handle = scratch.sync(remoteUrl, { live: true, retry: true });

  let engineFieldEverDefined = false;
  handle.on("change", (info) => {
    // pouchdb db.sync change info: { direction:'pull'|'push', change:{docs_written,pending,...} }
    const dir = info && info.direction;
    const pending = info && info.change && info.change.pending;
    const dw = info && info.change && info.change.docs_written;
    // What PouchDbSyncEngine.startLiveSync line 437 actually reads (FLAT info.pending):
    const engineReads = info && info.pending;
    if (engineReads !== undefined) engineFieldEverDefined = true;
    seq.push("change");
    log(`change dir=${dir} docs_written=${dw}  REAL info.change.pending=${pending}  ENGINE info.pending=${JSON.stringify(engineReads)}`);
  });
  handle.on("active", () => { seq.push("active"); log("active"); });
  handle.on("paused", (err) => { seq.push("paused"); log(`paused${err ? " (err="+err+")" : " (no-arg)"}`); });
  handle.on("complete", () => { seq.push("complete"); log("complete"); });
  handle.on("error", (e) => { seq.push("error"); log(`error ${e && e.message}`); });

  // run long enough to see startup ordering AND the eventual caught-up pause
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    const att = (await scratch.allDocs({ include_docs: true })).rows.filter((r) => r.doc && r.doc._attachments).length;
    if (att >= BINARY_DOC_COUNT && seq.includes("paused")) { log(`all ${att} binaries local + paused seen; stopping`); break; }
  }
  handle.cancel();

  console.log("\nORDERED EVENT SEQUENCE:", seq.join(" -> "));
  const firstChangeIdx = seq.indexOf("change");
  const firstPausedIdx = seq.indexOf("paused");
  const pausedBeforeChange = firstPausedIdx !== -1 && (firstChangeIdx === -1 || firstPausedIdx < firstChangeIdx);
  console.log(`firstChange@${firstChangeIdx} firstPaused@${firstPausedIdx} -> pausedBeforeFirstChange=${pausedBeforeChange}`);
  console.log(pausedBeforeChange
    ? "RACE PRECONDITION PRESENT: a paused fired before the first change."
    : "Race precondition NOT observed here: first change preceded first paused.");

  // The DETERMINISTIC finding (independent of event order): the engine's paused-discriminator
  // reads info.pending, which is undefined on EVERY db.sync change event (the real value is
  // nested at info.change.pending). So engine.liveSyncPending stays 0 permanently and the first
  // paused latches syncPhase='complete'/state='ok' regardless of pending binaries -- settings-tab
  // then renders "Synced" mid-backfill. This is the field-read bug, not a timing race.
  console.log(`\nENGINE field read (info.pending) ever defined on a db.sync change? ${engineFieldEverDefined}`);
  console.log(engineFieldEverDefined
    ? "info.pending was defined -- engine discriminator could work."
    : "BLOCKER: info.pending is ALWAYS undefined on db.sync changes -> liveSyncPending stuck at 0 -> premature 'Synced'. Fix: read info.change?.pending ?? info.pending ?? 0.");

  await remote.destroy().catch(() => {});
  await scratch.destroy().catch(() => {});
}
main().catch((e) => { console.error("FATAL:", e.message, e.stack); process.exit(3); });
