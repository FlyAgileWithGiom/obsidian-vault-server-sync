# v2.0 Plan: Unify Sync Stack on PouchDB Everywhere

**Issue**: #69  
**Branch**: v2/architect-plan  
**Baseline**: v1.14.0 — 319 tests passing, 13 test files

---

## 1. Conceptual Diff: v1.14 → v2.0

### Files Deleted

```
src/sync-engine.ts           (2067 lines — CustomFetchSyncStrategy + legacy SyncEngine alias)
src/couch-client.ts          (216 lines — CouchClient + CouchError)
src/couch-client.test.ts     (test coverage for above)
src/sync-strategy.ts         (70 lines — SyncStrategy interface port, collapsed into concrete class)
src/sync-engine.test.ts      (bulk of test surface: ~2000 lines CustomFetch tests)
src/strategy-integration.test.ts  (routing logic tests, replaced by simpler single-strategy test)
src/ObsidianStateStore.ts    (23 lines — localStorage StateStore, no longer needed by plugin)
src/ObsidianTransport.ts     (40 lines — Obsidian requestUrl HttpTransport, no longer needed)
src/ObsidianTransport.test.ts
headless/FetchTransport.ts   (35 lines — Node fetch HttpTransport, no longer needed)
headless/StateStore.ts       (60 lines — JSON file StateStore, replaced by PouchDB state)
headless/StateStore.test.ts
```

### Files Modified

```
src/main.ts
  - Remove: import CouchClient, CustomFetchSyncStrategy, ObsidianStateStore, ObsidianTransport
  - Remove: createStrategy() Platform.isMobile branching
  - Remove: (this.strategy as CustomFetchSyncStrategy).replaceLocalFromServer() cast
  - Add:    direct construction of PouchDbSyncEngine
  - Add:    replaceLocalFromServer() delegates to PouchDbSyncEngine.replaceLocalFromServer()

src/types.ts
  - Remove: syncStrategy?: 'auto' | 'custom' | 'pouchdb' setting field
  - Remove: RevMap, RevMapEntry types (CustomFetch only)
  - Remove: StateStore, HttpTransport, HttpResponse interfaces (CustomFetch infra)
  - Keep:   VaultSyncSettings, SyncState, SyncCounts, SyncDiagnostics, VaultAdapter, etc.

src/PouchDbSyncStrategy.ts  -> renamed src/PouchDbSyncEngine.ts
  - Rename class PouchDbSyncStrategy -> PouchDbSyncEngine
  - Remove: implements SyncStrategy (interface deleted)
  - Add:    replaceLocalFromServer(): destroy local DB + runInitialPull() (see Risk 6)

src/PouchDbFsBridge.ts
  - Modify: register(plugin) -> start(watcher, vaultAdapter) (platform-neutral)
  - Add:    WatcherAdapter port wiring (see architecture section)
  - Modify: echo-loop suppression: replace TTL Map<path,timestamp> with in-memory Map<docId,rev>
  - Add:    LWW-by-mtime conflict resolver

headless/main.ts
  - Remove: CustomFetchSyncStrategy import and all engine usage
  - Remove: JsonStateStore, FetchTransport imports
  - Add:    pouchdb-node import + LevelDB PouchDB construction
  - Add:    PouchDbSyncEngine construction (daemon variant)
  - Modify: createWatcher() -> FsWatcher class
  - Add:    converter invocation before engine start
  - Add:    PouchDB DB path resolution (AppSupport/<dbName>/pouch/)

package.json
  - Add:    "pouchdb-node": "^9.0.0" to dependencies
  - Keep:   "pouchdb-browser": "^9.0.0" (used by plugin)
```

### Files Created

```
src/WatcherAdapter.ts            (VaultWatcher port interface)
src/ObsidianVaultWatcher.ts      (Obsidian vault.on("modify",...) impl)
headless/FsWatcher.ts            (fs.watch impl — replaces createWatcher() inline code)
headless/FsWatcher.test.ts
src/PouchDbSyncEngine.ts         (rename + refactor of PouchDbSyncStrategy.ts)
headless/converter.ts            (state.json revMap -> PouchDB local docs migration)
headless/converter.test.ts
```

### Files Unchanged

```
src/doc-id.ts               (unchanged — shared utility)
src/doc-builder.ts          (unchanged — shared utility)
src/binary-ext.ts           (unchanged — shared utility)
src/ObsidianVaultAdapter.ts (unchanged — still used by plugin)
headless/VaultAdapter.ts    (unchanged — still used by daemon)
scripts/postbuild-kickstart.mjs  (unchanged)
```

---

## 2. Target Architecture

### 2.1 Runtime Topology

```
  PLUGIN (iOS + Mac — same code path)          DAEMON (Mac headless)
  ──────────────────────────────────────────   ──────────────────────────────────
  Obsidian process (Electron/Capacitor)         Node 18 process (dist/headless.js)
  |                                             |
  +- PouchDbSyncEngine                          +- PouchDbSyncEngine (daemon variant)
  |   +- db: PouchDB (pouchdb-browser)          |   +- db: PouchDB (pouchdb-node + LevelDB)
  |   |      IndexedDB adapter                  |   |      ~/Library/Application Support/
  |   |                                         |   |      vault-sync-daemon/<dbName>/pouch/
  |   +- PouchDbFsBridge                        |   +- PouchDbFsBridge (shared)
  |   |   +- ObsidianVaultAdapter               |   |   +- FilesystemVaultAdapter (existing)
  |   |   +- ObsidianVaultWatcher               |   |   +- FsWatcher (fs.watch, recursive)
  |   |                                         |   |
  |   +- db.sync(remoteUrl, live+retry) ----->  +- db.sync(remoteUrl, live+retry)
  |                                             |         |
  +-------------------------------------------> CouchDB (remote)
```

### 2.2 WatcherAdapter Port

New interface in `src/WatcherAdapter.ts`:

```typescript
export type FileEvent = { type: "change" | "delete"; path: string };

export interface VaultWatcher {
  /** Start watching. Handler called for each FS change after debounce. */
  start(handler: (event: FileEvent) => void): void;
  stop(): void;
}
```

`ObsidianVaultWatcher` wraps `plugin.app.vault.on("modify"|"create"|"delete"|"rename")`.  
`FsWatcher` wraps `fs.watch(root, {recursive:true})` — mirrors current `createWatcher()` in `headless/main.ts`, same 100ms debounce, same exclusion logic.

`PouchDbFsBridge.register(plugin)` is replaced with `PouchDbFsBridge.start(watcher, vaultAdapter)` — no Obsidian Plugin reference in bridge core. This is the "platform-neutral extraction" required by issue #69 AC.

### 2.3 LWW-by-mtime on PouchDB Conflicts

PouchDB's internal conflict resolution picks winner by `_rev` string sort (arbitrary vs wall-clock time). v2.0 applies LWW-by-mtime on top as a post-conflict hook:

Location: `PouchDbFsBridge`, called in `applyRemoteChange()` before writing to FS:

```typescript
// If PouchDB reports _conflicts on this doc, resolve by mtime before applying to FS.
if (doc._conflicts?.length) {
  await resolveConflictsByMtime(db, doc);
}
```

`resolveConflictsByMtime(db, doc)`:
1. Fetch all conflict revisions via `db.get(id, {open_revs:"all"})`
2. Pick doc with highest `mtime` field
3. Delete losing revisions via `db.put({...loser, _deleted:true})`
4. If winner is not the current `_rev` the change-feed delivered, re-read the winner for FS write

This gives LWW semantics on top of PouchDB's conflict storage. Cost: one extra `db.get` per conflicted doc — negligible in steady state (conflicts are rare, only on simultaneous edits from multiple devices before sync catches up).

### 2.4 Echo-Loop Sentinel Design

**Decision divergence from user spec**: The user specified `_writtenBy: "daemon"` on the PouchDB doc. This approach creates a correctness problem: mutating the PouchDB doc creates a new `_rev`, which fires its own `db.changes()` event — a second loop iteration. The field also replicates to CouchDB and all other devices, adding one full round-trip of write amplification per remote-applied change.

**Chosen approach**: In-memory `Map<docId, appliedRev>` on the bridge:

```
Remote change arrives (docId, _rev, content) from db.changes()
  -> bridge stores: appliedRevs.set(docId, _rev)   [BEFORE vault write]
  -> bridge writes file to FS
  -> FS watcher fires for path
    -> bridge computes docId = pathToDocId(path)
    -> db.get(docId) -> doc._rev
    -> if appliedRevs.get(docId) === doc._rev -> skip (echo suppressed)
    -> else -> write to PouchDB (genuine local edit)
  -> appliedRevs entry TTL-cleaned after 5s
```

**Race condition analysis**: `appliedRevs.set(docId, rev)` is stored BEFORE `vault.write()`. FSEvents latency is 50-200ms on macOS. The sentinel is always in memory by the time the watcher fires. A concurrent genuine edit for the same docId arrives with a different `_rev` -> sentinel check fails -> write proceeds. Thread-safe: Node.js single-threaded event loop.

**Why not PouchDB doc mutation**: Preserves the user's intent (echo suppression without timing dependency) without replication pollution or self-loop. Flagged as D1 in Section 9.

### 2.5 Migration: state.json revMap -> PouchDB

**Goal**: Upgrade daemon from v1.14.0 without re-pulling ~14k docs.

**state.json structure** (JsonStateStore format):
```json
{
  "vault-sync-revmap": "{\"file/foo.md\":{\"state\":\"known\",\"rev\":\"2-abc\",\"mtime\":1234},…}",
  "vault-sync-last-seq": "\"1234-xyz\""
}
```

**Converter algorithm** (`headless/converter.ts`):

```
function runConverter(statePath, db):
  1. Read statePath -> JSON -> parse "vault-sync-revmap" key -> RevMap object
     If read fails / malformed JSON -> return 0 (no-op, PouchDB will fresh-pull)
  2. If db.info().doc_count > 0 -> return 0 (idempotent: already migrated)
  3. Filter RevMap: keep only entries with state === "known"
     - tombstoned: PouchDB will pull their deletion on first sync (correct)
     - orphan:     were already problematic; let PouchDB resolve
  4. For each known entry {docId, rev, mtime}:
     Build stub: { _id: docId, _rev: rev, content: "(migrated)", mtime: mtime, deleted: false }
     [Stub tells PouchDB "I have this rev" so it skips re-pulling unchanged docs.
      If remote has a newer _rev, PouchDB pulls the diff. Correct in both cases.]
  5. db.bulkDocs({docs: stubs, new_edits: false})
     [new_edits:false is critical: inserts at exact _rev without PouchDB's revision validation]
  6. Rename state.json to state.json.migrated (backup, not delete)
  7. Write marker file: pouch/.migration-complete (sentinel for idempotency across restarts)
  8. Return count of docs migrated

Triggers: state.json exists AND db.info().doc_count === 0 AND no .migration-complete marker
```

**Replication checkpoint**: The first `db.sync()` after conversion starts from `since=0` (CouchDB change feed). For 14k docs, this walks ~14k change entries server-side (no doc bodies fetched, just rev comparison). Estimated cost: 2-5 seconds. Accepted for v2.0 — see D2 in Section 9.

**Failure modes**:
- `bulkDocs` partial failure -> no rename, converter re-runs on next start (idempotent via doc_count check)
- state.json gone but PouchDB empty (crashed mid-rename) -> fresh PouchDB pull (14k docs re-pulled; bandwidth cost but no data loss)
- CouchDB unreachable -> engine.start() fails as usual (existing behavior)

**Rollback**: Copy `state.json.migrated` back to `state.json`, downgrade daemon to v1.14.0 binary.

---

## 3. Commit Sequence (10 atomic commits)

Each commit compiles cleanly. Each step from C06 onward is independently shippable.

```
C01  refactor: extract VaultWatcher port + ObsidianVaultWatcher + FsWatcher impls
     Files: src/WatcherAdapter.ts (new), src/ObsidianVaultWatcher.ts (new),
            headless/FsWatcher.ts (new), headless/FsWatcher.test.ts (new),
            src/PouchDbFsBridge.ts (modify register(plugin) -> start(watcher, vaultAdapter))
     Behavior: zero behavior change — structural extraction only
     Tests: existing PouchDbFsBridge tests pass; new FsWatcher unit tests

C02  refactor: upgrade echo-loop suppression to in-memory rev sentinel
     Files: src/PouchDbFsBridge.ts
     Tests: existing echo-suppression tests updated; new sentinel tests added
     Behavior: more robust echo suppression (no timing-dependent TTL misses)

C03  feat: add LWW-by-mtime conflict resolver in PouchDbFsBridge
     Files: src/PouchDbFsBridge.ts, src/PouchDbFsBridge.test.ts
     Tests: new conflict-resolution tests
     Behavior: deterministic LWW when two devices edit same file simultaneously

C04  feat: add headless converter (state.json revMap -> PouchDB local docs)
     Files: headless/converter.ts (new), headless/converter.test.ts (new)
     Tests: unit tests (in-memory PouchDB via pouchdb-memory in tests)
     Behavior: pure module, not yet wired into daemon

C05  refactor: rename PouchDbSyncStrategy -> PouchDbSyncEngine, drop SyncStrategy interface
     Files: src/PouchDbSyncStrategy.ts -> src/PouchDbSyncEngine.ts (rename + refactor),
            src/PouchDbSyncStrategy.test.ts -> src/PouchDbSyncEngine.test.ts (rename),
            src/sync-strategy.ts (delete),
            src/main.ts (update import + remove interface reference),
            src/PouchDbFsBridge.ts (remove SyncStrategy import if any)
     Add: PouchDbSyncEngine.replaceLocalFromServer() method (db.destroy + runInitialPull)
     Tests: all pass with renamed class

C06  feat: wire daemon to PouchDB + pouchdb-node + converter (behind DAEMON_V2=1 env flag)
     Files: headless/main.ts (fork startup path on DAEMON_V2=1),
            package.json (add pouchdb-node),
            esbuild.config.mjs (add external:leveldown, external:fsevents)
     Tests: headless/main.test.ts covers v2 startup path

     *** USER GATE 1: validate converter on real ~14k doc vault ***

C07  feat: flip plugin default — PouchDB on all platforms, remove Platform.isMobile branch
     Files: src/main.ts (remove createStrategy() branching, direct PouchDbSyncEngine),
            src/types.ts (remove syncStrategy field)
     Tests: strategy-integration.test.ts simplified or deleted; single-path test added
     Behavior: Mac plugin now uses PouchDB; CustomFetch still exists in codebase

C08  chore: delete CustomFetch engine, couch-client, and all legacy infra
     Files: src/sync-engine.ts (delete), src/couch-client.ts (delete),
            src/sync-engine.test.ts (delete), src/couch-client.test.ts (delete),
            src/ObsidianStateStore.ts (delete), src/ObsidianTransport.ts (delete),
            src/ObsidianTransport.test.ts (delete), src/strategy-integration.test.ts (delete),
            headless/FetchTransport.ts (delete),
            headless/StateStore.ts (delete), headless/StateStore.test.ts (delete),
            headless/main.ts (remove DAEMON_V2 branch + CustomFetch startup),
            src/types.ts (remove RevMap/RevMapEntry/StateStore/HttpTransport/HttpResponse)
     Tests: remaining ~150-180 tests green

C09  chore: simplify esbuild config, update comments and docs
     Files: esbuild.config.mjs (remove now-irrelevant comments about splitting strategy),
            README.md (update daemon install docs: leveldown native add-on),
            src/doc-id.ts, src/doc-builder.ts (update JSDoc: remove CustomFetch references),
            src/binary-ext.ts (same)
     Tests: unchanged

C10  chore: bump version to 2.0.0
     Files: package.json (version: "2.0.0"), manifest.json
     Tests: full suite green (final count: ~150-180 tests)
```

**Prerequisite graph**:
- C01 is prerequisite for C06 (FsWatcher used in daemon bridge)
- C02 should precede C06 (daemon uses upgraded echo suppression)
- C03 can run parallel to C02 (different methods in PouchDbFsBridge)
- C04 is prerequisite for C06 (converter wired in C06)
- C05 can run parallel to C04 (different files)
- C06 -> USER GATE 1 -> C07 -> C08 -> C09 -> C10 (sequential)

**Safe shipping states**:
- After C05: v1.14.1 if hotfix needed (no behavior change)
- After C06 (DAEMON_V2=1): canary daemon in PouchDB mode; plugin unchanged
- After C07: v1.15.0 candidate (plugin unified, CustomFetch still in bundle as fallback)
- After C08: v2.0.0 (CustomFetch permanently gone)

---

## 4. Test Strategy

### 4.1 Tests to Delete (C08)

```
src/sync-engine.test.ts           ~150+ test cases — entire CustomFetchSyncStrategy suite
src/couch-client.test.ts          CouchDB HTTP client tests
src/strategy-integration.test.ts  Platform.isMobile routing tests
headless/StateStore.test.ts       JsonStateStore tests
src/ObsidianTransport.test.ts     ObsidianTransport tests
```

### 4.2 Tests to Keep / Migrate

| Test File | Status | Action |
|---|---|---|
| `src/PouchDbFsBridge.test.ts` | Keep + extend | Add sentinel tests (C02), LWW conflict tests (C03) |
| `src/PouchDbSyncStrategy.test.ts` | Rename | -> `PouchDbSyncEngine.test.ts`, update class name refs (C05) |
| `src/scenarios/sync-resilience.test.ts` | Keep | Verify passes after engine rename |
| `headless/main.test.ts` | Keep + extend | v2 startup path tests (C06); remove CustomFetch path (C08) |
| `headless/heartbeat.test.ts` | Keep | Unchanged |
| `src/settings-tab.test.ts` | Keep + prune | Remove CustomFetch diagnostics stub references |

### 4.3 New Tests to Write

**C01 — FsWatcher unit tests** (`headless/FsWatcher.test.ts`):
- Debounce: rapid events on same path -> single handler call
- Delete event: `stat()` fails -> `{type:"delete", path}`
- Modify event: `stat()` succeeds -> `{type:"change", path}`
- Exclusions: excluded paths not forwarded
- `stop()`: watcher.close() called, no further events emitted

**C02 — Sentinel echo-suppression tests** (additions to `PouchDbFsBridge.test.ts`):
- Remote change written to FS -> FS event suppressed (appliedRev matches current rev)
- Genuine local edit after remote write -> FS event forwarded (appliedRev != current rev)
- TTL expiry: appliedRev cleared after 5s -> subsequent events forwarded
- Concurrent edit of different docId -> independent suppression

**C03 — LWW conflict resolver tests** (additions to `PouchDbFsBridge.test.ts`):
- No conflicts: resolver not called
- Two conflict revs, local has higher mtime -> local wins, losing rev deleted
- Two conflict revs, remote has higher mtime -> remote wins, local deleted
- Tied mtime -> deterministic winner by `_rev` lexicographic order

**C04 — Converter unit tests** (`headless/converter.test.ts`):
- Empty state.json -> no-op, returns 0
- Malformed JSON -> no-op, returns 0
- Valid revMap with 3 known entries -> 3 docs inserted via `bulkDocs(new_edits:false)`
- Tombstoned entries -> not inserted
- Orphan entries -> not inserted
- PouchDB already has docs -> idempotent no-op, returns 0
- state.json renamed to .migrated after success (not deleted)
- .migration-complete marker written to pouch/ dir

**C06 — Daemon v2 startup tests** (additions to `headless/main.test.ts`):
- With `DAEMON_V2=1`: engine is PouchDbSyncEngine (not CustomFetchSyncStrategy)
- Converter runs before engine.start()
- PouchDB db path resolves to expected AppSupport path
- Heartbeat still written after engine.start()

**Manual perf benchmark** (`headless/bench.ts` — not a vitest test):
- Initial pull from empty PouchDB: target < 30s for 14k docs
- Sustained write throughput: target >= 100 docs/sec CouchDB -> FS

### 4.4 Post-C08 Test Baseline

Target: ~150-180 tests (from current 319).
- CustomFetch tests deleted: ~140-150 tests
- New tests added (C01-C06): ~30 tests
- Net: intentional reduction — smaller surface, full coverage of shipped behavior

---

## 5. Risk Assessment and Mitigations

### Risk 1: Concurrent upgrade (iPhone first, Mac later)

**Scenario**: User upgrades iOS plugin to v2.0 (PouchDB), Mac daemon stays at v1.14.0 (CustomFetch) for several days.

**Analysis**: Both strategies replicate via CouchDB using identical doc schema (`file/<path>`, `mtime`, `content`, `_rev`). Shared utilities `doc-builder.ts` and `doc-id.ts` guarantee identical doc encoding. CouchDB is the source of truth — both strategies read/write the same schema with no strategy-specific fields.

**Verdict**: Safe. PouchDB and CustomFetch can coexist against the same CouchDB DB.

**Mitigation**: Doc-level schema compatibility test in C06 verifying a PouchDB-written doc is readable by a CustomFetch-style reader.

### Risk 2: Converter failure -> data loss

**Scenario**: converter crashes mid-run; state.json partially consumed.

**Analysis**: state.json is renamed to `.migrated` ONLY after `bulkDocs` completes. If `bulkDocs` throws, rename is skipped. On restart: `db.info().doc_count === 0` -> converter re-runs. If `db.info().doc_count > 0` (partial bulkDocs succeeded) -> idempotency check skips converter -> PouchDB syncs missing docs from CouchDB on next live-sync cycle. No file content is at risk; only the bandwidth trade-off (some docs re-pulled).

**Rollback**: Copy `state.json.migrated` back to `state.json`, downgrade daemon to v1.14.0.

### Risk 3: leveldown native binding on ARM64 macOS

**Spike validation**: `pouchdb-node` + `leveldown` ran without issues on Apple Silicon. `npm install` compiled native bindings successfully on ARM64 macOS 14.

**Remaining risk**: User machines without Xcode CLT fail `npm install`.

**Mitigation**:
- Use `leveldown` prebuilt binaries (included via `prebuild-install` in `leveldown`'s own install script — already handles ARM64/AMD64)
- esbuild config marks `leveldown` and `fsevents` external; bundle succeeds without compilation
- `postbuild-kickstart.mjs` copies `node_modules/leveldown/` and `node_modules/fsevents/` alongside `dist/headless.js`
- README documents: daemon requires `npm install` (or prebuilt `.node` files) in project root

### Risk 4: Perf regression daemon

**Spike numbers**: 1570 docs/sec (CouchDB -> LevelDB -> disk). 14k docs: ~9s initial pull. Steady-state after restart: ~0 overhead (seq-based).

**Threshold**: > 30% regression vs undefined baseline is ill-defined. Actual criterion from Section 7 AC8: initial pull < 30s.

**Mitigation**: Manual benchmark post-C06 on real vault. If > 30s -> increase PouchDB `batch_size` replication option (default 100; try 500).

### Risk 5: Echo-loop sentinel race condition

**Scenario**: FS event fires before bridge stores appliedRev.

**Why this cannot happen**: `appliedRevs.set(docId, rev)` is stored synchronously BEFORE `vault.write()` (async). FSEvents latency is 50-200ms. The event loop does not yield between the `.set()` call and the vault write initiation. Sentinel is always in memory when the FS event arrives. See Section 2.4 for full analysis.

**Residual risk**: None identified. The in-memory rev comparison is deterministic and race-free in Node's single-threaded model.

### Risk 6: `replaceLocalFromServer()` command broken after C07

**Current**: `(this.strategy as CustomFetchSyncStrategy).replaceLocalFromServer()` — hard-cast to CustomFetch.

**v2.0**: `PouchDbSyncEngine.replaceLocalFromServer()` must be added in C05. Implementation: `db.destroy()` -> re-create DB -> `runInitialPull()`. Matches intent (destructive re-download from server). The cast in `main.ts` is removed in C07 since `strategy` is now typed directly as `PouchDbSyncEngine`.

---

## 6. Bundle Structure v2.0

### Plugin Bundle (unchanged)

```
dist/plugin/
  main.js          (ESM, ~42KB gzipped, no pouchdb-browser inline)
  chunk-*.js       (pouchdb-browser lazy chunk, ~130KB, loaded on first sync)
  manifest.json
  styles.css
```

esbuild plugin config: no changes (code splitting already in place).

### Daemon Bundle

```
dist/
  headless.js      (CJS, platform=node, ~1.4MB — up from ~80KB in v1.14)
  node_modules/
    leveldown/
      prebuilds/
        darwin-arm64/leveldown.node
        darwin-x64/leveldown.node   (if built)
    fsevents/
      build/Release/fse.node
```

esbuild config change (C06, headless context only):

```javascript
const headlessContext = await esbuild.context({
  entryPoints: ["headless/main.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: "dist/headless.js",
  external: ["leveldown", "fsevents"],   // NEW: native add-ons must live alongside bundle
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  logLevel: "info",
  banner: { js: "#!/usr/bin/env node" },
  plugins: [/* existing chmod plugin */],
});
```

`postbuild-kickstart.mjs` addendum: copy `node_modules/leveldown/` and `node_modules/fsevents/` to `dist/` after build. The existing LaunchAgent `kickstart` calls remain unchanged.

---

## 7. Done Criteria (Empirically Verifiable)

Aligned with issue #69 acceptance criteria:

```
AC1  0 occurrences of "CustomFetchSyncStrategy" in src/ + headless/ source files
     grep -r "CustomFetchSyncStrategy" src/ headless/ -> 0 results

AC2  0 occurrences of "couch-client" in imports
     grep -r "from.*couch-client" src/ headless/ -> 0 results

AC3  FetchTransport.ts deleted
     [ ! -f headless/FetchTransport.ts ]

AC4  Platform.isMobile not used for strategy selection in main.ts
     grep "Platform.isMobile" src/main.ts -> 0 results (or only non-strategy usage)

AC5  PouchDB daemon DB persists on disk
     ls ~/Library/Application\ Support/vault-sync-daemon/<dbName>/pouch/
     Expect: CURRENT, LOCK, MANIFEST-*, *.ldb files present after first sync

AC6  Mac daemon upgraded from v1.14.0 without re-pull
     Daemon startup log shows: "[vault-sync] Converter: migrated N docs from state.json"
     AND: NO "[vault-sync] Initial sync starting..." on upgrade startup
     AND: file count on disk unchanged before/after upgrade

AC7  Test suite green
     npx vitest run -> 0 failures

AC8  Bench — initial pull from empty PouchDB < 30s
     Delete LevelDB dir, start daemon, time to "State: ok"
     Expect: < 30s for 14k-doc vault (spike estimate: ~9s)

AC9  Bench — sustained writes >= 100 docs/sec CouchDB -> FS
     bench.ts against real vault
     Expect: >= 100 docs/sec (spike measured: 1570 docs/sec)

AC10 Diagnostics modal — no NaN, no zero-stub fields on Mac after v2.0
     Open Settings -> Vault Sync diagnostics on Mac, after sync completes
     Expect: all fields non-zero / non-null when in "ok" state
```

---

## 8. User Gates (Validation Required During Implementation)

### Gate 1: Before C08 (CustomFetch deletion)

**Trigger**: After C06 deployed to real daemon with `DAEMON_V2=1`, before committing C07.

**What user validates**:
1. Run converter on real ~14k doc Mac vault (daemon startup log shows migration count)
2. No re-pull on startup (no "Initial sync starting..." in log)
3. File count unchanged on disk before/after daemon restart
4. Create file on iPhone -> appears on Mac within 30s
5. Create file on Mac -> appears on iPhone within 30s

**Rollback**: Copy `state.json.migrated` -> `state.json`, downgrade to v1.14.0 daemon.

### Gate 2: Before tagging v2.0

**What user validates**:
1. 3-way sync: iPhone plugin + Mac plugin + Mac daemon, all in PouchDB mode
2. Simultaneous edit of same file on iPhone + Mac -> LWW winner correct (higher mtime wins)
3. `replaceLocalFromServer()` command works on Mac plugin
4. Diagnostics modal on both platforms: coherent data, no stubs, no NaN
5. Downgrade path documented: downgrading daemon after v2.0 requires fresh PouchDB pull (state.json gone); document in release notes

---

## 9. Decisions Tranchées by Architect

### D1: Echo-loop sentinel — in-memory rev map, not PouchDB doc mutation

**User spec**: `_writtenBy: "daemon"` field written to the PouchDB doc before FS write.

**Why overridden**: Writing to the PouchDB doc creates a new `_rev`, which fires its own `db.changes()` event -> second loop iteration. The field also replicates to CouchDB and to all other devices, adding one write-amplification round-trip per remote-applied change. These are correctness and performance problems, not trade-offs.

**Chosen**: In-memory `Map<docId, appliedRev>` with 5s TTL. Same suppression semantics, no PouchDB side-effects, no replication pollution. Race-condition safe in Node's single-threaded model. See Section 2.4.

**User intent preserved**: Echo suppression without timing dependency -> achieved via exact rev comparison instead of TTL-only comparison.

### D2: Replication checkpoint seeding — deferred to v2.1

**Considered**: Seed PouchDB's `_local/<repId>` checkpoint with CouchDB's current `update_seq` so first post-migration sync starts from current seq (0 changes to walk).

**Why deferred**: Checkpoint doc ID requires matching PouchDB's internal SHA-1 of source+target+filter — non-trivial to compute outside PouchDB internals. The `since=0` walk costs 2-5s for 14k docs, happens once, never again. Acceptable for v2.0.

**Filed as**: v2.1 optimization item.

### D3: Tombstoned and orphan revMap entries not migrated to PouchDB

Converter inserts only `state:"known"` entries. Tombstoned entries would require inserting with `_deleted:true` via `new_edits:false` — possible but risks confusing PouchDB's internal conflict tree when remote has an even newer state for that doc. Orphan entries were already problematic in v1.14 — let PouchDB sync resolve them cleanly. Zero risk of data loss: both cases result in PouchDB syncing the correct current state from CouchDB.

### D4: `fs.watch` (not chokidar) for daemon FS watcher

User specified "pas chokidar — match l'existant". `FsWatcher` wraps `fs.watch(root, {recursive:true})` with existing 100ms debounce. No new dependency. The spike used chokidar as a workaround for the sandboxed agent environment; production always had `fs.watch`.

### D5: No `syncStrategy` setting in v2.0

The `syncStrategy: 'auto' | 'custom' | 'pouchdb'` setting is removed with C07. The rollback mechanism after v2.0 is not a settings toggle but a version downgrade (v2.0.x -> v1.14.x is possible until state.json.migrated is cleaned up after 30 days). This simplifies the codebase and removes the implicit promise that CustomFetch can be re-enabled.

---

## 10. Implementation Agent Briefing

**Recommended agents**:
- C01-C04: developer (Haiku, clear mechanical extraction)
- C05: developer (rename + method addition, simple)
- C06: developer + integration-specialist (new PouchDB node wiring, esbuild changes)
- C07-C08: developer (deletion is mechanical, but C08 is high-surface — verify compile after each file deletion)
- C09-C10: developer (docs + version bump)

**Critical implementation notes**:

1. `new_edits:false` in converter `bulkDocs` is non-negotiable. Without it, PouchDB generates new `_rev` values for all inserted docs, destroying the deduplication advantage of migration.

2. `PouchDbFsBridge.start(watcher, vaultAdapter)` signature replaces `register(plugin)`. The Obsidian `Plugin` reference must not appear in `PouchDbFsBridge` — it prevents reuse in daemon context. Existing `plugin.registerEvent()` calls for vault events are moved to `ObsidianVaultWatcher`, which the plugin constructs and passes in.

3. LevelDB path follows same pattern as existing `resolveStatePath()`: `~/Library/Application Support/vault-sync-daemon/<dbName>/pouch/` on macOS. The `/pouch/` suffix disambiguates from `state.json` (which lives alongside at `/<dbName>/state.json`).

4. pouchdb-node TypeScript types: `pouchdb-node` exposes the same `PouchDB.Database<{}>` shape as `pouchdb-browser`. The existing `src/pouchdb-browser.d.ts` shim covers both. A new `headless/pouchdb-node.d.ts` with `declare module "pouchdb-node" { ... }` following the same pattern may be needed for the daemon build.

5. The `DAEMON_V2=1` env flag in C06 is a temporary bridge. It is removed in C08 when CustomFetch is deleted (the flag's only purpose was to select between the two startup paths). Leaving it in would mislead future readers.
