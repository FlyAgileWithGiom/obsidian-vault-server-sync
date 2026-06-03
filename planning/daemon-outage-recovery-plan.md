# Daemon Outage Recovery ("reprise sur panne") — Implementation Plan

Production daemon: `dist/headless.js` (LaunchAgent `com.flyagile.vault-sync-daemon[.mantu]`),
PouchDB engine since v2.0 (#69). Current version 2.1.2.

This plan addresses recovery robustness after an outage. KISS/YAGNI: it is robustness, not a
rewrite. All work is daemon-scoped (`headless/`), with one engine touch (`src/PouchDbSyncEngine.ts`)
for the RC1 watchdog. It is expressible as Red-Green-Refactor cycles, one per acceptance criterion.

---

## 1. Confirmed Root-Cause Analysis (grounded in current code)

### RC1 — Startup/stall recovery: PARTIALLY ALREADY FIXED. The mission's literal mechanism is stale; the residual gap is narrower and different.

**The mission's mechanism does not exist in the current code.** `ensureDb → DOMException
TimeoutError` was the **old CustomFetch engine** (`src/sync-engine.ts`, deleted in commit
`e062455`/C08). The current v2 daemon (`headless/main.ts::runDaemon`) never calls `ensureDb`;
`grep ensureDb src/ headless/` finds only a comment. The May-29 incident happened on a daemon
whose recovery code has since changed.

**What actually landed after the incident.** The resilient-restart fix (#74, commit `f7e4657`,
dated 2026-05-30 08:15 — the morning *after* the 17:08 incident) added exponential-backoff
restart to `PouchDbSyncEngine`:
- `runInitialPull()` `emitter.on("error")` → `setError(...)` then `scheduleRestart("phase-1")`
  (engine.ts:384-394). Resilience verified against the **real artifact**:
  `spikes/resilience-verify/verify-engine-resume.mjs` kills CouchDB mid-phase-1 and confirms the
  retry resumes from `checkpoint:'target'`.
- `startLiveSync()` `emitter.on("error")` → `setError(...)` then `scheduleRestart("live")`
  (engine.ts:495-502).

So a **surfaced** transient error is already self-healing. Three residual gaps remain — these,
not the stale `ensureDb` mechanism, are RC1:

**RC1a — UNVERIFIED whether `db.sync(..., {retry:true})` ever EMITS `error` on a connectivity
stall.** This is the load-bearing unknown. Every #74 resilience test
(`src/PouchDbSyncEngine.test.ts:729-849`) drives recovery by **manually emitting** the event
(`firstHandle._emit("error", ...)`) on a mock handle — they prove the engine *reacts to* an error,
never that a real `db.sync` *produces* one. PouchDB's `retry:true` is documented to retry
internally on transient failures and may emit only `paused`/`active`, swallowing `error` entirely.
The real-artifact spike killed CouchDB during **phase-1** (`replicate.from`, `retry:false`, which
*does* emit `error`), **not** during live `db.sync`. **If `retry:true` suppresses `error`, then
`scheduleRestart("live")` is dead code for a stall**, and the engine sits forever in whatever state
it was in (often `syncing`/`error`) — which matches the memory note "peut se figer en error après
timeout". This must be settled by a real-artifact probe before RC1 is designed (Cycle R1.0 below).
Whatever the probe shows, the robust fix is a **liveness watchdog**, not more backoff.

**RC1b — Converter phantom-check `throw` → `process.exit(1)`; recovery depends entirely on
launchd.** `runConverter` (converter.ts:193-199) throws after `PHANTOM_BATCH_MAX_RETRIES` if
CouchDB is unresponsive; this propagates to `main().catch → process.exit(1)` (main.ts:354-357).
**Verified:** `headless/com.flyagile.vault-sync-daemon.plist` has `KeepAlive=true` and **no
`ThrottleInterval`**, so launchd relaunches with the default 10s throttle. Crash-recovery for this
path therefore works (the process dies and is restarted, eventually succeeding when CouchDB
recovers). No code change needed; this is documented, not fixed. (The vault-mantu daemon "se fige
en error après timeout startup" the memory note describes is the launchd-startup-timeout state,
repaired via `launchctl kickstart -k` — a launchd lifecycle issue, orthogonal to the engine.)

**RC1c — `isFirstRun()` swallows a `db.info()` failure and returns `false`** (engine.ts:314-321).
On a corrupt/locked LevelDB at boot this routes to `startLiveSync()` instead of a pull, masking the
fault. Low-frequency, noted as a known sharp edge; a defensive rewrite here would violate the
project's "don't add defensive programming" rule, so it is **out of scope** unless RC1.0 evidence
implicates it.

**RC1 verdict:** the mission's "no retry on startup" is **already false for surfaced errors**. The
real residual risk is a **silent live-sync stall** (RC1a) that backoff cannot catch because no
`error` fires. RC1 deliverable = (1) settle RC1a empirically, (2) add a liveness watchdog if
confirmed, (3) document RC1b launchd recovery. Not a re-implementation of #74.

### RC2 — No filesystem reconciliation on restart: CONFIRMED, and it IS a regression introduced by the PouchDB migration.

**Regression confirmed with hard evidence.** The pre-PouchDB engine (`src/sync-engine.ts` at
`e062455~1`) ran a full FS pass on every `start()`:
```
start() → ensureDb() → fullSync() → "[vault-sync] fullSync complete, starting polling"
fullSync() → reconcileLocalDeletes() → pushAllLocal() → pullAllRemote()
pushAllLocal() → this.vault.getFiles()   // FULL filesystem walk, every startup
```
The current v2 startup (`headless/main.ts::runDaemonV2Startup`) does **not** walk the filesystem:
```
runConverter(...)   // state.json revMap → PouchDB; phantom-check only validates the
                    // revmap against the remote ("N entries pass"). NO vault scan.
bridge.start(fsWatcher)   // FsWatcher emits only LIVE events from this moment on
engine.start()      // isFirstRun()==false → startLiveSync() only. NO pull-vs-FS reconcile.
```
`FsWatcher` (headless/FsWatcher.ts) wraps `fs.watch` and emits only events that occur **after**
`start()`. Nothing replays edits made while the daemon was down. Evidence from the incident: 19
local `.md` files absent from CouchDB after recovery; manual `touch` was required to push them. The
`FilesystemVaultAdapter.getFiles()` walker that `pushAllLocal` relied on **still exists**
(VaultAdapter.ts:20-51) but is no longer called at startup. **This is the core of the work.**

**RC2 data-integrity core (the hard part).** A startup reconciliation must decide sync **direction**
safely. The user's scan evidence is the binding constraint: 253 files looked "stale" by mtime, but
the mtimes were **bulk-operation artifacts** (224 files at one identical local mtime; 241 at one
identical couch mtime), not real edits. **mtime is not a reliable divergence signal in this vault.**
Dropbox conflict-copies are an additional known hazard. The design rules below are derived from this.

**Reconcile must know the REMOTE state, not just local PouchDB — this is the load-bearing design
decision.** At startup, local PouchDB reflects **last-synced** state, not **current remote** state
(the pull has not happened yet). So a reconcile that reads only (vault files, local PouchDB) can
detect "did local diverge from last sync?" but **cannot** detect "did the remote also change during
downtime?" — which is exactly what direction-safety and the both-sides-conflict rule require. A
remote-blind reconcile that pushes every locally-diverged file would, on a genuine both-sides
conflict, create a sibling rev that live `db.sync` then resolves via
`PouchDbFsBridge.resolveConflictsByMtime` (PouchDbFsBridge.ts:332) — **the mtime-LWW resolver the
user explicitly flagged as the silent-data-loss vector.** Routing the headline data-integrity
guarantee into the distrusted mechanism is unacceptable.

**The old `fullSync` had the right ordering and we regenerate it faithfully.** The pre-PouchDB
`fullSync` (reconstructed from `e062455~1`) fetched the **remote rev index first** (paginated remote
`allDocs`, no bodies), then `reconcileLocalDeletes → pushAllLocal → pullAllRemote`. The infra to do
this already exists in the v2 daemon: `makeHttpRemoteDb(remoteDbUrl).allDocs({keys, include_docs:false})`
(main.ts:24-79) is precisely a cheap remote-rev lookup (it is the converter's phantom-check path,
already batched/retried against Fly.io CouchDB). **Reconcile reuses it.** So reconcile's inputs are
(vault files via `VaultAdapter.getFiles()`, **local PouchDB read**, **remote rev/deleted map via
`makeHttpRemoteDb.allDocs`**, exclusion predicate). With remote revs in hand, "both sides changed"
becomes genuinely detectable: local-rev ≠ remote-rev signals a remote change during downtime;
disk-content ≠ local-content signals a local change; both true → conflict-copy (AC2.4 is now real,
and never touches the mtime resolver). This also dampens the post-migration trap below
(remote-present docs are not blindly re-pushed).

**Post-migration content-less docs — the `doc_count>0` gate alone is not enough.** The converter
seeds docs with `_id, _rev, mtime` and **content intentionally omitted** (converter.ts:256-264, "will
come from CouchDB"). On the single v1→v2 migration boot, `doc_count>0` so `isFirstRun()` is false and
the gate lets reconcile run — but every file would read as "local content absent, disk content
present" and trigger a **mass-push of the entire ~14k-file vault** against seeded remote revs. Guard:
**a local doc with no `content` field (and no `_attachments`) is awaiting initial replication →
`skip:awaiting-pull`; let live sync populate it.** The remote-rev comparison (Option A above) also
prevents the push (remote rev present ⇒ not a new file), but the content-absent skip is the clean,
explicit guard and is its own decision rule in Cycle 2.

### RC3 — New directories created during downtime not watched: HYPOTHESIS, to be settled empirically (Cycle 1).

`fs.watch(root, {recursive:true})` on macOS is backed by FSEvents, which **should** deliver events
for files in subdirectories created *after* the watch was armed. The two symptom folders ("Pensées
en vrac/", "Détails pratiques Vietnam/") are **not** excluded (`.vault-sync.json` excludes only
`.trash/ .obsidian/ .git/ .DS_Store .vault-sync*.json`), so exclusion is not the cause. The most
likely explanation is that those folders **were created during downtime** and their files were
stranded for the same reason as RC2 — i.e. RC3's startup symptom is **subsumed by RC2's startup
scan** (a full tree walk sees new folders). Whether the *live* case (new folder created while the
daemon runs) also misses events is a separate, empirically-decidable question.

**RC3 verdict:** settle with one integration test before designing any fix (Cycle 1). If `fs.watch`
recursive delivers events in a newly-created subdir → RC3 is **refuted** for the live case and was
RC2 all along. If not → a small FsWatcher fix is warranted. RC2's startup scan covers the startup
half regardless.

---

## 2. Outcome Statements & Acceptance Criteria

**Outcome 1 (RC2 — the headline).**
*The daemon reconciles the vault filesystem against PouchDB on every restart, in a non-first-run
context, so that files created or modified while it was down are detected and synced in the correct
direction — without overwriting a genuinely-newer remote and without ever silently deleting.*

- **AC2.0** Reconciliation reads the **remote rev/deleted map** before deciding any direction —
  local PouchDB alone reflects last-synced, not current-remote, state. The remote query key set is
  **`union(localDocIds, {pathToDocId(f) | f ∈ vaultFiles})`**, NOT `localDocIds` alone: a stranded
  disk file has no local doc, so querying only local ids would make every stranded file read as
  "remote absent" (not-queried is indistinguishable from not-found) → unconditional push. In this
  vault the daemon is down **while iPhone/iPad keep syncing to the canonical server**, so "remote has
  a doc the daemon's local PouchDB lacks" is the *normal* post-outage state — pushing those blind
  reopens the mtime-resolver hole. Querying the disk-file ids too lets reconcile see remote-present
  and skip. The fetch MUST use the converter's **batched + retried** allDocs loop (AC2.0-bis), not a
  single 14k-key POST. *(enables AC2.4 to be real and keeps the decision out of the mtime resolver)*
- **AC2.0-bis** The remote-rev fetch reuses the converter's batching (`PHANTOM_BATCH_SIZE=50`,
  retry+backoff, inter-batch delay) — extracted, not bypassed — because `makeHttpRemoteDb.allDocs`
  is a single unbatched POST and Fly.io CouchDB times out under large concurrent batch load. A
  single ~14k-key POST that times out would trip the "fetch failed → skip reconcile" fallback **every
  boot**, silently disabling the feature on the real vault while mocked-map unit tests stay green
  (Vert ≠ couvert). Verification exercises a realistically large key set or a forced-timeout path.
- **AC2.1** On restart (non-first-run), a file present on disk but **absent from BOTH local PouchDB
  and remote** is pushed. *(reproduces the 19-stranded-files incident)*
- **AC2.2** A file whose **content** differs between disk and local PouchDB is reconciled; a file
  whose content is **identical but whose mtime differs** produces **no write in either direction**.
  *(directly encodes the 253-false-positive evidence)*
- **AC2.3** For a doc present in PouchDB/CouchDB but **absent on disk** at restart, reconcile
  decides by **rev-divergence** — not a blanket default. The signal is the local PouchDB doc's
  `_rev` (the last-synced CouchDB revision, migrated verbatim by `runConverter` via
  `bulkDocs({new_edits:false})`) compared to the remote winning rev already in hand from the AC2.0
  `fetchRemoteRevs` call. No additional network round-trips.
  - **`local _rev === remote winning rev`** AND disk absent → remote unchanged since last sync →
    **the user deleted it on disk during the outage** → **PROPAGATE THE DELETE** (tombstone in local
    PouchDB; live sync replicates to CouchDB). Honors user intent. Prevents the "doublons qui
    reviennent" class of bug: a blanket-resurrect default would re-create a file the user
    intentionally deleted — the exact failure mode this vault has suffered.
  - **`local _rev !== remote winning rev`** AND disk absent → remote was created/updated during the
    outage (e.g. iPhone/iPad editing while Mac daemon was down) → daemon missed a remote event →
    **WRITE TO DISK** (pull remote content to FS). Do NOT tombstone.
  - **No local doc** (doc never in revmap — brand-new remote creation the daemon has never seen) →
    `db.get(docId)` throws 404 → treat as remote-changed → **WRITE TO DISK** (pull). The rule
    handles this naturally: no local rev means no last-synced baseline → remote has something, local
    has nothing → pull.
  - **Remote doc is a tombstone** (`value.deleted: true` in allDocs response) AND disk absent → both
    sides gone → **SKIP** (no-op; no resurrection). Remote tombstone already reflects the delete.
  - **Remote doc is a tombstone AND disk file present with local edits** → **CONFLICT-COPY** (keep
    the edited local content; push the conflict-copy; do not delete an edited file). Leans
    keep-over-delete per the data-loss bar. *(existing Cycle 4 tombstone+edit rule)*
  - **Remote `not_found` (absent from map, no tombstone) AND disk absent** → **SKIP** (both-absent).
    `not_found` in normal CouchDB operation means only `_purge` (admin-only) or wrong/empty remote
    DB — NOT compaction (normal deletes return `deleted:true` and survive compaction). In the
    wrong/empty-DB case every local doc reads `not_found`; `pull` would mass-restore stale copies,
    `tombstone` would mass-delete. Skip is the only non-destructive action.
    *(user decision 2026-06-03, verified against live CouchDB)*
  Signal reliability verified against actual code: `runConverter` (converter.ts:256-264) seeds docs
  with `_id, _rev, mtime` via `bulkDocs({new_edits:false})`, preserving the exact CouchDB `_rev`
  per doc. After migration, `state.json` is renamed to `state.json.migrated`; the PouchDB local
  `_rev` IS the canonical revmap signal. The remote winning rev comes from the AC2.0 `fetchRemoteRevs`
  batched call — available without extra network round-trips.
  Commit decomposition note: Cycle 2's `ReconcileAction` needs a `kind: "tombstone"` action (for
  rev-equal/FS-absent → delete propagation). Cycle 3 wiring needs `bridge.reconcileTombstone(docId)`
  (or reuse `markDeletedInPouch` directly). Both changes are contained within commits 3 and 4 — no
  new commits required.
  *(replaces the trichotomy open question from Section 7 — user sign-off received)*
- **AC2.4** When **both sides changed** — local content ≠ local-PouchDB content **AND** local rev ≠
  **remote** rev (remote moved during downtime) — reconciliation is **non-destructive**: the remote
  rev stays as the synced copy (live sync will pull it), the local divergent copy is preserved as a
  conflict-copy file which is then pushed, and a diagnostics counter is incremented. **No silent
  mtime-LWW winner is picked, and the bridge's `resolveConflictsByMtime` is never reached for this
  case.** *(the data-integrity hinge — only detectable because of AC2.0)*
- **AC2.5** Reconciliation applies the **same exclusions** as the live path (ALWAYS_EXCLUDED + user
  `excludePatterns`), so `.git/`, `.DS_Store`, `.obsidian/`, `.trash/`, `.vault-sync*.json` are
  never re-pushed (does not undo the phantom-check).
- **AC2.6** Reconciliation runs **only when `isFirstRun()` is false**, **after** the converter
  completes, and **before** `bridge.start()` arms live events (respects #69's
  cold-PouchDB-before-events ordering). On first run it is skipped (the #72 two-phase pull owns
  population).
- **AC2.7** A file written by reconciliation does **not** echo back through the PouchDB→FS path
  (reuses the bridge's echo suppression).
- **AC2.8** A local doc with **no `content` field and no `_attachments`** (a converter-seeded,
  awaiting-replication stub) is **skipped**, never mass-pushed — guarding the single v1→v2
  post-migration boot from re-pushing the whole vault. *(the `doc_count>0` gate alone does not cover
  this)*

**Outcome 2 (RC1 — silent-stall recovery).**
*The daemon detects a live-sync that has stopped making progress while the server is reachable, and
forces a sync restart, so a transient connectivity stall that emits no `error` event self-heals
instead of requiring `launchctl kickstart -k`.*

- **AC1.1** (Gate) A real-artifact probe records whether live `db.sync(retry:true)` emits `error`
  on a mid-sync connectivity loss. The result is documented in the spike README and decides AC1.2.
- **AC1.2** A liveness watchdog: if no sync progress (`change`/`active`/`paused→ok`) is observed for
  a configurable interval **and** the remote is reachable (a cheap HEAD/`_up`-style probe succeeds),
  the engine cancels and recreates the sync handle. Verified against a real stall, not a
  manually-emitted event.
- **AC1.3** The watchdog is idempotent with the existing `scheduleRestart` backoff (no double
  handles), and `stop()` clears it (no timer leak).

**Outcome 3 (RC3 — live new-folder watching).**
*Files created in a folder that appears while the daemon is running are synced.*

- **AC3.1** (Gate) An integration test creates a new subdir under a watched root after `start()`,
  writes a file in it, and asserts the change event fires. Green → RC3 refuted (live case), no fix.
  Red → AC3.2.
- **AC3.2** (conditional) FsWatcher adds a watch for, or otherwise handles, directories created
  after start so files within them emit change events.

---

## 3. Implementation Approach per RC (TDD-decomposed)

The spine of RC2 is deliberately **minimal**: *synthesize the FS events the watcher missed during
downtime, and feed them through the path that already exists* (`PouchDbFsBridge.onVaultEvent` →
`writeTextToPouch`/`writeBinaryToPouch`/`markDeletedInPouch`). This reuses echo-suppression
(Level-1 rev sentinel), the Level-2 content-equality guard, and LWW conflict storage for free. The
**only new logic** is *detection* (what diverged) and *direction-safety* (which way, or neither).

### RC3 first (Cycle 1) — settle the empirical question cheaply

**Cycle 1 — RC3 live-watch probe** *(headless/daemon-integration.test.ts)*
- **Red:** new test — arm `FsWatcher` on a tmpdir, then `mkdirSync` a new subdir, write a file in
  it, assert a `change` event for that path fires (within the existing 2s FSEvents tolerance).
- **Green:** likely already passes (`fs.watch recursive` + FSEvents). If so: **RC3 refuted for the
  live case** — record in the plan/commit message; no production change. If it fails: minimal
  FsWatcher fix (add child-dir watch on dir-create) under a follow-up cycle.
- Files: `headless/daemon-integration.test.ts` (+ `headless/FsWatcher.ts` only if red).

### RC2 — reconciliation (Cycles 2-5), the core

**Cycle 2 — `reconcile.ts` detection module (pure, unit-tested, no I/O of its own)**
New module `headless/reconcile.ts`. A pure function that, given (a) the list of vault files from
`VaultAdapter.getFiles()`, (b) a local-PouchDB read of each doc's stored `content`/`_rev`/`size`,
(c) a **remote rev/deleted map** (`Map<docId, {rev, deleted}>` built once from
`makeHttpRemoteDb.allDocs` — see AC2.0), and (d) the exclusion predicate, returns a list of
**reconciliation actions**:
```
type ReconcileAction =
  | { kind: "push";          path: string }   // FS-only OR local-only change; safe to push
  | { kind: "pull";          path: string }   // remote moved during downtime, FS absent → write to disk
  | { kind: "tombstone";     docId: string }  // user deleted on disk, remote unchanged → propagate delete
  | { kind: "conflict-copy"; path: string }   // local AND remote both moved — non-destructive
  | { kind: "skip";          path: string;
      reason: "identical" | "excluded" | "awaiting-pull" | "remote-newer" | "both-absent" };
```
Decision rules — **content is the local arbiter, remote rev is the direction arbiter, mtime is
never used**:
- **Excluded path** → `skip:excluded`. *(AC2.5)* (checked first)
- **Local doc has no `content` and no `_attachments`** (converter-seeded stub) → `skip:awaiting-pull`.
  *(AC2.8 — prevents the v1→v2 post-migration mass-push)*
- **FS present, local-DB absent, remote absent** → `push`. *(AC2.1 — the 19 stranded files: never
  reached the server)*
- **FS present, local-DB absent, remote PRESENT (active)** → `skip:remote-newer` (live sync will
  pull it; do not push a file we have no local baseline for).
- **FS present (edited), remote reports `deleted:true` tombstone** → `conflict-copy`, **not**
  `skip:remote-newer`. Skipping would let live sync pull the deletion and remove an edited disk file
  — silent loss. Preserve the disk content as a conflict-copy and push it; let the user reconcile
  the intent. *(the previously-undefined cell; leans keep-over-delete per the data-loss bar)*
- **FS present, local-DB present, text:** compare disk content to local-DB `content` (string compare):
  - identical → `skip:identical` *(AC2.2 — kills the 253 false positives)*.
  - differ, AND **local `_rev` === remote `rev`** (remote did NOT move) → `push` (clean local edit).
  - differ, AND **local `_rev` !== remote `rev`** (remote ALSO moved during downtime) →
    `conflict-copy` *(AC2.4 — the only safe call; never the mtime resolver)*. Benign false-positive
    to expect: if a remote edit reached disk via Dropbox before localDB pulled it, this branch fires
    and duplicates a non-conflicting edit — the **safe** failure direction (a recoverable duplicate,
    never a clobber), so a conflict-copy counter reading >0 is not inherently alarming.
- **Binaries (the cost trap):** do **not** hash GBs of attachments on every boot. Compare `size`
  (doc meta vs `stat.size`); equal → `skip:identical`; differ → apply the same local-rev-vs-remote-rev
  direction test (`push` vs `conflict-copy`). Residual risk: a same-size content change is missed at
  reconcile time (rare; caught by any later live edit). A stored content-hash schema field would
  close this but is a doc-schema change — **YAGNI, out of scope**, noted in the module header.
- **local-DB present, FS absent** → apply the **rev-divergence rule** *(AC2.3)*:
  - `local _rev === remote winning rev` (remote unchanged) → user deleted on disk during outage →
    `tombstone` (propagate the delete; prevents "doublons qui reviennent").
  - `local _rev !== remote winning rev` (remote moved during outage) → daemon missed a remote
    creation/edit → `pull` (write remote content to disk; do NOT delete).
  - No local doc (never in revmap) → no `_rev` baseline → treat as remote-changed → `pull`.
  - Remote is a tombstone + FS absent → `skip:both-absent` (no-op).
  - Remote is a tombstone + FS present with edits → `conflict-copy` (keep-over-delete).
- **Perf note (name, do not pre-build):** content-as-arbiter forces reading disk + localDB content
  for every non-excluded file each boot (≈2× full-text-vault read). Correct but potentially slow. A
  tempting mtime-equality fast-path (skip files where disk mtime == stored mtime) **must not be added
  preemptively** — it reintroduces exactly the mtime dependency the 253-file evidence taught us to
  distrust, for an unmeasured perf win. Evaluate against real boot timing only if slow; YAGNI
  otherwise. The bridge's existing exact-string Level-2 compare is the known-good primitive to reuse.
- Tests: table-driven over every (FS × local-DB × remote-rev × content/size) combination, including
  identical-content/different-mtime, the both-sides (local≠localDB AND localrev≠remoterev) case, the
  content-less stub, FS-only-vs-remote-present, and the remote-tombstone-with-edited-disk case.
  Mocked local PouchDB `get` + a plain remote-rev `Map` (existing converter.test mock patterns).
  No filesystem, no network.

**Cycle 3 — wire reconciliation into startup behind the non-first-run gate**
Extend `runDaemonV2Startup` (or a sibling `runReconcileOnStartup` it calls) to:
1. run `runConverter` (unchanged),
2. **if `db.info().doc_count > 0`** (non-first-run): build the remote rev map over the key set
   **`union(localDocIds, vaultFileDocIds)`** (AC2.0) using the converter's **batched + retried**
   allDocs loop (AC2.0-bis — extract that loop from `runConverter` into a shared
   `fetchRemoteRevs(remoteDb, ids)` helper so both the phantom-check and reconcile use one batching
   path; the converter already constructs `remoteDb`, reuse the instance), run `reconcile`, then for
   each action:
   - `push` → `bridge.reconcilePush(path)` (thin public method reusing `onVaultEvent`'s change branch)
   - `pull` → `bridge.reconcilePull(docId, path)` (write remote content from local PouchDB to FS, then mark in echo-suppression map)
   - `tombstone` → `bridge.reconcileTombstone(docId)` (call `markDeletedInPouch` or equivalent; live sync replicates)
   - `conflict-copy` → write conflict-copy file, then `bridge.reconcilePush(conflictCopyPath)`
3. `bridge.start(fsWatcher)`,
4. `engine.start()`.
Ordering respects #69 (converter on cold PouchDB before any writer; reconciliation reads remote revs
read-only and writes only to **local** PouchDB, then live `db.sync` replicates — the same shape as
the old `fullSync`: remote-revs-first, then push). If the remote-rev fetch fails (CouchDB
unreachable), reconcile is **skipped this boot** (logged) and the daemon proceeds to live sync — a
later restart reconciles; never push blind without remote knowledge.
- **Red:** integration test (real `FilesystemVaultAdapter` + tmpdir + mock PouchDB, the
  `daemon-integration.test.ts` harness): pre-seed local PouchDB with doc A, supply a stub remote-rev
  map (A present same rev, B/C absent or matching), put files A (identical), B (new on disk), and
  C-modified on disk; run the startup reconcile; assert B and C-modified land in PouchDB, A does not
  get a redundant write, and a DB-only doc D is not tombstoned.
- **Green:** implement the wiring (remote-rev fetch + reconcile call) + `bridge.reconcilePush`.
- Files: `headless/main.ts`, `src/PouchDbFsBridge.ts` (add `reconcilePush`), `headless/main.test.ts`
  (ordering/gate unit test), `headless/daemon-integration.test.ts` (end-to-end).

**Cycle 4 — non-destructive conflict handling (AC2.4) + echo no-op proof (AC2.7)**
- **Red:** test the both-sides-changed branch end-to-end: local PouchDB has content X / rev R for
  path P, the **remote rev map reports a DIFFERENT rev R'** for P (remote moved during downtime),
  and disk has divergent content Y. Reconcile must (i) leave the synced doc as remote-rev lineage
  (do not overwrite the local doc — live sync pulls R'), (ii) create a conflict-copy file (e.g.
  `P (reconcile-conflict <ts>).md`), (iii) `reconcilePush` that copy, (iv) bump a diagnostics
  counter; and a separate test proving a reconciliation-pushed file does **not** loop back through
  the PouchDB→FS apply path (echo suppression holds for the synthesized write). A control test:
  local≠localDB but **localrev === remoterev** (remote did not move) → plain `push`, no conflict-copy.
- **Green:** conflict-copy writer (reuse `VaultAdapter.createText`); diagnostics counter field on
  the engine/`SyncDiagnostics` (additive — see RC collision note on #72 below).
- Files: `headless/reconcile.ts`, `src/PouchDbFsBridge.ts`, `src/types.ts` (one additive field),
  `headless/daemon-integration.test.ts`.

### RC1 — silent-stall watchdog (Cycle R1.0 gate, then R1.1)

**Cycle R1.0 — REAL-ARTIFACT probe: does live `db.sync(retry:true)` emit `error` on a stall?**
*(spike, not a unit test — `spikes/resilience-verify/`)* New probe modeled on
`verify-engine-resume.mjs`, but kill CouchDB **during live `db.sync`** (after phase-1 completes),
not during phase-1. Record whether `error` fires, whether `paused` fires, and whether the handle
ever resumes on its own when CouchDB returns. Document the answer in the spike README. **This gates
the RC1 design** and is the only step that could change a factual claim in this plan.
- If `error` **does** fire reliably and resume works → `scheduleRestart("live")` already suffices;
  RC1 reduces to documentation (close as "already fixed by #74"). 
- If `error` is swallowed / no self-resume → proceed to R1.1.

**Cycle R1.1 — liveness watchdog (only if R1.0 shows a silent stall)**
- **Red:** engine test — start live sync, advance fake timers past the watchdog interval with no
  `change`/`active` and a reachable-remote stub returning true; assert the engine cancels and
  recreates the sync handle (`db.sync` called a second time). A companion test: progress observed
  within the interval → no forced restart. A third: `stop()` clears the watchdog timer (no leak,
  mirroring the existing `stop()`-clears-backoff test at engine.test.ts:777).
- **Green:** a `WATCHDOG_INTERVAL_MS` timer reset on every `change`/`active`; on expiry, a cheap
  reachability probe (reuse the `makeHttpRemoteDb`/node-http pattern from main.ts for a HEAD or
  `_up`); if reachable, `cancelSync()` + `startLiveSync()`. Idempotent with `scheduleRestart`
  (share the single-handle invariant; never two live handles). *(AC1.2, AC1.3)*
- Files: `src/PouchDbSyncEngine.ts`, `src/PouchDbSyncEngine.test.ts`.

**RC1b — launchd recovery documentation (no code).** Add a note (release notes / README) that the
converter `throw → process.exit(1)` path is intentionally recovered by launchd `KeepAlive`
(verified: plist has `KeepAlive=true`, no `ThrottleInterval` → ~10s relaunch). No change.

---

## 4. Collision Check with In-Flight Work

- **`planning/v2-unify-pouchdb-plan.md` (#69):** the cold-PouchDB-before-`bridge.start` ordering is
  load-bearing (init-race / silent partial seed). RC2's reconciliation is inserted **after** the
  converter and writes only to the **local** PouchDB, so it does not reintroduce the race. AC2.6
  pins this ordering and is guarded by the existing `runDaemonV2Startup` ordering test
  (main.test.ts:174-212). No conflict.
- **`planning/mobile-text-first-plan.md` (#72):** owns **first-run** population (two-phase
  text-then-binary pull) and adds `syncPhase`/`binaryProgress` to `SyncDiagnostics`. RC2
  reconciliation runs **only when `isFirstRun()` is false** (AC2.6) — the clean line that avoids
  collision: first run = #72's job, restart = this plan's job. The one `SyncDiagnostics` field RC2
  adds (reconcile-conflict counter) is **additive** and must be appended in the same spirit as #72's
  fields (set to `0`/`null` everywhere `getDiagnostics()` is constructed) so neither plan breaks the
  other's type-completeness. RC1's watchdog touches `startLiveSync()` — #72 explicitly states
  "`startLiveSync()` is unchanged" by its work, so the watchdog is a clean addition, but **land RC1
  after #72's engine commits** if both are in flight to avoid merge churn in the same method.

---

## 5. Complexity Estimate (relative — no time estimates)

Scale anchored on the existing converter/FsWatcher/#74 work already in the repo.

```
RC / Cycle                              Size   Anchor / rationale
--------------------------------------  -----  ----------------------------------------------
Cycle 1  RC3 empirical probe            XS     One integration test; likely no production code
Cycle 2  reconcile.ts detection (pure)  M      ~ converter.ts in spirit: pure module + table
                                               tests. The decision matrix (incl. remote-rev
                                               direction + tombstone cell) is the substance.
Cycle 3  wire into startup + gate +     S-M    Wiring mirrors runDaemonV2Startup; the added work is
         extract fetchRemoteRevs               extracting the converter's batched allDocs loop into
                                               a shared helper (union key set, batched/retried).
Cycle 4  non-destructive conflict +     S      Reuses VaultAdapter + bridge echo path; small
         echo no-op proof                      conflict-copy writer + 1 diagnostics field
Cycle R1.0 live-stall probe (spike)     S      Adapt verify-engine-resume.mjs; the decisive
                                               unknown. Effort is in interpreting, not coding.
Cycle R1.1 watchdog (conditional)       S-M    ~ #74 backoff in size; timer + reachability probe
                                               + idempotency with existing scheduleRestart
```
Total ≈ one **M** (the detection matrix) surrounded by **S/XS** wiring and tests. Comparable in
total to the #74 resilience work, **smaller** than the #69 migration. The risk/complexity is
concentrated in RC2's **decision rules**, not in line count.

---

## 6. Suggested Commit Decomposition (one concern per commit)

```
1  test(daemon): probe live new-folder watching (RC3 empirical gate)        [Cycle 1]
   - daemon-integration.test.ts. If green: commit message records RC3 refuted (live case).

2  refactor(converter): extract batched+retried fetchRemoteRevs helper       [Cycle 3 prep]
   - lift the PHANTOM_BATCH_SIZE loop (batch/retry/backoff/delay) out of runConverter into a
     shared fetchRemoteRevs(remoteDb, ids). Behavior-preserving; converter's phantom-check now
     calls it. Unblocks reconcile reusing the SAME batching (AC2.0-bis). Existing converter tests
     stay green; add a test for a large key set exercising multiple batches.

3  feat(reconcile): pure FS<->PouchDB divergence detection module           [Cycle 2]
   - headless/reconcile.ts + headless/reconcile.test.ts (table-driven, mocked local db + remote
     rev Map). content-is-arbiter, remote-rev=direction-arbiter, size-compare for binaries,
     rev-divergence delete rule (tombstone vs pull vs skip:both-absent), both-sides=conflict-copy,
     content-less-stub skip, tombstone+edit=conflict-copy, never-in-revmap→pull.
   - ReconcileAction includes: push | pull | tombstone | conflict-copy | skip.

4  feat(daemon): run startup reconciliation on restart (non-first-run gate) [Cycle 3]
   - headless/main.ts wiring (after converter, before bridge.start; gated on doc_count>0;
     remote-rev map over union(local,disk) ids via fetchRemoteRevs; skip-on-fetch-fail).
   - src/PouchDbFsBridge.ts: reconcilePush(), reconcilePull(), reconcileTombstone() public entries
     reusing existing onVaultEvent change/delete paths and echo-suppression map.
   - main.test.ts ordering/gate test + daemon-integration.test.ts end-to-end (stranded-files repro,
     downtime-delete propagation, downtime-remote-edit pull).

5  feat(reconcile): non-destructive conflict handling + diagnostics counter [Cycle 4]
   - conflict-copy writer; additive SyncDiagnostics field; echo no-op proof.

6  test(spike): probe live db.sync(retry:true) error emission on stall      [Cycle R1.0]
   - spikes/resilience-verify/. Documents the RC1a answer; gates commit 7.

7  feat(sync-engine): liveness watchdog for silent live-sync stall          [Cycle R1.1, conditional]
   - src/PouchDbSyncEngine.ts + tests. ONLY if commit 6 shows a silent stall.

8  docs: document launchd KeepAlive recovery for converter-abort path (RC1b)
   - README / release notes. No code.

(+ rebuild dist + version bump + gh release per CLAUDE.md release workflow, as a final chore commit.)
```
Commits 1, 2, 6, 8 are independently shippable and low-risk. Commit 4 is the behavioral core and
should pair with USER validation on the real Mantu vault before release (recreate the
stranded-files scenario: stop daemon, edit files, restart, confirm they push).

---

## 7. Risks & How Tests Cover Them

```
Risk                                              Coverage
------------------------------------------------  ---------------------------------------------------
mtime false-positives push older-over-newer       AC2.2 test: identical content / different mtime →
  (the 253-file trap)                               NO write. Content is the arbiter, mtime ignored
                                                     END TO END — direction uses remote rev (AC2.0),
                                                     never the mtime resolver.
Both-sides conflict routes into the distrusted     AC2.0 + AC2.4: reconcile reads remote revs FIRST;
  mtime-LWW resolver (silent data loss)             local≠localDB AND localrev≠remoterev →
                                                     conflict-copy, so resolveConflictsByMtime is
                                                     never reached for the downtime-both-sides case.
Reconcile tombstones a remote-edited file          AC2.3 test: DB-present/FS-absent + local-rev ≠
  (daemon missed a remote write, treats it as       remote-rev → action is `pull`, not `tombstone`.
  user-delete → irreversible remote loss)           Rev-divergence is the gate; blanket-delete is
                                                    never the default.
Downtime deletion never propagates → permanent     AC2.3 test: DB-present/FS-absent + local-rev ==
  SILENT divergence ("doublons qui reviennent"      remote-rev → action is `tombstone` (propagate);
  hazard if file is blanket-resurrected)            rev-unchanged proves user deleted, not daemon miss.
                                                    The "leave divergent" skew is eliminated: the rule
                                                    decides deterministically from the rev signal.
Post-migration mass-push of whole vault           AC2.8 test: content-less seeded stub → skip;
  (v1→v2 boot, content-less seeded docs)            non-first-run gate alone does NOT cover this.
Stranded files never queried (remote key set =     AC2.0: key set = union(localDocIds, vaultFileDocIds);
  localDocIds) → blind push of cross-device docs     a disk file with no local doc IS queried, so
  → reopens mtime hole for the NORMAL multi-device   remote-present is detectable. Test: stranded file
  post-outage case                                   whose docId is remote-present → skip, not push.
Single 14k-key allDocs POST times out every boot   AC2.0-bis: reuse converter's batched+retried loop
  → fallback fires → feature silently dead on prod   (extract fetchRemoteRevs). Verify with a large
  while mocked tests stay green (Vert ≠ couvert)      key set / forced-timeout path, not a 3-doc mock.
Remote tombstone + edited disk file → silent       Cycle 2 rule: tombstone + edited disk → conflict-
  delete of the edit                                 copy, not skip:remote-newer (keep-over-delete).
Push blind when remote unknown (CouchDB down       Cycle 3: remote-rev fetch failure → skip reconcile
  at boot)                                          this boot, log, proceed to live sync; never push
                                                     without remote knowledge. Retried next restart.
Both-sides-changed clobbers one side              AC2.4 test: divergent both-sides → conflict-copy
  (Dropbox conflict-copy hazard)                    preserved + counter; no silent LWW winner.
Reconcile re-pushes .git/.DS_Store (undoes        AC2.5 test: excluded paths → skip; same
  phantom-check, pollutes CouchDB)                  ALWAYS_EXCLUDED + user patterns as live path.
Reconcile reintroduces the #69 init-race          AC2.6 + existing runDaemonV2Startup ordering test:
  (cold-PouchDB-before-events)                      converter first, reconcile writes local, then
                                                     bridge.start.
Reconcile-pushed file echoes back / loops         AC2.7 test: synthesized write does not loop through
                                                     PouchDB->FS apply (echo suppression holds).
Binary reconciliation hashes GBs on every boot    Cycle 2 design: size-compare only; residual
  (perf)                                            same-size-change miss documented as accepted.
RC1 watchdog is dead code (retry:true emits        Cycle R1.0 real-artifact probe GATES R1.1 — no
  error, self-resumes) OR mis-fires                 watchdog built unless a real silent stall is
                                                     observed; R1.1 verified against a real stall,
                                                     not a manually-emitted event.
RC1 watchdog double-restarts / leaks timers       AC1.3 tests: idempotent with scheduleRestart;
                                                     stop() clears watchdog (mirrors existing
                                                     stop()-clears-backoff test).
Collides with #72 first-run population            Non-first-run gate (AC2.6); additive diagnostics
                                                     field; land RC1 after #72 engine commits.
RC3 over-fixed (building a fix that isn't needed)  Cycle 1 gate test refutes-or-confirms before any
                                                     production change.
```

**AC2.3 delete-during-outage — RESOLVED.** The rev-divergence rule replaces the trichotomy:
- `local _rev === remote winning rev` AND FS absent → user deleted during outage → **propagate
  (tombstone)**. Prevents "doublons qui reviennent"; honors user intent.
- `local _rev !== remote winning rev` AND FS absent → remote created/edited during outage → **pull
  to disk**. Daemon missed a remote write; restoring it is correct.
- No local doc (never in revmap) → **pull to disk** (brand-new remote creation).
- Remote tombstone + FS absent → **skip** (both gone, nothing to do).
- Remote tombstone + FS present with edits → **conflict-copy** (keep-over-delete).

Signal: PouchDB local `_rev` = last-synced CouchDB revision (migrated verbatim by `runConverter`
via `bulkDocs({new_edits:false})`; `state.json` renamed to `.migrated`). Remote winning rev is
already in hand from the AC2.0 `fetchRemoteRevs` call. Verified in converter.ts:256-264. No
additional network round-trips needed. **No further sign-off required; commit 4 is unblocked.**

USER VALIDATION gate that REMAINS before commit 4 ships: recreate the stranded-files scenario on
the real Mantu vault (stop daemon, edit files, restart, confirm they push — and separately confirm
a file deleted during downtime is tombstoned, not resurrected).
