# Refactor Plan: SyncStrategy Port + PouchDB iOS Implementation

**Issue:** #64 — Implement SyncStrategy port + PouchDB iOS implementation  
**Version base:** 1.12.1 (`origin/main`, commit `b67412f`)  
**Spike basis:** pouchdb-spike worktree, commit `1880e6f`  
**Author:** solution-architect agent  
**Date:** 2026-05-28  
**Revision:** 2026-05-28 — user decisions integrated (Shape b, binary in scope, ESM split)

---

## 1. SyncStrategy Port — Interface Mapping

### Rationale for Shape (b)

User decision: Shape (b) — the strategy owns its vault subscriptions. `main.ts` removes
all four `vault.on(...)` registrations on the iOS path. The strategy self-registers via
`plugin.registerEvent(vault.on(...))` in its `register()` call. Rationale: "what's tight
for the future" — the interface boundary should own everything it touches.

This applies symmetrically: `CustomFetchSyncStrategy` also moves its vault event
subscriptions inside the class. Both strategies call `this.plugin.registerEvent(...)` in
their `register()` implementation. `main.ts` no longer contains any vault event handler
wiring — it only calls `this.strategy.register(this)` after construction.

### Interface definition

```typescript
// src/sync-strategy.ts  (new file, pure types — no imports from obsidian)

import type { VaultSyncSettings, SyncState, SyncCounts, SyncDiagnostics, FullSyncPlan, VaultEntry } from "./types";
import type { Plugin } from "obsidian";

/**
 * SyncStrategy — top-level lifecycle port, one instance per plugin run.
 *
 * Sits above the transport and vault layers. CustomFetchSyncStrategy wraps the
 * existing SyncEngine; PouchDbSyncStrategy wraps pouchdb-browser + bridge layer.
 * Both expose this interface so main.ts is strategy-agnostic.
 *
 * Shape (b): the strategy owns its own vault event subscriptions.
 * main.ts does NOT register vault events — it calls strategy.register(this) instead.
 */
export interface SyncStrategy {
  // --- Callbacks (set by main.ts before register()) ---
  onStateChange: (state: SyncState) => void;
  onCountsChange: (counts: SyncCounts) => void;
  onError: (msg: string) => void;
  onDiagnosticsChange: () => void;

  // --- Lifecycle ---

  /**
   * Register vault event handlers and any DOM event handlers.
   * Called once after construction, before start().
   * CustomFetch: registers modify/create/delete/rename handlers.
   * PouchDB: delegates to PouchDbFsBridge.register().
   */
  register(plugin: Plugin): void;

  /** Start sync (initial full sync then polling/live replication). */
  start(): Promise<void>;

  /** Stop sync and clean up all timers, handles, and event refs. */
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
register()              | onload() after createStrategy()                | Shape b — strategy owns subscriptions
start()                 | startSync() -> strategy.start()                | Core lifecycle
stop()                  | stopSync() -> strategy.stop()                  | Core lifecycle
resumeFullSync()        | resumeFullSync() -> strategy.resumeFullSync()  | Resume command
forceFullSync()         | forceFullSync() -> strategy.forceFullSync()    | Force command
isRunning()             | toggleSync(), startSync() guards               | Guard predicate
updateSettings()        | saveSettings() -> strategy.updateSettings()    | Hot reload
getDiagnostics()        | getDiagnostics() -> strategy.getDiagnostics()  | Settings tab
planFullSync()          | previewFullSync() -> strategy.planFullSync()   | Dry-run preview
testConnection()        | testConnection() (settings tab)                | Connectivity test
onStateChange           | callback set after construction                | UI update
onCountsChange          | callback set after construction                | UI update
onError                 | callback set after construction                | Error display
onDiagnosticsChange     | callback set after construction                | Diagnostics refresh
```

**Shape (b) main.ts before/after:**

```typescript
// BEFORE (Shape a — main.ts owns subscriptions)
this.registerEvent(this.app.vault.on("modify", (file) => { ... }));
this.registerEvent(this.app.vault.on("create", (file) => { ... }));
this.registerEvent(this.app.vault.on("delete", (file) => { ... }));
this.registerEvent(this.app.vault.on("rename", (file, old) => { ... }));

// AFTER (Shape b — strategy owns subscriptions)
this.strategy = await this.createStrategy();
this.strategy.onStateChange = (state) => this.updateState(state);
// ... other callbacks
this.strategy.register(this);       // <-- strategy wires its own vault events
await this.strategy.start();
// No vault.on() calls remain in main.ts
```

---

## 2. Atomic Commit Sequence

Ten commits. Each compiles. Mac and headless daemon behavior is unchanged throughout,
until Commit 9 (first commit that changes runtime behavior on iOS).

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

### Commit 2: `refactor: extract SyncStrategy interface; add register() to CustomFetchSyncStrategy`

**Scope:** new `src/sync-strategy.ts`, `src/sync-engine.ts`, `src/main.ts`

- Add `SyncStrategy` interface as specified in §1 to `src/sync-strategy.ts`. Interface
  includes `register(plugin: Plugin): void` and excludes `handleLocalChange/Delete/Rename`.
- Add `implements SyncStrategy` to `CustomFetchSyncStrategy`.
- Move all four vault event registrations out of `main.ts` into
  `CustomFetchSyncStrategy.register(plugin)`. The class stores `EventRef[]` and
  `unregister()` them in `stop()`.
- `main.ts` removes all `this.registerEvent(this.app.vault.on(...))` calls. Adds
  `this.strategy.register(this)` after strategy construction.
- Verify TypeScript compiles.
- **Risk:** Medium (was Low). Runtime event-registration timing shifts for Mac/desktop.
  Existing tests must cover that vault events still trigger `handleLocalChange` after
  this refactor. Add assertions that events are properly handled.

### Commit 3: `refactor: strategy factory in main.ts; always returns CustomFetchSyncStrategy`

**Scope:** `src/main.ts`

- Replace `private syncEngine!: SyncEngine` field with `private strategy!: SyncStrategy`.
- Add private async factory method `createStrategy(): Promise<SyncStrategy>` that always
  returns `CustomFetchSyncStrategy` (PouchDB branch is not yet wired).
- Wire callbacks via `this.strategy.onStateChange = ...` etc.
- Replace all `this.syncEngine.*` call sites with `this.strategy.*`.
- `testConnection()` still instantiates `CouchClient` directly — leave as-is.
- **Risk:** Low. No behavior change. Mac path is unchanged. Existing tests pass.

### Commit 4: `chore: add pouchdb-browser dep; resolve uuid audit vulnerability`

**Scope:** `package.json`, `package-lock.json`, new `src/pouchdb-browser.d.ts`

- `npm install pouchdb-browser --save`.
- Resolve `uuid@8` transitive vulnerability: pouchdb-browser@9 ships uuid@9+.
  Run `npm audit` after install to verify clean. If residual, add `overrides` block.
- Add minimal local ambient declaration `src/pouchdb-browser.d.ts` covering only the subset
  used: `new PouchDB(name)`, `db.sync(remote, opts)`, `db.replicate.from(remote, opts)`,
  `db.info()`, `db.allDocs(opts)`, `db.put(doc)`, `db.get(id)`,
  `db.putAttachment(docId, attName, rev, blob, contentType)`,
  `db.getAttachment(docId, attName)`, sync handle `.cancel()`.
- Do NOT install `@types/pouchdb-browser` — the official types lag v9 and will conflict.
- No wiring; pouchdb is installed but unused in this commit.
- **Risk:** Medium (npm audit). Confirm no breaking transitive dep change.

### Commit 5: `refactor: extract binary helpers to src/binary-ext.ts`

**Scope:** new `src/binary-ext.ts`, `src/sync-engine.ts` (re-import)

- Move `BINARY_EXTENSIONS` static set, `isBinaryDoc()`, `CONTENT_TYPE_MAP`, and
  `ATTACHMENT_NAME` from `sync-engine.ts` to `src/binary-ext.ts`.
- Export: `BINARY_EXTENSIONS`, `isBinaryPath(path: string): boolean`,
  `CONTENT_TYPE_MAP`, `ATTACHMENT_NAME`.
- `sync-engine.ts` imports from `./binary-ext` — zero behavior change.
- `isBinaryPath` is extension-based: `BINARY_EXTENSIONS.has(path.split(".").pop() ?? "")`.
- **Risk:** Low. Pure extraction, zero logic change. Build + existing tests must pass.

  The bridge and strategy will both import from `src/binary-ext.ts` in subsequent commits.
  Without this extraction, the bridge would duplicate the constants — silent drift risk.

### Commit 6: `refactor: extract doc-id helpers; add buildTextDoc / buildBinaryDocMeta`

**Scope:** new `src/doc-id.ts`, new `src/doc-builder.ts`, `src/sync-engine.ts` (re-import)

- Extract `pathToDocId` and `docIdToPath` from `sync-engine.ts` to `src/doc-id.ts`.
  Update `sync-engine.ts` import. Allows bridge to share path encoding.
- Create `src/doc-builder.ts` with:
  - `buildTextDoc(file: VaultFile, content: string)` — returns doc with `Math.floor(mtime)`
  - `buildBinaryDocMeta(file: VaultFile)` — returns doc stub without `_attachments`
    (attachment stored separately via `putAttachment`)
- Update `sync-engine.ts` to use `buildTextDoc` (pure mechanical replacement).
- **Risk:** Low. Pure extraction. Build + tests must pass.

### Commit 7: `feat: FS<->PouchDB text bridge + echo-loop protection`

**Scope:** new `src/PouchDbFsBridge.ts`, new `src/PouchDbFsBridge.test.ts`

- Implement text path of `PouchDbFsBridge` as specified in §6:
  - Vault modify/create/delete/rename -> local PouchDB text doc write.
  - PouchDB `change` event for non-binary docs -> vault FS write.
  - Echo-loop protection (double mtime cache + content equality guard).
  - Parent directory creation before writes.
  - `register(plugin)` / `unregister()`.
- `isBinaryPath` imported from `./binary-ext` to detect files to skip in text path
  (binary paths handled in next commit).
- Unit tests in `src/PouchDbFsBridge.test.ts` (jsdom environment).
- No strategy wiring yet; bridge tested standalone.
- **Risk:** Medium. New code, no runtime integration. Requires vitest jsdom env.

### Commit 8: `feat: binary sync via PouchDB _attachments (text bridge extension)`

**Scope:** `src/PouchDbFsBridge.ts`, `src/PouchDbFsBridge.test.ts`

- Extend `PouchDbFsBridge` with binary path:
  - Binary vault file write -> `db.putAttachment(docId, "data.bin", rev, blob, contentType)`.
  - PouchDB `change` event for binary docs -> `db.getAttachment(docId, "data.bin")` ->
    `vault.writeBinary(path, buffer)`.
  - LWW for binary: doc stub carries `mtime: Math.floor(file.mtime)`, same as text.
    Conflict resolution is CouchDB-standard revision tree + mtime-based LWW.
  - Content type resolved via `CONTENT_TYPE_MAP` from `./binary-ext`.
  - Extension detection via `isBinaryPath` from `./binary-ext`.
  - Batch attachment pull on initial iOS pull: stream attachments one-at-a-time (do not
    load all blobs into memory simultaneously; use sequential iteration over allDocs).
- Binary extensions in scope: png, jpg, jpeg, gif, webp, svg, pdf, mp4, mov, mp3, wav,
  m4a, ogg, zip, dmg (plus existing: bmp, svgz, ico, doc/docx, xls/xlsx, ppt/pptx,
  flac, avi, mkv, webm, tar, gz, rar, 7z, bin, heic, drawing, writing).
- Additional unit tests: binary round-trip, image arrives after foreground,
  content-type mapping, batch pull (no memory spike).
- **Risk:** Medium-High. Attachment API is newer surface; binary test coverage is critical.

### Commit 9: `feat: PouchDbSyncStrategy + visibility-resume handler`

**Scope:** new `src/PouchDbSyncStrategy.ts`, new `src/PouchDbSyncStrategy.test.ts`

- Implement `PouchDbSyncStrategy implements SyncStrategy` using pouchdb-browser as
  described in §3 and §5.
- `register(plugin)` delegates to `bridge.register(plugin)` and registers
  `visibilitychange` DOM event.
- Bridge wired in constructor. Binary + text paths both active (commits 7+8 complete).
- Unit tests with mocked PouchDB and mocked bridge.
- Not yet wired into main.ts — strategy factory still returns CustomFetch only.
- **Risk:** Medium. New code, isolated. Unit tests only.

### Commit 10: `feat: iOS migration + wire strategy selection + settings toggle`

**Scope:** `src/PouchDbSyncStrategy.ts` (migration logic), `src/main.ts`,
`src/types.ts`, `src/settings-tab.ts`

- Implement `isFirstRun()`, initial pull flow, progress events, `cleanupLegacyRevMap()`.
- Update `createStrategy()` to branch on `Platform.isMobile` and `settings.syncStrategy`.
- Add `syncStrategy?: 'auto' | 'custom' | 'pouchdb'` to `VaultSyncSettings`.
- Add hidden "Advanced" dropdown in settings tab.
- This is the first commit that changes runtime behavior for iOS users.
- **Risk:** Medium-High. Requires device testing before merge to main.

---

## 3. Strategy Selection at Runtime

### Detection

```typescript
// src/main.ts — createStrategy() in commit 10
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

### Main.ts wiring (Shape b)

```typescript
// src/main.ts — onload(), after createStrategy()
this.strategy = await this.createStrategy();
this.strategy.onStateChange = (state) => this.updateState(state);
this.strategy.onCountsChange = (counts) => this.updateCounts(counts);
this.strategy.onError = (msg) => this.setError(msg);
this.strategy.onDiagnosticsChange = () => this.updateDiagnostics();
this.strategy.register(this);   // strategy wires its own vault events
await this.strategy.start();
```

No `vault.on(...)` calls remain in `main.ts` after Commit 2.

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

Add a dropdown in the settings tab under a hidden "Advanced" collapsible section:
- Label: "Sync strategy"
- Options: Auto (recommended) | Custom fetch (legacy/rollback) | PouchDB
- Helper text: "Change only if instructed. 'Auto' uses PouchDB on iOS, custom engine on desktop."

The section is collapsed by default and not surfaced in normal use.

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

### Binary files during initial pull

Binary attachments are replicated by `replicate.from` in the same pass as text docs.
PouchDB replication fetches attachments inline when `include_docs: true` (default).

To avoid loading all blobs into memory simultaneously:
- Iterate `allDocs` sequentially after replication, not concurrently.
- Each `getAttachment` call is awaited before fetching the next.
- Vault writes for binaries use `vault.writeBinary(path, buffer)`.
- Memory footprint is bounded to one attachment at a time.

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
// In PouchDbSyncStrategy.register(plugin)
plugin.registerDomEvent(document, "visibilitychange", () => {
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
  |     |-- Obsidian vault event handlers -> local PouchDB (text + binary)
  |     +-- PouchDB 'change' listener     -> vault FS (text + binary)
  +-- remote CouchDB sync handle  (db.sync({live:true, retry:true}))
```

### Text path

Vault modify/create (non-binary) -> `buildTextDoc(file, content)` -> `db.put(doc)`.
PouchDB `change` for non-binary docs -> `vaultAdapter.writeText(path, content)`.

### Binary path

Vault modify/create (binary) -> `buildBinaryDocMeta(file)` -> `db.put(docMeta)`,
then `db.putAttachment(docId, "data.bin", rev, blob, contentType)`.

PouchDB `change` for binary docs -> `db.getAttachment(docId, "data.bin")` ->
`vaultAdapter.writeBinary(path, buffer)`.

Binary detection: `isBinaryPath(file.path)` from `./binary-ext`.
Content type: `CONTENT_TYPE_MAP` from `./binary-ext`.
Attachment name: `ATTACHMENT_NAME` ("data.bin") from `./binary-ext`.

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

For binary files, skip the content equality guard (blob comparison is expensive;
rely on Level 1 TTL cache instead).

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

export function buildBinaryDocMeta(file: VaultFile) {
  return {
    _id: pathToDocId(file.path),
    mtime: Math.floor(file.mtime),
    deleted: false,
    // 'content' absent on binary docs — bridge checks for _attachments on read
  };
}
```

This is the cross-strategy format invariant: identical mtime truncation ensures LWW
determinism when both strategies edit the same doc.

### Path encoding

Reuse `pathToDocId` and `docIdToPath` from `src/doc-id.ts` (extracted from `sync-engine.ts`
in commit 6). Same `file/<NFC-normalized-path>` convention. No additional slash escaping
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

### Register / unregister on strategy stop

```typescript
private eventRefs: EventRef[] = [];

register(plugin: Plugin): void {
  this.plugin = plugin;
  this.eventRefs.push(
    plugin.registerEvent(
      plugin.app.vault.on("modify", (file) => this.onVaultModify(file))
    ),
    plugin.registerEvent(
      plugin.app.vault.on("create", (file) => this.onVaultModify(file))
    ),
    plugin.registerEvent(
      plugin.app.vault.on("delete", (file) => this.onVaultDelete(file))
    ),
    plugin.registerEvent(
      plugin.app.vault.on("rename", (file, old) => this.onVaultRename(file, old))
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

### Six invariants

**Invariant 1 — Doc ID namespace identical.**
Both strategies produce `file/<NFC-normalized-path>`. No collision possible.
`CustomFetchSyncStrategy.pathToDocId` applies `.normalize("NFC")`. `PouchDbFsBridge` uses
the extracted `pathToDocId` from `src/doc-id.ts` — same function, same output.

**Invariant 2 — mtime is integer-truncated on both sides.**
`Math.floor(mtime)` applied via `buildTextDoc` / `buildBinaryDocMeta` before any write
to CouchDB/PouchDB. Verified in the shared helper (§6). LWW resolution is deterministic
across strategies.

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
ambiguity if a user later switches back to CustomFetch (fresh fullSync — safe).

**Invariant 6 — Binary attachment `_rev` ownership.**
`putAttachment` requires the current `_rev` of the doc stub. The bridge must read `_rev`
from `db.get(docId)` before calling `putAttachment`. If the doc does not yet exist,
`db.put(docMeta)` creates it and the response `rev` is used immediately. This prevents
409 Conflict errors on concurrent writes to the same binary file.

### Spike-3 confirmation

Vault-server's `VaultDocument` struct has no `#[serde(deny_unknown_fields)]`. PouchDB
internal fields (`_revisions`, `_conflicts`) are silently ignored. The `mtime` deserializer
(`deserialize_flexible_i64`) accepts integer or float. Zero server-side changes required.

### Float mtime risk (migration concern #3)

Mitigated by `Math.floor(mtime)` in `buildTextDoc`/`buildBinaryDocMeta`. The bridge applies
truncation before writing to PouchDB local; PouchDB replicates the truncated integer to
CouchDB. Mac side also truncates in `ObsidianVaultAdapter.getFiles()`. No float mtime
reaches CouchDB.

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

**`src/PouchDbFsBridge.test.ts`** — bridge unit logic (text path, commit 7)

Mock PouchDB with vi.fn() stubs. Use existing `TestVaultAdapter` pattern.

Text cases:
- FS modify -> bridge writes PouchDB doc with `Math.floor(mtime)`.
- PouchDB change received -> bridge writes correct content to vault FS.
- Echo suppression: bridge writes FS, vault event fires within 3s, bridge ignores echo.
- `folder/note.md` -> doc ID `file/folder/note.md`.
- Parent directory missing -> `createDirectory` called before write.
- `unregister()` -> vault events no longer trigger PouchDB writes.

Binary cases (commit 8 extension):
- FS modify of `image.png` -> `db.putAttachment("data.bin", ...)` called.
- PouchDB change for binary doc -> `db.getAttachment("data.bin")` -> `vault.writeBinary`.
- Content type for `.png` -> `"image/png"`.
- Content type for `.pdf` -> `"application/pdf"`.
- Binary echo suppression via TTL cache (content equality guard skipped for binary).
- Batch pull: 50 binary docs iterated sequentially, not concurrently.
- Image-in-note round-trip: `note-with-image.md` (text) + `test.png` (binary) both replicate;
  wikilink `![[test.png]]` resolves after foreground.

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

### Primary mechanism: esbuild dynamic import + ESM splitting

Dynamic `await import("./PouchDbSyncStrategy")` in `createStrategy()` is the code split
boundary. With esbuild `splitting: true`, pouchdb-browser is placed in a separate chunk
that is only downloaded and executed when the import is reached (iOS only).

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
  // deploy plugin: copy from dist/plugin/ (main.js + chunk files) to vault
});
```

**Mac bundle result:** `dist/plugin/main.js` ~3 KB — dynamic import not reached on desktop;
esbuild tree-shaking eliminates the PouchDB branch from the main chunk.

**Headless daemon:** No change. `headless/main.ts` never imports `PouchDbSyncStrategy`,
so pouchdb-browser never enters `dist/headless.js`.

**Expected output sizes:**
- `dist/plugin/main.js` (Mac): ~3 KB (unchanged)
- `dist/plugin/chunk-*.js` (iOS, loaded dynamically): ~130 KB
- `dist/headless.js`: unchanged

### Empirical verification gate (blocking before Commit 10 merge)

**UNVERIFIED ASSUMPTION:** Obsidian iOS WKWebView loads ESM chunks via dynamic `import()`.
Obsidian desktop uses Electron which loads plugins as CJS via `require()`. ESM dynamic
import on iOS WKWebView is functionally different and has NOT been tested on a real device.

Before merging Commit 10 to main, verify on a real iPhone:
1. Build with `splitting: true, format: "esm"`.
2. Install plugin via BRAT.
3. Enable PouchDB strategy override in settings.
4. Confirm plugin loads without "Failed to resolve module specifier" or similar error.
5. Confirm pouchdb-browser chunk loads (check via Safari WebInspector network tab).

**If ESM dynamic import fails on iOS WKWebView:**

Fallback approach: two entry points with esbuild `define` flag.

```javascript
// esbuild.config.mjs — fallback (two lean artifacts, no ESM chunks)
// Mac build:
await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  outfile: "dist/mac/main.js",
  define: { "ENABLE_POUCHDB": "false" },
  external: [...],
});

// iOS build:
await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  outfile: "dist/ios/main.js",
  define: { "ENABLE_POUCHDB": "true" },
  external: [...],
});
```

```typescript
// src/main.ts — guarded import using define constant
declare const ENABLE_POUCHDB: boolean;

private async createStrategy(): Promise<SyncStrategy> {
  if (ENABLE_POUCHDB && Platform.isMobile) {
    const { PouchDbSyncStrategy } = await import("./PouchDbSyncStrategy");
    return new PouchDbSyncStrategy(this.settings, this.app);
  }
  // ...CustomFetch path
}
```

Result: Mac artifact ~3 KB (PouchDB branch dead-code-eliminated by `define`).
iOS artifact ~133 KB (full bundle, no dynamic chunk needed).
No ESM dynamic import required — both artifacts are CJS.

This fallback produces two distinct plugin files for different platforms, requiring a
distribution mechanism (BRAT can serve platform-specific zips). This is the user's
stated fallback — NOT the always-bundle-133KB approach.

---

## 10. Risks and Mitigations

### Migration concern #1: Initial pull duration for large vaults

**Risk:** 10k+ notes with binary attachments, ~100–300s pull time on mobile.

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

**Mitigation:** `Math.floor(mtime)` in `buildTextDoc`/`buildBinaryDocMeta` applied before
any write. Shared helpers enforce this. Addressed in §6 and §7.

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

### Migration concern #7: ESM chunk loading on iOS WKWebView

**Risk:** Dynamic ESM import does not work in Obsidian's iOS WKWebView context.
If Obsidian loads plugins via CJS `require()` bridge on iOS, the split chunk will
fail to load and the strategy will not initialize.

**Mitigation:** Empirical verification gate before Commit 10 merge (see §9). Fallback
is two entry points + esbuild `define` flag — both artifacts remain lean (~3 KB Mac,
~133 KB iOS). Risk is implementation friction (CI must produce two artifacts), not
data loss. Addressed in §9.

### Migration concern #8: Binary attachment _rev conflict

**Risk:** Concurrent writes to the same binary file produce a 409 from PouchDB if
`putAttachment` uses a stale `_rev`.

**Mitigation:** Bridge reads `_rev` from `db.get(docId)` immediately before
`putAttachment`. For new docs, uses the `rev` from `db.put(docMeta)` response.
Addressed in §7 Invariant 6.

### Spike friction signals — status

```
Friction item                    | Status in this plan
---------------------------------|-----------------------------------------------
Echo loops                       | Resolved — §6 double mtime cache + TTL
mtime ownership                  | Resolved — §6 buildTextDoc/buildBinaryDocMeta + Math.floor
Path slash encoding              | Resolved — shared pathToDocId (NFC, file/ prefix)
Parent directory creation        | Resolved — §6 createDirectory before write
PouchDB types divergence         | Resolved — commit 4, local ambient declaration
iOS lifecycle auto-resume        | Resolved — §5 visibilitychange handler
Binary file handling             | IN SCOPE v1 — commits 5+8, critical path (images indissociables)
ESM split on iOS WKWebView       | Pending verification — gate before Commit 10 merge
```

---

## 11. Criteria for Done

```
Acceptance Criteria (#64)                                   | Empirical Validation
------------------------------------------------------------|----------------------------------------------
SyncStrategy port added (Shape b: register(), no handleLocal*)| tsc --noEmit clean; both strategies implement it
CustomFetchSyncStrategy: vault events moved into class      | Commit 2: existing tests pass; Mac smoke test
PouchDbSyncStrategy: live:true + visibility-resume          | Device: 35min background -> foreground -> doc arrives
Strategy selected by Platform.isMobile (or override)        | Unit test: mock Platform, verify factory output
FS<->PouchDB text bridge with echo-loop protection          | Unit test: echo suppression case passes
Binary sync: images + attachments replicate via _attachments| Unit test: binary round-trip; device: image renders
Image-in-note round-trip                                    | note-with-image.md + ![[test.png]] syncs; renders inline
Batch binary pull (no memory spike)                         | Unit test: 50 binary docs fetched sequentially
Visibility-change handler cancels + reinits                 | Unit test: cancel spy called on visible event
iOS migration: empty IndexedDB -> pull + revMap cleanup     | Device: fresh iPhone install -> initial pull completes,
                                                            |   localStorage vault-sync-revmap key absent after
No vault-server changes                                     | vault-server diff: empty
No headless daemon changes                                  | headless/main.ts diff: rename import only
All existing tests pass on Mac path                         | vitest run: 0 failures
New tests: factory, visibility, bridge (text+binary), migration | vitest run: new files included, 0 failures
Bundle size documented                                      | Build log: main.js size before/after in PR description
ESM split verified on real iPhone before merge              | Safari WebInspector confirms chunk loads (see §9 gate)
```

### Manual device test checklist (iPhone)

1. Install plugin via BRAT on fresh iPhone vault.
2. Configure CouchDB URL / credentials.
3. Observe "Initial sync starting..." notice.
4. Wait for "Initial sync complete" notice.
5. Verify vault text files match Mac vault.
6. Verify images referenced via `![[image.png]]` wikilinks are present and render inline.
7. Background Obsidian for 35 minutes.
8. Create a text note on Mac during the background window.
9. Foreground Obsidian on iPhone. Note appears within 5 seconds.
10. Edit a note on iPhone; verify it appears on Mac within 5 seconds.
11. Create an image on Mac during background; foreground iPhone; image renders inline.
12. Edit a PDF/binary file on Mac; foreground iPhone; binary arrives.
13. Confirm `localStorage.getItem("vault-sync-revmap")` returns `null` in Obsidian iOS
    WebInspector (Safari -> Develop -> iPhone -> Obsidian).
14. Set `syncStrategy: 'custom'` in `.vault-sync.json`, restart plugin, verify sync still
    works (rollback path).

---

## 12. Resolved Decisions

These decisions were validated by the user on 2026-05-28. The rationale is preserved
for future readers. Implementation must not revisit them without explicit user approval.

**Decision 1 — `handleLocal*` shape: Shape (b) chosen**

The interface exposes `register(plugin: Plugin): void` and excludes `handleLocalChange`,
`handleLocalDelete`, `handleLocalRename`. Both strategies own their vault event subscriptions
and wire them in `register()`. `main.ts` no longer contains any `vault.on(...)` registrations.

Rationale: "what's tight for the future" — the interface boundary should own everything
it touches. Shape (a) (no-op methods in interface, main.ts unchanged) was rejected as
leaking concerns into main.ts.

**Decision 2 — Bundle split: ESM splitting primary, two-entry-point fallback**

Primary: `format: "esm"`, `splitting: true`, `outdir: "dist/plugin"`. Mac ~3 KB,
iOS loads ~130 KB chunk on demand. Requires empirical verification gate on real iPhone
before Commit 10 merge.

Fallback if ESM dynamic import fails: two entry points + esbuild `define` flag. Mac
artifact ~3 KB (ENABLE_POUCHDB=false), iOS artifact ~133 KB (ENABLE_POUCHDB=true).
Both are CJS, no dynamic chunks needed.

The "always-bundle 133 KB on Mac" approach is NOT a fallback — it was explicitly
rejected by the user.

**Decision 3 — Binary sync IN scope v1 (upgraded from deferred)**

Binary files (images, PDFs, audio, etc.) are first-class vault content. Wikilinks
`![[image.png]]` make the vault functionally broken without image sync. Binary sync
is on the critical path — commits 5 and 8 implement it.

Rationale: "les binaires sont indissociables, contiennent aussi les images" — the vault
cannot ship as text-only.

**Decision 4 — Initial pull UX: non-blocking Notice**

Non-blocking `Notice` with live progress count. Vault remains usable during pull.
No modal gate. "Cancel initial sync" command available as escape hatch.

**Decision 5 — Strategy override: hidden Advanced setting**

`syncStrategy` setting is under a collapsed "Advanced" section, not surfaced by default.
Rationale: this is a rollback/testing knob, not a user-facing feature.
