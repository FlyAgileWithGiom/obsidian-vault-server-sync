# Refactor Plan: SyncStrategy Port + PouchDB iOS Implementation

**Issue:** #64 — Implement SyncStrategy port + PouchDB iOS implementation  
**Version base:** 1.12.1 (`origin/main`, commit `b67412f`)  
**Spike basis:** pouchdb-spike worktree, commit `1880e6f`  
**Author:** solution-architect agent  
**Date:** 2026-05-28

---

## 1. SyncStrategy Port — Interface Mapping

### Rationale for each method

The interface surface is derived from every `syncEngine.*` call in `src/main.ts` (origin/main):

```typescript
// src/sync-strategy.ts  (new file, pure types — no imports from obsidian)

import type { VaultSyncSettings, SyncState, SyncCounts, SyncDiagnostics, FullSyncPlan, VaultEntry } from "./types";

/**
 * SyncStrategy — top-level lifecycle port, one instance per plugin run.
 *
 * Sits above the transport and vault layers. CustomFetchSyncStrategy wraps the
 * existing SyncEngine; PouchDbSyncStrategy wraps pouchdb-browser + bridge layer.
 * Both expose this interface so main.ts is strategy-agnostic.
 */
export interface SyncStrategy {
  // --- Callbacks (set by main.ts before start()) ---
  onStateChange: (state: SyncState) => void;
  onCountsChange: (counts: SyncCounts) => void;
  onError: (msg: string) => void;
  onDiagnosticsChange: () => void;

  // --- Lifecycle ---

  /** Start sync (initial full sync then polling/live replication). */
  start(): Promise<void>;

  /** Stop sync and clean up all timers and handles. */
  stop(): void;

  /** Resume from last known checkpoint without clearing state. */
  resumeFullSync(): Promise<void>;

  /** Force full sync from scratch (clears revMap/seq/IndexedDB cursor). */
  forceFullSync(): Promise<void>;

  /** Returns true when sync loop is active. */
  isRunning(): boolean;

  // --- Settings ---

  /** Hot-reload settings without restarting. */
  updateSettings(settings: VaultSyncSettings): void;

  // --- Local change ingestion (called from Obsidian vault event handlers) ---

  /**
   * Called when a vault file is created or modified.
   * CustomFetch: enqueues a debounced push.
   * PouchDB: no-op — the bridge layer subscribes Obsidian events itself and
   *          feeds changes into the local PouchDB instance directly.
   */
  handleLocalChange(file: VaultEntry): void;

  /**
   * Called when a vault file is deleted.
   * CustomFetch: propagates tombstone to CouchDB.
   * PouchDB: no-op — bridge self-subscribes.
   */
  handleLocalDelete(file: VaultEntry): Promise<void>;

  /**
   * Called when a vault file is renamed.
   * CustomFetch: deletes old doc, pushes new doc.
   * PouchDB: no-op — bridge self-subscribes.
   */
  handleLocalRename(file: VaultEntry, oldPath: string): Promise<void>;

  // --- Diagnostics & UI ---

  /** Snapshot of current sync state for settings tab. */
  getDiagnostics(): SyncDiagnostics;

  /**
   * Dry-run: returns what a forceFullSync would do without executing it.
   * CustomFetch: calls SyncEngine.planFullSync().
   * PouchDB: returns a simplified plan (PouchDB replication is managed internally;
   *          doc counts are approximated from local PouchDB allDocs).
   */
  planFullSync(opts?: { bypassOrphanGuard?: boolean }): Promise<FullSyncPlan>;

  /**
   * Test connectivity to CouchDB and return success/failure.
   * Used by settings tab "Test connection" button.
   */
  testConnection(): Promise<boolean>;
}
```

#### Method justification table

```
Method                  | Caller in main.ts                              | Notes
------------------------|------------------------------------------------|----------------------------------
start()                 | startSync() -> syncEngine.start()              | Core lifecycle
stop()                  | stopSync() -> syncEngine.stop()                | Core lifecycle
resumeFullSync()        | resumeFullSync() -> syncEngine.resumeFullSync()| Resume command
forceFullSync()         | forceFullSync() -> syncEngine.forceFullSync()  | Force command
isRunning()             | toggleSync(), startSync() guards               | Guard predicate
updateSettings()        | saveSettings() -> syncEngine.updateSettings()  | Hot reload
handleLocalChange()     | vault.on("modify"), vault.on("create")         | Event handler
handleLocalDelete()     | vault.on("delete")                             | Event handler
handleLocalRename()     | vault.on("rename")                             | Event handler
getDiagnostics()        | getDiagnostics() -> syncEngine.getDiagnostics()| Settings tab
planFullSync()          | previewFullSync() -> syncEngine.planFullSync() | Dry-run preview
testConnection()        | testConnection() (settings tab)                | Connectivity test
onStateChange           | callback set after construction                | UI update
onCountsChange          | callback set after construction                | UI update
onError                 | callback set after construction                | Error display
onDiagnosticsChange     | callback set after construction                | Diagnostics refresh
```

**Note on `handleLocal*` no-op contract for PouchDB.** These are intentional no-ops on
`PouchDbSyncStrategy` — the bridge layer (`PouchDbFsBridge`) registers its own Obsidian
vault event handlers via `plugin.registerEvent(...)` in its constructor. Main.ts still calls
`handleLocal*` unconditionally; both strategies must accept the call. This is the (a) shape
from the design decision in §12: port exposes the methods, PouchDB ignores them internally,
main.ts registration code is unchanged.

---

## 2. Atomic Commit Sequence

Eight commits. Each compiles; Mac and headless daemon behavior is unchanged throughout.

### Commit 1: `refactor: rename SyncEngine -> CustomFetchSyncStrategy`

**Scope:** `src/sync-engine.ts`, `src/main.ts`, `headless/main.ts`, `src/sync-engine.test.ts`

- Rename class `SyncEngine` to `CustomFetchSyncStrategy`.
- Keep filename `sync-engine.ts` (rename deferred to avoid git history churn at this step).
- Update named import in `main.ts`: `import { CustomFetchSyncStrategy } from "./sync-engine"`.
- Update named import in `headless/main.ts`.
- Update `sync-engine.test.ts` import.
- `export function lwwWinner` stays, update the class export.
- Headless `createWatcher` uses `Pick<SyncEngine, ...>` — update to `Pick<CustomFetchSyncStrategy, ...>`.
- `runStartWithExitOnFailure` uses duck-typed `engine.start()` — no change needed.
- **Risk:** Low. Pure rename, zero logic change. Build + existing tests must pass.

### Commit 2: `refactor: extract SyncStrategy interface; CustomFetchSyncStrategy implements it`

**Scope:** new `src/sync-strategy.ts`, `src/sync-engine.ts`

- Add `SyncStrategy` interface as specified in §1 to `src/sync-strategy.ts`.
- Add `implements SyncStrategy` to `CustomFetchSyncStrategy`.
- Verify TypeScript compiles — `handleLocalDelete` is `async` on the class, so the interface
  must declare `handleLocalDelete(file: VaultEntry): Promise<void>`.
- Export `SyncStrategy` from `src/sync-strategy.ts`.
- No runtime change. Tests unchanged.
- **Risk:** Low. Compile-time only.

### Commit 3: `refactor: strategy factory in main.ts; always returns CustomFetchSyncStrategy`

**Scope:** `src/main.ts`

- Replace `private syncEngine!: SyncEngine` with `private strategy!: SyncStrategy`.
- Add private async factory method `createStrategy(): Promise<SyncStrategy>` that always
  returns `CustomFetchSyncStrategy` (PouchDB branch is not yet wired).
- Wire callbacks via `this.strategy.onStateChange = ...` etc.
- Replace all `this.syncEngine.*` call sites with `this.strategy.*`.
- `testConnection()` still instantiates `CouchClient` directly — leave as-is for now.
- **Risk:** Low. No behavior change. Mac path is unchanged. Existing tests pass.

### Commit 4: `chore: add pouchdb-browser dep; resolve uuid audit vulnerability`

**Scope:** `package.json`, `package-lock.json`, new `src/pouchdb-browser.d.ts`

- `npm install pouchdb-browser --save`.
- Resolve `uuid@8` transitive vulnerability: pouchdb-browser@9 ships uuid@9+.
  Run `npm audit` after install to verify clean. If residual, add `overrides` block.
- Add minimal local ambient declaration `src/pouchdb-browser.d.ts` covering only the subset
  used: `new PouchDB(name)`, `db.sync(remote, opts)`, `db.replicate.from(remote, opts)`,
  `db.info()`, `db.allDocs(opts)`, sync handle `.cancel()`.
- Do NOT install `@types/pouchdb-browser` — the official types lag v9 and will conflict.
- No wiring; pouchdb is installed but unused in this commit.
- **Risk:** Medium (npm audit). Confirm no breaking transitive dep change.

### Commit 5: `feat: FS<->PouchDB bridge layer`

**Scope:** new `src/PouchDbFsBridge.ts`, new `src/doc-builder.ts`, new `src/doc-id.ts`,
new `src/PouchDbFsBridge.test.ts`

- Extract `pathToDocId` and `docIdToPath` from `sync-engine.ts` to `src/doc-id.ts`.
  (Update `sync-engine.ts` import.) This allows the bridge to share the same path encoding.
- Create `src/doc-builder.ts` with `buildTextDoc(file: VaultFile, content: string)` helper.
  Update `sync-engine.ts` to use it.
- Implement `PouchDbFsBridge` as described in §6.
- Unit tests in `src/PouchDbFsBridge.test.ts` (jsdom environment).
- No strategy wiring yet; bridge is tested standalone.
- **Risk:** Medium. New code, no runtime integration. Requires vitest jsdom env.

### Commit 6: `feat: PouchDbSyncStrategy + visibility-resume handler`

**Scope:** new `src/PouchDbSyncStrategy.ts`, new `src/PouchDbSyncStrategy.test.ts`

- Implement `PouchDbSyncStrategy implements SyncStrategy` using pouchdb-browser as
  described in §3 and §5.
- Bridge wired in constructor; visibility-change handler registered via `plugin.registerDomEvent`.
- Unit tests with mocked PouchDB and mocked bridge.
- Not yet wired into main.ts — strategy factory still returns CustomFetch only.
- **Risk:** Medium. New code, isolated. Unit tests only.

### Commit 7: `feat: iOS migration detection + initial-pull UX`

**Scope:** `src/PouchDbSyncStrategy.ts` (migration logic), possibly `src/types.ts`
(extend `SyncDiagnostics` with `initialPullRunning: boolean` if needed for UI)

- Implement `isFirstRun()`, initial pull flow, progress events, and `cleanupLegacyRevMap()`.
- Migration detection and flow as specified in §4.
- Add migration-specific test cases to `src/PouchDbSyncStrategy.test.ts`.
- **Risk:** Medium. Additive. Guarded by `isFirstRun()` predicate.

### Commit 8: `feat: wire Platform.isMobile strategy selection + settings rollback toggle`

**Scope:** `src/main.ts`, `src/types.ts` (add `syncStrategy?` field), `src/settings-tab.ts`

- Update `createStrategy()` to branch on `Platform.isMobile` and `settings.syncStrategy`.
- Add `syncStrategy?: 'auto' | 'custom' | 'pouchdb'` to `VaultSyncSettings`.
- Add dropdown in settings tab "Advanced" section.
- This is the first commit that changes runtime behavior for iOS users.
- **Risk:** Medium. Requires device testing before merge to main.

---

## 3. Strategy Selection at Runtime

### Detection

```typescript
// src/main.ts — createStrategy() in commit 8
private async createStrategy(): Promise<SyncStrategy> {
  const strategyOverride = this.settings.syncStrategy ?? 'auto';
  const usePouch =
    strategyOverride === 'pouchdb' ||
    (strategyOverride === 'auto' && Platform.isMobile);

  if (usePouch) {
    // Dynamic import: pouchdb-browser stays out of the Mac bundle
    // when esbuild splitting:true is configured (see §9).
    const { PouchDbSyncStrategy } = await import("./PouchDbSyncStrategy");
    return new PouchDbSyncStrategy(this.settings, this.app);
  }

  const vaultAdapter = new ObsidianVaultAdapter(this.app.vault);
  const stateStore = new ObsidianStateStore();
  const transport = new ObsidianTransport();
  return new CustomFetchSyncStrategy(this.settings, vaultAdapter, stateStore, transport);
}
```

`Platform.isMobile` is from the `obsidian` package, available in both Electron and Capacitor.

### Settings schema addition

```typescript
// src/types.ts — VaultSyncSettings extension
/**
 * Strategy override for testing and rollback.
 * 'auto': iOS -> PouchDB, desktop -> CustomFetch (default)
 * 'custom': force CustomFetch on all platforms (rollback path)
 * 'pouchdb': force PouchDB on all platforms (testing on desktop)
 */
syncStrategy?: 'auto' | 'custom' | 'pouchdb';
```

Default is `'auto'`. No change needed to existing `.vault-sync.json` files.

### Settings UI

Add a dropdown in the settings tab under an "Advanced" collapsible section:
- Label: "Sync strategy"
- Options: Auto (recommended) | Custom fetch (legacy/rollback) | PouchDB
- Helper text: "Change only if instructed. 'Auto' uses PouchDB on iOS, custom engine on desktop."

### Injection in `onload()`

`createStrategy()` is async; `onload()` is already `async`. The assignment becomes:

```typescript
this.strategy = await this.createStrategy();
this.strategy.onStateChange = (state) => this.updateState(state);
// ... other callbacks
```

Vault event registrations remain unchanged in main.ts — they call `this.strategy.handleLocal*`
on every event regardless of strategy. CustomFetch processes them; PouchDB ignores them.

---

## 4. iOS Data Migration

### Detection predicate

On first run of `PouchDbSyncStrategy.start()`:

```typescript
private async isFirstRun(): Promise<boolean> {
  const info = await this.db.info();
  return info.doc_count === 0;
}
```

`doc_count === 0` means IndexedDB is empty — fresh install OR first run after switching to
PouchDB strategy. Both cases need an initial full pull from CouchDB.

### Migration flow

```
PouchDbSyncStrategy.start()
  |
  +-- isFirstRun() = true
  |     |
  |     +-- setState("syncing")
  |     +-- new Notice("Vault Sync: Initial sync starting...")
  |     +-- replicate = db.replicate.from(remote, { live:false, retry:false })
  |     |     +-- on 'change'   -> onCountsChange({ pendingPull: info.pending })
  |     |     +-- on 'complete' -> cleanupLegacyRevMap()
  |     |                          setState("ok")
  |     |                          new Notice("Vault Sync: Initial sync complete")
  |     |                          startLiveSync()
  |     +-- on 'error' -> setState("error"), setError(msg)
  |
  +-- isFirstRun() = false
        +-- startLiveSync()  (PouchDB resumes from its own checkpoint)
```

### Progress updates

The `replicate.from` emitter's `'change'` event exposes `info.docs_written` and `info.pending`.
Use these to populate `SyncDiagnostics.pullProgress`:

```typescript
replication.on('change', (info) => {
  this.onCountsChange({ pendingPush: 0, pendingPull: info.pending ?? 0 });
  this.pullFetched = info.docs_written;
  this.onDiagnosticsChange();
});
```

Total doc count: fetch from `GET /<remote>` before starting replicate.from — the CouchDB
root response includes `doc_count`. Use this to pre-populate `pullTotal`.

### Legacy revMap cleanup

```typescript
private cleanupLegacyRevMap(): void {
  try {
    localStorage.removeItem("vault-sync-revmap");
    localStorage.removeItem("vault-sync-last-seq");
  } catch { /* non-critical */ }
}
```

Called ONLY after `'complete'` event — never on partial completion or error.

### Edge case: crash during initial pull

`isFirstRun()` returns `false` on restart if any docs were written to IndexedDB (PouchDB
writes transactionally per batch). On restart, `start()` skips migration and calls
`startLiveSync()` which catches up from PouchDB's persisted checkpoint. No data loss.

### Edge case: large vault (>10k notes)

Estimated: ~100 docs/sec on mobile = ~100s for 10k notes. Use non-blocking `Notice` with
live progress count. Vault remains usable. Add a "Cancel initial sync" command that calls
`replication.cancel()` and falls back to `syncStrategy = 'custom'` for the current session.

### Edge case: local edits during initial pull

Local edits during pull go through bridge -> local PouchDB. The pull's `live: false` does
not observe local changes; they will push to remote after `startLiveSync()`. No lock required.
Conflict semantics are standard PouchDB revision tree — consistent with existing LWW behavior.

---

## 5. Visibility-Resume Handler

### API choice

Obsidian's Plugin API has no first-class foreground/background lifecycle hook (as of v1.4+).
Use `document.visibilitychange` registered via `plugin.registerDomEvent(...)` — Obsidian's
managed DOM event wrapper, auto-cleaned on plugin unload.

```typescript
// In PouchDbSyncStrategy constructor
this.plugin.registerDomEvent(document, "visibilitychange", () => {
  if (document.visibilityState === "visible" && this.running) {
    this.resumeLiveSync();
  }
});
```

### Double-start protection

```typescript
private resumeInProgress = false;

private resumeLiveSync(): void {
  if (this.resumeInProgress) return;
  if (this.initialPullRunning) return;  // do not interrupt migration
  this.resumeInProgress = true;
  try {
    this.liveSyncHandle?.cancel();
    this.liveSyncHandle = null;
    this.startLiveSync();
  } finally {
    this.resumeInProgress = false;
  }
}
```

`startLiveSync()` creates a new `db.sync(remote, { live: true, retry: true })` handle and
assigns it to `this.liveSyncHandle`.

### Cleanup on stop()

```typescript
stop(): void {
  this.running = false;
  this.liveSyncHandle?.cancel();
  this.liveSyncHandle = null;
  this.bridge.unregister();
  this.setState("idle");
}
```

---

## 6. Bridge Layer Architecture

### Module: `src/PouchDbFsBridge.ts`

Instantiated by `PouchDbSyncStrategy`. Receives `VaultAdapter`, a PouchDB instance, and
`Plugin` ref (for `registerEvent`). No knowledge of the strategy itself.

```
PouchDbSyncStrategy
  |-- PouchDB instance  (IndexedDB, pouchdb-browser)
  |-- PouchDbFsBridge
  |     |-- Obsidian vault event handlers -> write to local PouchDB
  |     +-- PouchDB 'change' listener     -> write to vault FS
  +-- remote CouchDB sync handle  (db.sync({live:true, retry:true}))
```

### Echo-loop protection: double mtime cache

**Level 1 — recentRemotePaths with TTL**

When bridge writes a file from PouchDB to FS:
```typescript
this.recentRemotePaths.set(file.path, Math.floor(Date.now()));
setTimeout(() => this.recentRemotePaths.delete(file.path), 3000);
```

When vault event fires for a file:
```typescript
const cached = this.recentRemotePaths.get(file.path);
if (cached !== undefined && Math.abs(file.mtime - cached) < 50) {
  return; // suppress echo
}
```

The 50ms tolerance handles rounding jitter between `Date.now()` and `stat.mtime`.

**Level 2 — content equality guard**

Before applying a remote change to FS, check if content is identical:
```typescript
const existing = this.vaultAdapter.getEntryByPath(path);
if (existing?.kind === "file") {
  const localContent = await this.vaultAdapter.readText(existing);
  if (localContent === remoteContent) return; // idempotent write, skip
}
```

### mtime ownership and integer truncation

```typescript
// Always use the shared helper — never inline mtime assignment
import { buildTextDoc } from "./doc-builder";

const doc = buildTextDoc(file, content);
// doc.mtime is Math.floor(file.mtime) — integer, matches CustomFetchSyncStrategy
```

`src/doc-builder.ts`:
```typescript
import { pathToDocId } from "./doc-id";
import type { VaultFile } from "./types";

export function buildTextDoc(file: VaultFile, content: string) {
  return {
    _id: pathToDocId(file.path),
    content,
    mtime: Math.floor(file.mtime),
    deleted: false,
  };
}
```

This is the cross-strategy format invariant: identical mtime truncation ensures LWW
determinism when both strategies edit the same doc.

### Path encoding

Reuse `pathToDocId` and `docIdToPath` from `src/doc-id.ts` (extracted from `sync-engine.ts`
in commit 5). Same `file/<NFC-normalized-path>` convention. No additional slash escaping
needed for CouchDB doc IDs (CouchDB permits slashes when URL-encoded; PouchDB handles this).

### Parent directory creation

Before writing a file to the vault FS, check and create the parent directory if needed:

```typescript
const parentPath = path.substring(0, path.lastIndexOf('/'));
if (parentPath && !this.vaultAdapter.getEntryByPath(parentPath)) {
  await this.vaultAdapter.createDirectory(parentPath);
}
```

Obsidian's `vault.create()` does NOT create parent directories automatically.

### Unregister on strategy stop

```typescript
private eventRefs: EventRef[] = [];

register(): void {
  this.eventRefs.push(
    this.plugin.registerEvent(
      this.plugin.app.vault.on("modify", (file) => this.onVaultModify(file))
    ),
    this.plugin.registerEvent(
      this.plugin.app.vault.on("create", (file) => this.onVaultModify(file))
    ),
    this.plugin.registerEvent(
      this.plugin.app.vault.on("delete", (file) => this.onVaultDelete(file))
    ),
    this.plugin.registerEvent(
      this.plugin.app.vault.on("rename", (file, old) => this.onVaultRename(file, old))
    )
  );
}

unregister(): void {
  for (const ref of this.eventRefs) {
    this.plugin.app.vault.offref(ref);
  }
  this.eventRefs = [];
}
```

---

## 7. Cross-Strategy Coexistence

### Five invariants

**Invariant 1 — Doc ID namespace identical.**
Both strategies produce `file/<NFC-normalized-path>`. No collision possible.
`CustomFetchSyncStrategy.pathToDocId` applies `.normalize("NFC")`. `PouchDbFsBridge` uses
the extracted `pathToDocId` from `src/doc-id.ts` — same function, same output.

**Invariant 2 — mtime is integer-truncated on both sides.**
`Math.floor(mtime)` applied via `buildTextDoc` before any write to CouchDB/PouchDB.
Verified in the shared helper (§6). LWW resolution is deterministic across strategies.

**Invariant 3 — `_rev` is owned by CouchDB, never invented.**
`CustomFetchSyncStrategy` reads `_rev` from CouchDB before writing (revMap + GET).
PouchDB reads `_rev` from its local replica. Neither invents revisions.
Cross-engine concurrent writes produce a CouchDB revision conflict; the winning revision
is LWW by mtime via vault-server's `de3f248` deserializer.

**Invariant 4 — Deletion semantics identical.**
`CustomFetchSyncStrategy` uses CouchDB-standard `_deleted: true`. PouchDB uses the same.
No incompatibility.

**Invariant 5 — revMap state is CustomFetch-only.**
`ObsidianStateStore` (localStorage keys `vault-sync-revmap`, `vault-sync-last-seq`) is
read/written exclusively by `CustomFetchSyncStrategy`. `PouchDbSyncStrategy` never touches
these keys. After successful initial pull, legacy keys are deleted (§4), removing any
ambiguity if a user later switches back to CustomFetch (which would start with empty revMap
and run a fresh fullSync — safe).

### Spike-3 confirmation

Vault-server's `VaultDocument` struct has no `#[serde(deny_unknown_fields)]`. PouchDB
internal fields (`_revisions`, `_conflicts`) are silently ignored. The `mtime` deserializer
(`deserialize_flexible_i64`) accepts integer or float. Zero server-side changes required.

### Float mtime risk (migration concern #3)

Mitigated by `Math.floor(mtime)` in `buildTextDoc`. The bridge applies truncation before
writing to PouchDB local; PouchDB replicates the truncated integer to CouchDB. Mac side
also truncates in `ObsidianVaultAdapter.getFiles()`. No float mtime reaches CouchDB.

---

## 8. Testing Plan

### Existing tests — no changes required after commit 1

`src/sync-engine.test.ts`, `src/couch-client.test.ts`, `src/ObsidianTransport.test.ts`,
`headless/main.test.ts`. Commit 1 updates the import symbol name only. All tests continue
to exercise `CustomFetchSyncStrategy` without modification.

Vitest config covers `src/**/*.test.ts` and `headless/**/*.test.ts` — no path changes needed.

### New test files

**`src/strategy-factory.test.ts`** — strategy selection

Mock `Platform` via vitest module mock:
```typescript
vi.mock("obsidian", () => ({ Platform: { isMobile: false }, ... }));
```

Cases:
- `isMobile=false`, `syncStrategy='auto'` -> `CustomFetchSyncStrategy` instance
- `isMobile=true`, `syncStrategy='auto'` -> `PouchDbSyncStrategy` instance
- `isMobile=true`, `syncStrategy='custom'` -> `CustomFetchSyncStrategy` instance
- `isMobile=false`, `syncStrategy='pouchdb'` -> `PouchDbSyncStrategy` instance

**`src/PouchDbFsBridge.test.ts`** — bridge unit logic

Mock PouchDB with vi.fn() stubs. Use existing `TestVaultAdapter` pattern.

Cases:
- FS modify -> bridge writes PouchDB doc with `Math.floor(mtime)`.
- PouchDB change received -> bridge writes correct content to vault FS.
- Echo suppression: bridge writes FS, vault event fires within 3s, bridge ignores echo.
- `folder/note.md` -> doc ID `file/folder/note.md`.
- Parent directory missing -> `createDirectory` called before write.
- `unregister()` -> vault events no longer trigger PouchDB writes.

**`src/PouchDbSyncStrategy.test.ts`** — strategy + visibility

Mock PouchDB sync handle with `cancel` spy.

Cases:
- `visibilitychange=visible` when running -> `liveSyncHandle.cancel()` + new sync created.
- `visibilitychange=visible` when not running -> no action.
- Two rapid `visibilitychange` events -> `cancel` called exactly once.
- `stop()` -> `cancel` called, state = "idle".

Migration detection cases:
- `db.info().doc_count === 0` -> `isFirstRun()` = true.
- `db.info().doc_count > 0` -> `isFirstRun()` = false.
- Successful pull completes -> `cleanupLegacyRevMap()` removes localStorage keys.
- Failed pull -> `cleanupLegacyRevMap()` NOT called.

### Vitest environment

Bridge and strategy tests require browser globals (`indexedDB`, `localStorage`,
`document.addEventListener`). Configure per-file jsdom environment:

```typescript
// vitest.config.ts addition
environmentMatchGlobs: [
  ["src/PouchDb*.test.ts", "jsdom"],
  ["src/strategy-factory.test.ts", "jsdom"],
]
```

Add `jsdom` to devDependencies if not already present: `npm install --save-dev jsdom`.

---

## 9. Bundle Size Strategy

### Current state
- Mac/iOS plugin: `src/main.ts` -> `main.js` (~3 KB today)
- Headless daemon: `headless/main.ts` -> `dist/headless.js`
- PouchDB browser bundle: ~130 KB minified (spike-1 confirmed)

### Mechanism: esbuild dynamic import + splitting

Dynamic `await import("./PouchDbSyncStrategy")` in `createStrategy()` is the code split
boundary. With esbuild `splitting: true`, pouchdb-browser is placed in a separate chunk
that is only downloaded and executed when the import is reached (i.e., on iOS only).

**esbuild.config.mjs changes:**

```javascript
const pluginContext = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  splitting: true,         // enable code splitting
  format: "esm",           // splitting requires ESM (not CJS)
  outdir: "dist/plugin",   // splitting requires outdir, not outfile
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  target: "es2020",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  logLevel: "info",
  // ...deploy plugin adapted to copy from dist/plugin/main.js
});
```

The deploy plugin copies `dist/plugin/main.js` and the split chunk to the vault plugin dir.
Obsidian 1.4+ supports ESM. `manifest.json` already has `minAppVersion: "1.4.0"`.

**Mac bundle result:** main.js contains no pouchdb-browser code (dynamic import not reached
on desktop; tree-shaking eliminates the dead branch after splitting).

**Headless daemon:** No change. `headless/main.ts` never imports `PouchDbSyncStrategy`,
so pouchdb-browser never enters `dist/headless.js`.

**Expected output sizes:**
- `dist/plugin/main.js` (Mac): ~3 KB (unchanged)
- `dist/plugin/main.js` (iOS, loads split chunk): ~133 KB total
- `dist/headless.js`: unchanged

### Alternative (simpler but larger Mac bundle)

Keep `format: "cjs"` and `outfile: "main.js"`. esbuild does not split CJS dynamic imports.
Mac bundle grows to ~133 KB. Acceptable if bundle size is not a constraint.
See §12 decision #3 for user validation.

---

## 10. Risks and Mitigations

### Migration concern #1: Initial pull duration for large vaults

**Risk:** 10k+ notes, ~100–300s pull time on mobile.

**Mitigation:** Non-blocking `Notice` with live progress (docs pulled / estimated total).
Vault usable during pull. "Cancel initial sync" command falls back to `syncStrategy='custom'`
for current session without persisting. Addressed in §4.

### Migration concern #2: Concurrent writes during initial pull

**Risk:** User edits while pull runs — conflict semantics unclear.

**Mitigation:** No lock needed. Local edits bridge -> local PouchDB; push to remote after
live sync starts. Remote edits after pull's snapshot seq caught by live sync. Standard PouchDB
LWW semantics. Addressed in §4.

### Migration concern #3: Cross-strategy float mtime

**Risk:** iOS emits float mtime, Mac truncates to int, LWW non-deterministic.

**Mitigation:** `Math.floor(mtime)` in `buildTextDoc` applied before any write. Shared helper
enforces this. Addressed in §6 and §7.

### Migration concern #4: Rollback path

**Risk:** PouchDB strategy has a defect post-ship.

**Mitigation:** `syncStrategy: 'custom'` settings override forces CustomFetch on iOS without
requiring a plugin update. Addressed in §3.

### Migration concern #5: @types/pouchdb-browser divergence

**Risk:** TypeScript compilation errors with v6 stubs vs v9 runtime.

**Mitigation:** Do not use `@types/pouchdb-browser`. Author minimal local ambient
declaration `src/pouchdb-browser.d.ts` for the specific v9 API surface used.
Addressed in commit 4.

### Migration concern #6: uuid@8 audit vulnerability

**Risk:** npm audit fails; blocks merge.

**Mitigation:** pouchdb-browser@9 ships uuid@9+. Run `npm audit` post-install to confirm.
If residual, add `overrides.uuid` in package.json. Addressed in commit 4.

### Spike friction signals — status

```
Friction item                    | Status in this plan
---------------------------------|-----------------------------------------------
Echo loops                       | Resolved — §6 double mtime cache + TTL
mtime ownership                  | Resolved — §6 buildTextDoc + Math.floor
Path slash encoding              | Resolved — shared pathToDocId (NFC, file/ prefix)
Parent directory creation        | Resolved — §6 createDirectory before write
PouchDB types divergence         | Resolved — commit 4, local ambient declaration
iOS lifecycle auto-resume        | Resolved — §5 visibilitychange handler
Binary file handling             | Deferred — iOS v1 is text-only; tracked as follow-up
```

---

## 11. Criteria for Done

```
Acceptance Criteria (#64)                                   | Empirical Validation
------------------------------------------------------------|----------------------------------------------
SyncStrategy port added above SyncEngine                    | tsc --noEmit clean; CustomFetch implements it
CustomFetchSyncStrategy: no behavior change on Mac          | All existing tests pass; Mac smoke test
PouchDbSyncStrategy: live:true + visibility-resume         | Device: 35min background -> foreground -> doc arrives
Strategy selected by Platform.isMobile (or override)        | Unit test: mock Platform, verify factory output
FS<->PouchDB bridge with echo-loop protection               | Unit test: echo suppression case passes
Visibility-change handler cancels + reinits                 | Unit test: cancel spy called on visible event
iOS migration: empty IndexedDB -> pull + revMap cleanup     | Device: fresh iPhone install -> initial pull completes,
                                                            |   localStorage vault-sync-revmap key absent after
No vault-server changes                                     | vault-server diff: empty
No headless daemon changes                                  | headless/main.ts diff: rename import only
All existing tests pass on Mac path                         | vitest run: 0 failures
New tests cover factory, visibility, bridge, migration      | vitest run: new files included, 0 failures
Bundle size documented                                      | Build log: main.js size before/after in PR description
```

### Manual device test checklist (iPhone)

1. Install plugin via BRAT on fresh iPhone vault.
2. Configure CouchDB URL / credentials.
3. Observe "Initial sync starting" notice.
4. Wait for "Initial sync complete" notice.
5. Verify vault files match Mac vault.
6. Background Obsidian for 35 minutes.
7. Create a note on Mac during the background window.
8. Foreground Obsidian on iPhone.
9. Note appears within 5 seconds.
10. Edit a note on iPhone; verify it appears on Mac within 5 seconds.
11. Confirm `localStorage.getItem("vault-sync-revmap")` returns `null` in Obsidian iOS
    WebInspector (Safari -> Develop -> iPhone -> Obsidian).
12. Set `syncStrategy: 'custom'` in `.vault-sync.json`, restart plugin, verify sync still works.

---

## 12. Decisions to Validate Before Implementation

**Decision 1 — `handleLocal*` no-op shape (port asymmetry)**

This plan chose shape (a): `PouchDbSyncStrategy.handleLocal*` are no-ops; the bridge
self-subscribes via `plugin.registerEvent`. Main.ts vault event registrations are unchanged.

Shape (b) alternative: the strategy owns all event subscriptions; main.ts stops registering
vault events (moves registration into `strategy.start()`). This is architecturally cleaner
but changes more of main.ts. 

**Validate: shape (a) — no-op + unchanged main.ts, or shape (b) — strategy owns subscriptions?**

**Decision 2 — Bundle split mechanism: ESM splitting vs CJS single bundle**

This plan chose ESM + esbuild `splitting: true`. Mac bundle stays ~3 KB; iOS loads pouchdb
on demand. Requires changing `format` from `cjs` to `esm` and `outfile` to `outdir`, which
changes the build output structure and the deploy copy logic.

Alternative: keep CJS, both Mac and iOS get ~133 KB. Simpler build, no structural change.

**Validate: is Mac bundle size parity (~133 KB) acceptable, or is the ESM split required?**

**Decision 3 — iOS v1 binary file handling: deferred**

iOS v1 is text-only sync. Binary files (images, PDFs) will not sync from Mac to iPhone until
a follow-up implements `_attachments` handling in the bridge. This matches the spike scope but
may surprise users who rely on binary files.

**Validate: acceptable as text-only v1, or must binary file sync be included before shipping?**

**Decision 4 — Initial pull UX: non-blocking Notice**

Non-blocking `Notice` with live progress count. Vault usable during pull. No modal gate.

Alternative: modal dialog blocking vault access until pull completes, preventing any local
edits during the migration window.

**Validate: non-blocking or blocking migration UX?**

**Decision 5 — Strategy override visibility: advanced / hidden vs prominent**

`syncStrategy` setting is under an "Advanced" collapsible section, not surfaced by default.

Alternative: top-level setting, prominently visible for early adopters.

**Validate: hidden advanced setting or prominent early-adopter toggle?**
