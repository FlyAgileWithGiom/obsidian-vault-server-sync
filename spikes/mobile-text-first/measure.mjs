// Spike: does a server-side-filtered PouchDB replication pull ONLY text docs (~tens of MB)
// instead of the full ~8 GB? Measures WIRE BYTES (not just resulting db size, which cannot
// discriminate server-side from client-side filtering).
//
// Usage: node measure.mjs <phase>
//   phase = "text"   -> selector {_attachments:{$exists:false}}  (phase-1, expect tens of MB)
//   phase = "binary" -> selector {_attachments:{$exists:true}}   (phase-2 separability)
//   phase = "binary-resume" -> cancel mid-way, restart, confirm resumes from checkpoint
//
// Wire bytes are summed by wrapping the REMOTE PouchDB's fetch and reading content-length
// of every response body. checkpoint:'target' keeps checkpoint docs OFF prod (READ-ONLY).

import PouchDB from "pouchdb-node";

const PROD = process.env.PROD_URL;
const SCRATCH = process.env.SCRATCH_URL;
const phase = process.argv[2] || "text";

if (!PROD || !SCRATCH) {
  console.error("Set PROD_URL and SCRATCH_URL env vars");
  process.exit(1);
}

const SELECTORS = {
  text: { _attachments: { $exists: false } },
  binary: { _attachments: { $exists: true } },
};

let wireBytes = 0;
let reqCount = 0;
let bulkGetCalls = 0;
let attBytes = 0; // bytes seen on _bulk_get / attachment fetches specifically

// Wrap fetch on the REMOTE to count bytes actually pulled over the wire.
function countingFetch(url, opts) {
  reqCount++;
  const u = typeof url === "string" ? url : url.url;
  const isBulkGet = /_bulk_get/.test(u);
  if (isBulkGet) bulkGetCalls++;
  return PouchDB.fetch(url, opts).then((res) => {
    const cl = res.headers.get("content-length");
    if (cl) {
      const n = parseInt(cl, 10);
      wireBytes += n;
      if (isBulkGet) attBytes += n;
    } else {
      // No content-length (chunked): clone and measure the body.
      return res
        .clone()
        .arrayBuffer()
        .then((buf) => {
          wireBytes += buf.byteLength;
          if (isBulkGet) attBytes += buf.byteLength;
          return res;
        });
    }
    return res;
  });
}

async function run() {
  const scratchName = `vault-spike-textfirst-${phase}`;
  const scratch = new PouchDB(`${SCRATCH}/${scratchName}`);
  const remote = new PouchDB(PROD, { fetch: countingFetch });

  const selector = SELECTORS[phase === "binary-resume" ? "binary" : phase];
  const opts = { live: false, retry: false, selector, checkpoint: "target", batch_size: 50 };

  const t0 = Date.now();
  let lastDocs = 0;

  if (phase === "binary-resume") {
    // Phase A: start, cancel after first change batch.
    console.log("[resume] starting binary pull, will cancel after first batch...");
    await new Promise((resolve) => {
      const rep = scratch.replicate.from(remote, opts);
      rep.on("change", (info) => {
        console.log(`[resume] batch: docs_written=${info.docs_written} pending=${info.pending}`);
        rep.cancel();
      });
      rep.on("complete", () => resolve());
      rep.on("error", () => resolve());
    });
    const mid = await scratch.info();
    const midBytes = wireBytes;
    console.log(`[resume] after cancel: doc_count=${mid.doc_count}, wireBytes=${midBytes}`);

    // Phase B: restart same target+selector; should continue from checkpoint, not re-pull.
    wireBytes = 0;
    reqCount = 0;
    console.log("[resume] restarting (should resume from checkpoint)...");
    let resumedChanges = 0;
    await new Promise((resolve) => {
      const rep = scratch.replicate.from(remote, opts);
      rep.on("change", (info) => {
        resumedChanges++;
        if (resumedChanges <= 3 || resumedChanges % 10 === 0)
          console.log(`[resume] cont batch: docs_written=${info.docs_written} pending=${info.pending}`);
        // bail after a few batches to keep the spike short
        if (resumedChanges >= 3) rep.cancel();
      });
      rep.on("complete", () => resolve());
      rep.on("error", () => resolve());
    });
    const after = await scratch.info();
    console.log(
      JSON.stringify(
        {
          phase,
          resumable: after.doc_count > mid.doc_count,
          midDocCount: mid.doc_count,
          afterDocCount: after.doc_count,
          restartWireBytes: wireBytes,
          note: "restart continued adding docs from checkpoint without re-pulling from scratch",
        },
        null,
        2
      )
    );
    return;
  }

  // Normal (text or binary full) phase
  await new Promise((resolve, reject) => {
    const rep = scratch.replicate.from(remote, opts);
    rep.on("change", (info) => {
      lastDocs = info.docs_written;
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(
        `[${phase}] docs_written=${info.docs_written} pending=${info.pending} wireBytes=${(wireBytes / 1e6).toFixed(1)}MB t=${elapsed}s`
      );
    });
    rep.on("complete", () => resolve());
    rep.on("error", (e) => reject(e));
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const info = await scratch.info();
  console.log(
    JSON.stringify(
      {
        phase,
        selector,
        docs_written: lastDocs,
        scratch_doc_count: info.doc_count,
        wireBytesTotal: wireBytes,
        wireMB: +(wireBytes / 1e6).toFixed(1),
        bulkGetBytesMB: +(attBytes / 1e6).toFixed(1),
        httpRequests: reqCount,
        bulkGetCalls,
        elapsedSeconds: +elapsed,
      },
      null,
      2
    )
  );
}

run().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
