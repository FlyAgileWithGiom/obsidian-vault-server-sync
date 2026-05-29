# Mobile Text-First Sync — Implementation Plan

Refs FlyAgileWithGiom/obsidian-vault-server-sync#72

## Problem

The iOS initial pull is `db.replicate.from(remote, { live: false })` — unfiltered.
On `vault-obsidiannotes` that pulls the **entire** DB (~8.5 GB: 8031 text docs ~20 MB +
6750 binary docs ~3 GB+ attachments) before the vault is usable. On a poor mobile
network this is the blocker. `excludePatterns` does **not** gate the pull (it only gates
the daemon FsWatcher push path), so it cannot help here.

## Decision

Two-phase initial pull, server-side filtered by a Mango selector on `_attachments`:

- **Phase 1 (blocking, fast):** pull text docs only — vault usable at tens of MB.
- **Phase 2 (background, non-blocking, resumable):** pull binary docs at network pace
  while the vault is already usable and editable.
- **Steady state:** ongoing live `db.sync` covers both directions.

This is validated by the spike (`spikes/mobile-text-first/`), not theory. The decisive
evidence is **wire bytes**, not resulting DB size: phase-1 measured **64 MB over the
wire** (56.8 MB of it `_bulk_get` doc bodies), **not 8 GB**, with **zero** `_attachments`
docs in the resulting scratch DB. DB size alone cannot discriminate server-side from
client-side filtering — both end at tens of MB locally; only wire bytes prove the saving
is real.

### Sizing premise correction (do not quote 20 MB)

The "~20 MB text" premise is **stale**. Phase-1 measured ~64 MB wire / ~48 MB disk —
roughly 3x — because this LiveSync vault has conflict-heavy revision trees and replication
pulls **all leaf revs** (`docs_written=31813` cumulative vs 8305 materialized docs ≈ 3.8
leaf revs/doc). **Design and message against ~50-65 MB**, not 20 MB. Still tens of MB, not
GB, so text-first remains a large win.

---

## 1. Where it plugs into `PouchDbSyncEngine`

File: `src/PouchDbSyncEngine.ts`. Today `runInitialPull()` (line 283) does an unfiltered
`db.replicate.from(remoteUrl, { live: false, retry: false })` and, on `complete`, calls
`startLiveSync()` + `setState("ok")`.

### The crux is NOT the phase-1 split — it is how phase-2 coexists with live push

The split into two selector-filtered `replicate.from` calls is mechanically simple. The
design risk is **sequencing**. A naive reading — phase-1 text → phase-2 binary (one-shot)
→ *then* `startLiveSync()` — means **local edits do not push for the entire binary
backfill**. On the daemon that is seconds. On mobile that is 3 GB over cellular (hours),
during which the user's edits sit unsynced and are exposed to clobbering from other
devices. Two hard constraints:

1. **Push must stay live during the binary backfill.** The vault is usable after phase-1;
   anything the user writes must propagate.
2. **No double-pull of binaries.** An unfiltered live pull running *alongside* a
   binary-selector phase-2 would fetch the same binary docs twice.

Two patterns satisfy both. **Recommended: Pattern B** (least code, reuses existing live
sync, matches "then ongoing live sync covers both"). Pattern A is the fallback if Pattern
B's progress reporting proves insufficient.

#### Pattern B (recommended) — phase-1 text pull, then existing unfiltered live `db.sync`

```
runInitialPull():
  phase-1: replicate.from(remote, { selector: TEXT_SELECTOR, live: false,
                                    retry: false, checkpoint: 'target' })
    on complete:
      cleanupLegacyRevMap()
      setPhase('text-ready')           // vault usable, see section 4
      startLiveSync()                  // EXISTING unfiltered db.sync, bidirectional
```

The existing live `db.sync` then backfills the binaries as its natural pull backlog while
push is alive from the first moment. Phase-1's already-present text revs are skipped
cheaply: **PouchDB runs `revs_diff` before `_bulk_get`**, so revs already local cost
metadata only, not re-download. This is a load-bearing assumption — **the implementer
must verify it** (section 7, "revs_diff economy" test) before committing Pattern B. If it
holds, this is the entire change to the engine's pull path beyond the phase-1 selector.

Trade-off: binary backfill progress is whatever the live `db.sync` `change` events report
(combined text+binary pending), not a clean "attachments N/6750". Section 4 handles the
"text-ready" signal regardless; the granular binary counter is the only thing Pattern B
gives up.

#### Pattern A (fallback) — explicit phased pulls, swap to full sync on binary completion

```
runInitialPull():
  phase-1: replicate.from(remote, { selector: TEXT_SELECTOR, live:false,
                                    retry:false, checkpoint:'target' })
    on complete:
      setPhase('text-ready')
      startLivePush()                  // replicate.to(remote, {live:true, retry:true})
      startPhase2Binary()              // background, tracked, see below
  phase-2: replicate.from(remote, { selector: BINARY_SELECTOR, live:false,
                                    retry:true, checkpoint:'target' })
    on change: update binariesFetched / binariesTotal  (exact N/total)
    on complete:
      cancel live push
      setPhase('complete')
      startLiveSync()                  // swap to full bidirectional db.sync
```

Pattern A buys exact `attachments N/total` at the cost of a second long-lived handle, a
push-only sub-phase, and a handle swap on completion. Choose A only if the user needs the
granular binary counter; otherwise B.

### `startLiveSync()` is unchanged

`startLiveSync()` (line 344) stays as-is — full bidirectional `db.sync`. It is the steady
state in both patterns. The only addition either pattern makes is *when* it starts and
(Pattern A) a transient push-only handle before it.

### Three callers route through `runInitialPull()` — change behaves for all three

`runInitialPull()` is called by **`start()`** (first run, line 100), **`forceFullSync()`**
(line 136), and **`replaceLocalFromServer()`** (line 171, after destroy+recreate). The
split must be implemented inside `runInitialPull()` so all three inherit it:

- `start()` first-run: text-first then backfill — the headline win.
- `replaceLocalFromServer()`: destroy → fresh db → text-first then backfill — correct,
  same win after a destructive reset.
- `forceFullSync()`: text-first then backfill — fine; it is a merge/repair path, the
  two-phase shape does not change its semantics.

Do **not** patch only the first-run path. One change in `runInitialPull()`, three
beneficiaries.

---

## 2. Filter mechanism (exactly what the spike validated)

**PouchDB `selector` replication option — Mango selector on `_attachments`. No design-doc
filter, no schema change.**

```
TEXT_SELECTOR   = { _attachments: { $exists: false } }   // phase 1
BINARY_SELECTOR = { _attachments: { $exists: true } }    // phase 2
```

PouchDB translates `replicate.from(remote, { selector })` into a server-side
`_changes?filter=_selector` filter on CouchDB 3.x. The spike's `_changes` probe proved
`_attachments` is queryable server-side: the inverse selector returned **exactly 6750**
binary docs (the measured binary-doc count). `$exists` works; an explicit `isBinary`/`type`
field is unnecessary.

**Gotcha to encode, not to fear:** `{ _attachments: { $exists: false } }` also matches
deleted-doc tombstones (`doc_del_count` was 8076), so the `_changes` row count (16121) and
the `docs_written` counter overshoot the live text-doc count (8305 materialized).
Tombstones are tiny metadata, not bandwidth, and **not** a sign the filter broke. Progress
counters in diagnostics will read high; that is expected.

**Fallback (document, do not build):** a CouchDB design-doc `filter` function is viable if
a future CouchDB rejects `_selector`, but it runs per-doc server-side and is slower. Not
needed here.

### Required type-declaration change (blocks everything)

`src/pouchdb-browser.d.ts` (lines 56-60) and `headless/pouchdb-node.d.ts` declare
`replicate.from`/`sync` opts as only `{ live?, retry? }`. Add `selector?` and
`checkpoint?` to **both** methods in **both** files:

```
sync(remote: string, opts?: {
  live?: boolean; retry?: boolean;
  selector?: Record<string, unknown>;
  checkpoint?: 'source' | 'target' | false;
}): PouchDbSyncHandle;

replicate: {
  from(remote: string, opts?: {
    live?: boolean; retry?: boolean;
    selector?: Record<string, unknown>;
    checkpoint?: 'source' | 'target' | false;
  }): PouchDbSyncHandle;
};
```

This is commit 1 — it unblocks the rest. (esbuild does not type-check, but the rest of the
codebase relies on these ambient decls for editor/CI correctness, and the existing decls
are intentionally minimal-but-accurate.)

### `checkpoint: 'target'` — accurate rationale

Set `checkpoint: 'target'` on both phase pulls. Rationale in the **real client** (not the
spike): it keeps replication checkpoint `_local` docs on the local DB and makes **phase-2
resumable** (the target holds the checkpoint), and it is the simplest correct choice. Note
the spike's "keeps server read-safe" framing was true **only for the read-only spike** —
the production client legitimately writes to the server via push. Use the option; state
the accurate why (resume + simplicity), not read-safety.

---

## 3. Platform scope — universal, not iOS-gated

**Decision: universal. Same code on plugin (mobile + desktop) and daemon. No
`Platform.isMobile` fork.**

Justification:

- v2.0 (#69) deliberately unified to a single engine on every platform (`src/main.ts`
  lines 12-13). Gating text-first behind `Platform.isMobile` reintroduces exactly the
  platform fork that unification removed — a regression in design intent that would need
  separate justification.
- Two-phase is **~the same total work** as the current single pull (same docs, split into
  two filtered passes). It is harmless on a fast network: desktop/daemon reach text-ready
  faster, then binaries backfill at full speed.

**The one platform nuance — encode it as priority, not as a code fork:**

- **Daemon (Mac):** binaries are **mandatory** — the server is canonical and the daemon's
  copy is the Dropbox-backed backup. Phase-2 must be **guaranteed-completion**: `retry`
  on, runs to done, no interruption logic.
- **Mobile (iOS/iPad):** phase-2 is **low-priority and interruptible** — it is allowed to
  pause on backgrounding and resume on `visibilitychange` (the engine already restarts
  sync on `visibilitychange`, line 87 / `handleVisibilityVisible`, line 383). Resume, not
  restart (section 5).

Same code path; the difference is only that the daemon never deliberately interrupts
phase-2 and mobile may. Pattern B gets this for free (live `db.sync` already retries and
resumes on both platforms). This is the clean line for user sign-off (section 8).

---

## 4. State & diagnostics — "notes ready" must not read as "Synced"

**Problem:** if phase-1 completion sets `state = "ok"`, `main.ts` `STATUS_LABELS` renders
"● Synced" while 6750 binaries are still missing — a lie. The five existing `SyncState`
values (`idle|syncing|ok|error|offline|not-configured`) must **not** be overloaded to
report "done early".

**Solution: add a phase field to diagnostics, distinct from `SyncState`.**

Add to the engine and to `SyncDiagnostics` (`src/types.ts`):

```
syncPhase: 'idle' | 'text-pull' | 'text-ready' | 'binary-backfill' | 'complete';
binaryProgress: { fetched: number; total: number } | null;
```

- During phase-1: `syncPhase = 'text-pull'`, `state = 'syncing'`.
- Phase-1 complete: `syncPhase = 'text-ready'`. **State stays `'syncing'`** (binaries
  still pending) — not `'ok'`. The status bar/notice can say "Notes ready — attachments
  syncing" by reading `syncPhase`, while `state` honestly remains `syncing`.
- Backfill: `syncPhase = 'binary-backfill'`; `binaryProgress` populated where available
  (exact in Pattern A; in Pattern B, derived from live-sync pending — may be combined
  text+binary, label it "pending" not "attachments N/total" if exactness is not
  guaranteed).
- Backfill complete + steady state reached: `syncPhase = 'complete'`, `state = 'ok'`.

`onNotice` already exists (line 54, wired to `new Notice` in main.ts) — fire a one-shot
"Vault Sync: Notes ready, attachments downloading in background" at the `text-ready`
transition so the user sees the win immediately.

`settings-tab.ts::formatDiagnostics` (line 236) renders these: a phase line and, when
`binaryProgress` is non-null, an "Attachments: N / total" (or "Attachments pending: N")
line. This is the only settings-tab change.

### Fold in the pre-existing diagnostics type gap (same commit, one concern)

`getDiagnostics()` (line 188) already **violates** `SyncDiagnostics`: it omits
`avgFetchMs`, `fetchSampleCount`, `avgApplyMs`, `applySampleCount` (those belonged to the
old `PouchDbSyncStrategy`'s per-doc timing; the new engine has none). Only esbuild's
no-typecheck build hides it (`npx tsc --noEmit` flags it: `src/PouchDbSyncEngine.ts(189)`
"missing the following properties"). Since this commit already rewrites the
`getDiagnostics()` return to add the phase fields, **complete the four missing fields in
the same return** as `null`/`0`. Do not route around the gap; close it. Keep it to this
one commit so it stays one concern.

---

## 5. Idempotence & resume — phase-2 resumes, never restarts

Spike-confirmed: phase-2 makes forward progress across cancel/restart with **no data loss
and no full re-pull** (50 → 150 docs on restart). `checkpoint: 'target'` is what enables
this — the local DB holds the replication checkpoint. The exact mechanism
(checkpoint-resume vs re-walking the changes feed and skipping already-written docs) was
**not isolated** by the spike; either way is safe — what matters is no loss, no full
re-pull.

Requirements for the implementer:

- **Pattern B:** resume is inherent — live `db.sync` with `retry: true` already resumes
  from its checkpoint after interruption. Mobile `visibilitychange` resume
  (`handleVisibilityVisible`, line 383) restarts the live sync handle, which continues
  from checkpoint. Nothing extra.
- **Pattern A:** the phase-2 `replicate.from` must use `retry: true` and the **same target
  + same selector** on restart so it continues from the target checkpoint. On
  `visibilitychange`, restart phase-2 (if not yet complete) rather than jumping straight to
  full live sync — guard on `syncPhase !== 'complete'`.
- **Persisting `syncPhase` across an app kill (mobile):** on cold start, `isFirstRun()`
  (line 258) is `doc_count === 0`. After a successful phase-1, `doc_count > 0`, so a cold
  start takes the **`startLiveSync()` branch** (line 102) — which in Pattern B *is* the
  backfill+steady-state path. So an app kill mid-backfill resumes correctly with no special
  handling. **Verify** there is no window where phase-1 partially completed (`doc_count > 0`
  but text not fully pulled) leaves the vault thinking it is done: phase-1 `live:false`
  completes atomically per the `complete` event; a kill mid-phase-1 leaves `doc_count > 0`
  and the next cold start goes to live sync, which finishes the pull. Acceptable, but
  state it as a known property in the test plan.

---

## 6. Commit sequencing (atomic, each green independently)

```
c1  type decls:   add selector? + checkpoint? to replicate.from/sync in
                  src/pouchdb-browser.d.ts AND headless/pouchdb-node.d.ts.
                  Refs #72  (unblocks everything; no behavior change)

c2  engine:       selector constants (TEXT_SELECTOR/BINARY_SELECTOR) +
                  two-phase runInitialPull (Pattern B unless revs_diff economy
                  test fails -> Pattern A). startLiveSync unchanged.
                  Refs #72

c3  diagnostics:  add syncPhase + binaryProgress to SyncDiagnostics (types.ts)
                  and engine; set phase transitions in runInitialPull;
                  complete the 4 pre-existing missing fields (avgFetchMs etc.)
                  as null/0 in getDiagnostics. one-shot "Notes ready" notice.
                  Refs #72

c4  settings-tab: render syncPhase + attachments progress in formatDiagnostics.
                  Refs #72

c5  tests:        unit (phase split, selector passed, phase transitions, resume
                  guard) + REAL-artifact wire-byte measurement (section 7).
                  Refs #72
```

If `agile-flow` / TDD is followed, c2-c4 each pair their test with the change; c5 is the
real-artifact measurement that no unit test can substitute for. One concern per commit.

---

## 7. Test strategy

Unit tests can prove the **plumbing** (selector is passed, phases transition, resume guard
holds) but **cannot** prove the bandwidth saving — a mocked PouchDB returns whatever the
mock returns. The ship-blocking question ("does the wire actually carry tens of MB, not
8 GB?") is only answerable against the **real artifact**.

### Unit (mocked PouchDB — pattern already in `PouchDbSyncEngine.test.ts`)

- `runInitialPull` calls `replicate.from` with `selector === TEXT_SELECTOR` and
  `checkpoint: 'target'`.
- Phase transitions: `text-pull → text-ready → binary-backfill → complete` set `syncPhase`
  correctly; `state` is **not** `'ok'` at `text-ready`.
- All three callers (`start`/`forceFullSync`/`replaceLocalFromServer`) go through the
  two-phase path.
- Resume guard: a `visibilitychange` during backfill resumes, does not restart from scratch
  (Pattern A: same selector+target reused; Pattern B: live sync handle restarted).
- `getDiagnostics()` returns a `SyncDiagnostics`-complete object (close the type gap).

### REAL-artifact measurement (the decisive test — adapt the spike harness)

Reuse `spikes/mobile-text-first/measure.mjs` (the fetch-wrapper wire-byte counter) against
**prod read-only**:

```
PROD_URL  = https://livesync:...@sync.fly-agile.com/vault-obsidiannotes   (READ-ONLY)
SCRATCH   = http://smoke:smokepass@localhost:5986                          (writable)
```

Assert, against the production-mirroring engine pull (not just the spike script):

- phase-1 **wire bytes** ≈ tens of MB (spike: 64 MB), **orders of magnitude below 8 GB**.
- scratch DB after phase-1 has **zero** docs with `_attachments`.
- phase-2 with `BINARY_SELECTOR` pulls only binary docs; cancel mid-way + restart →
  `doc_count` increases (resume), no full re-pull.
- **revs_diff economy (Pattern B gate):** after phase-1, start the unfiltered live
  `db.sync` against a scratch that already holds the text docs and confirm it does **not**
  re-download text bodies (wire bytes for already-present text revs are metadata-only).
  **If this fails, switch c2 to Pattern A.**

Run **read-only**: GET + `_bulk_get` POST only, `checkpoint: 'target'` keeps checkpoints
off prod. (The spike confirmed prod read-only was honored; a +1 `doc_count` seen during the
spike was a live device editing a real note, not the spike — `_local` checkpoint docs do
not increment `doc_count`.)

### Cross-library transfer caveat (state, and cheaply close)

The spike measured on **pouchdb-node** (the daemon's lib). The primary beneficiary is
**pouchdb-browser** (mobile). The replication core (`revs_diff` → `_bulk_get`, `selector`
→ `_changes?filter=_selector`) is shared, so wire behavior **should** transfer — state
this as the working assumption. If cheap, add one wire-byte check on the pouchdb-browser
path (headless smoke or a browser harness) so the measurement covers the actual target,
not only the daemon's lib.

---

## 8. Risks & sign-off

**Risks (mitigated in-design):**

- *Phase-2 / live-push coexistence (the real one):* a sequential phase-2-then-livesync
  design strands user edits unsynced for the entire binary backfill (hours on cellular).
  Mitigated by keeping push live throughout (Pattern B: bidirectional `db.sync` from the
  start; Pattern A: explicit live push during backfill). **This is the design's correctness
  hinge.**
- *Double-pull of binaries:* mitigated by not running an unfiltered live pull alongside a
  binary-selector phase-2 (Pattern B uses one live sync for backfill; Pattern A swaps to
  full sync only on phase-2 completion).
- *`revs_diff` economy unverified (Pattern B):* if already-present text revs are
  re-downloaded by the live sync, Pattern B loses some of its saving. Gated by the c7 test;
  fallback is Pattern A.
- *Cross-library transfer:* spike on pouchdb-node, target is pouchdb-browser; shared core,
  closed by an optional browser-path wire check.

**Decisions needing user sign-off (≤3):**

1. **Universal, not iOS-gated** (section 3). Recommended: universal — preserves the v2.0
   single-engine design; daemon runs phase-2 to guaranteed completion (canonical backup),
   mobile runs it low-priority/interruptible. Same code, platform-tuned priority.
2. **Pattern B vs Pattern A** (section 1). Recommended: Pattern B (reuse existing live
   `db.sync` for backfill — least code, matches "ongoing live sync covers both"), with the
   c7 revs_diff test as the gate; fall back to Pattern A only if the user needs an exact
   "attachments N/6750" counter or the revs_diff economy fails.
3. **Phase-2 priority/interruptibility on mobile** (sections 3, 5): confirm phase-2 may
   pause on backgrounding and resume on `visibilitychange` (recommended — non-blocking is
   the whole point), versus forcing it to run to completion like the daemon.
