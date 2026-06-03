# spikes/resilience-verify

Real-artifact probes for PouchDB sync resilience. Each probe drives pouchdb-node directly against
a live CouchDB container — no mocks, no compiled dist.

## Prerequisites

- CouchDB 3.3 running as Docker container `spike-smoke-couchdb` on port 5986
- `docker` CLI available
- `node_modules/pouchdb-node` available (run `npm install` from the repo root)

Start the container if needed:
```
docker run -d --name spike-smoke-couchdb -p 5986:5984 \
  -e COUCHDB_USER=smoke -e COUCHDB_PASSWORD=smokepass \
  couchdb:3.3
```

Environment overrides: `SCRATCH_URL` (default `http://smoke:smokepass@localhost:5986`),
`COUCH_CONTAINER` (default `spike-smoke-couchdb`).

---

## R1.0 — live db.sync(retry:true) stall probe (2026-06-03)

**File:** `verify-live-stall.mjs`

### Empirical question

Does PouchDB's live `db.sync(remoteUrl, { live: true, retry: true })` emit an `error` event
when CouchDB becomes unreachable **mid live-sync** (i.e. after phase-1 has completed and the
handle has fully caught up and is idle)? Does the handle self-resume without any manual
cancel/recreate when CouchDB comes back?

### Why it matters

Every `#74` resilience unit test drives recovery by **manually emitting** `error` on a mock
handle — none proves a real `db.sync` ever produces one. PouchDB's `retry:true` is documented
to retry internally on transient failures and may emit only `paused`/`active`, swallowing
`error` entirely. If so, `scheduleRestart("live")` is dead code for a stall and the daemon
can freeze silently.

### Method

1. Seed 30 docs to remote, phase-1 pull to local (replicate.from, retry:false).
2. Start `local.sync(remote, { live: true, retry: true })` and wait for genuine idle
   (paused with no-err argument AND doc_count == 30).
3. `docker stop` the CouchDB container. Observe all events for 20s.
4. `docker start` the container. Write a canary doc to local LevelDB (no couch needed for
   the write). Poll the remote via a **fresh** connection for the canary — if it appears
   without any handle cancel/recreate, the push-side self-resumed autonomously.
5. Record all events with full argument payloads and timestamps relative to the kill.

The canary method sidesteps the trap of measuring `doc_count` (already maxed) to infer resume.

### Results (3 independent runs)

All three runs produced identical outcomes.

**Events before kill:** `active`, `paused(none)` — handle idle as expected.

**Events during 20s outage:**
- `paused(none)` fired once, shortly after `docker stop` completed (~1.6s after kill).
- `error` did NOT fire.
- `paused(err)` did NOT fire.

**Events after `docker start`:**
- `active(none)` fired (~3.5s after container started).
- `paused(none)` fired (immediate, no-change catchup).
- `active(none)` + `change({docs_written:1})` + `paused(none)` — canary pushed.

**Canary found on remote:** YES, within ~2s of the write (~30s total from T0, ~7s after docker start).

### Headline answers

| Question | Answer |
|---|---|
| Q1: Did `error` fire during outage? | NO |
| Q2: Did `paused` fire? | YES — once, with no error argument |
| Q3: Did `paused(err)` fire? | NO |
| Q4: Did handle self-resume (canary pushed)? | YES — ~7s after docker start |

### Verdict for RC1

**BRANCH C** (not listed in the plan's binary): `error` is swallowed entirely for a clean
ECONNREFUSED outage. `retry:true` self-resumes the handle autonomously — the canary was
pushed without any engine intervention.

Specific implications:

- `scheduleRestart("live")` in the engine **is dead code for a clean TCP outage**. The engine
  never sees an `error` event from a real `db.sync` handle under ECONNREFUSED.
- PouchDB emits only `paused(none)` during the outage — indistinguishable from a normal
  "no changes to sync" idle. The engine cannot tell the difference from event observation alone.
- The handle resumes autonomously (~3.5s after docker start), so for clean TCP failures PouchDB
  heals without intervention.

**Does this close RC1?** No. The result changes the plan's framing but does not eliminate the risk:

- `docker stop` is the **friendliest** possible outage (immediate clean ECONNREFUSED).
  It does not reproduce:
  - Half-open TCP sockets (server killed/firewalled without RST — PouchDB may wait indefinitely)
  - DNS failure or resolution timeout
  - The **WebKit "Load failed"** mode noted in production memory (which emits a different error
    path than Node's net.Socket ECONNREFUSED)
- For those harder failure modes, the handle may stall silently without ever re-entering the
  internal retry loop. A liveness watchdog (AC1.2) is the only defence against "paused-but-stuck"
  scenarios — it detects zero progress regardless of which events (or non-events) fire.

**Recommendation:** Proceed to RC1.1. The watchdog is warranted not because clean TCP stalls are
proven silent (they self-heal), but because the engine has **no way to distinguish a healthy
paused-idle from a stuck-paused-stall** from events alone, and the hard failure modes (half-open,
DNS, WebKit) are not covered by this probe.

### Reproduce

```
# From repo root, CouchDB running:
node spikes/resilience-verify/verify-live-stall.mjs

# With custom CouchDB:
SCRATCH_URL=http://admin:pass@localhost:5984 \
COUCH_CONTAINER=my-couchdb \
node spikes/resilience-verify/verify-live-stall.mjs
```

Expected output (3 consistent runs, ~30s each): `BRANCH C` verdict, canary found.

---

## RC2 — real reconcile + live-sync smoke (2026-06-03)

**File:** `verify-reconcile-real.ts`

### Claim under test

`reconcilePull` is a deliberate no-op. For a "pull" action (AC2.3b: file absent on disk,
local PouchDB has old rev R, remote has newer rev R′), option (b) states the fix is to rely
on LIVE `db.sync` to pull R′ into local PouchDB after `bridge.start` + `engine.start`,
which then fires the `since:"now"` changes feed → `applyRemoteChange` → writes the file.

The existing integration test "proves" this only with `db._emitChange(...)`, which directly
fires the feed and BYPASSES the real question: does REAL `db.sync` with the doc already at
rev R locally and a checkpoint in place actually re-pull R′ and deliver the file to disk?

### Method

1. **Seed** three situations against a fresh CouchDB + fresh local PouchDB + tmpdir vault:
   - **P (AC2.3b pull):** PUT P@R (content X) on couch; replicate.from couch→local to copy rev
     R verbatim; write P to disk. Synced state.
   - **B (AC2.1 stranded push):** file on disk only — NOT in local PouchDB, NOT on couch.
   - **D (AC2.3a downtime-delete):** PUT D@S (content Y) on couch; replicate.from to local
     (same rev S verbatim); write D to disk. Synced state.
2. **Simulate outage window** (direct edits, no daemon):
   - Update P on couch → rev R′ (content Z).
   - Delete P's file from disk.
   - Delete D's file from disk (D on couch unchanged at rev S).
3. **Run real startup cycle** (no mocks): `runReconcileOnStartup` →
   `bridge.start(fsWatcher)` → `engine.start()`. NOT via `runDaemonV2Startup` (no converter).
4. **Intermediate check** (proves no-op is real): after reconcile, before engine.start —
   P file must be absent on disk, local P content must still be X.
5. **Poll** (up to 60s) for disk outcomes to settle.

### Critical design note

`replicate.from` is used (not `local.put`) to seed the "synced" state. This copies the
couch rev hash verbatim into local PouchDB, so `local._rev === remote.rev` for D (AC2.3a
tombstone branch) and P (AC2.3b pull branch). Using `local.put` generates a different rev
hash and would mis-route D to the pull branch instead of tombstone, invalidating the test.

### Results (2 independent runs)

Both runs produced identical outcomes in ~1.7s poll time.

**Intermediate check (proves reconcilePull is a genuine no-op):**
- P file absent from disk after `runReconcileOnStartup`, before `engine.start`: YES
- P local PouchDB content still X at midpoint: YES

**Final asserts:**

| Assert | Outcome |
|--------|---------|
| AC2.3b (CRITICAL): P file on disk with content Z | PASS |
| AC2.1: B doc exists in couch | PASS |
| AC2.3a: D tombstoned (couch `reason:deleted`) | PASS |
| AC2.3a: D file absent from disk | PASS |

**AC2.3a note:** `reconcileTombstone` marks D as `_deleted` in local PouchDB; live `db.sync`
pushes the tombstone to couch. Local `db.get(D, {latest:true})` returns `not_found`
(PouchDB compacts local tombstones); couch returns `{"error":"not_found","reason":"deleted"}`,
which is the authoritative tombstone confirmation.

### Headline answer

| Question | Answer |
|----------|--------|
| Does real `db.sync` pull R′ and deliver content Z to disk? | YES — ~1.7s after engine.start |
| Is reconcilePull's no-op genuinely a no-op (not a false pass)? | YES — intermediate check confirms |
| Does AC2.3b downtime-remote-edit recovery work end-to-end? | YES |

### Option-(b) verdict

**HOLDS.** `reconcilePull` is correctly a no-op. Real `db.sync` pulls P@R′ (content Z)
into local PouchDB within ~1.7s of `engine.start`, fires the `since:"now"` changes feed,
and `applyRemoteChange` writes content Z to disk. The mock-driven integration test's
`db._emitChange` simulation is confirmed to match real behavior for this scenario.

AC2.3b/AC2.3c files edited or created on the remote during a daemon outage **will come
back** via live sync. No ship-blocker.

### Reproduce

```
# From repo root, CouchDB running at localhost:5986:
SCRATCH_URL=http://smoke:smokepass@localhost:5986 \
npx tsx spikes/resilience-verify/verify-reconcile-real.ts

# With custom CouchDB:
SCRATCH_URL=http://admin:pass@localhost:5984 \
npx tsx spikes/resilience-verify/verify-reconcile-real.ts
```

Expected output (2 consistent runs, ~2s each): all-PASS, `HOLDS` verdict.
