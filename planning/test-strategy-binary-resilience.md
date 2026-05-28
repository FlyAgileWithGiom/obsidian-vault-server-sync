# Test Strategy: Binary-Resilience Scenario Suite

## Context

Five fixes shipped in 1.13.7:
- **P1** — `putAttachment` receives explicit `BINARY_PUSH_TIMEOUT_MS` (never hangs)
- **P2** — Parallel push ×3 (`PARALLEL_BINARY_PUSH = 3`)
- **P3** — Unsyncable tracking: ≥3 consecutive network failures → skip until `forceFullSync`
- **P4** — Exponential backoff on 409s: `min(2^attempt × 100ms, 2000ms)`
- **P5** — `pushLocks` serializes `pushAllLocal` against concurrent `handleLocalChange`

---

## 1. Scenario Catalog

### S1 — Happy-path large vault (baseline)

**Vault**: 5 800 text `.md` + 200 binary `.png`. Text: 512-byte deterministic strings. Binary: shared 4 KB `ArrayBuffer`.

**Transport**: All `bulkDocs`, `putAttachment`, `allDocs`, `changes` succeed first attempt.

**Assertions**: `getDiagnostics().lastSeq !== "0"`, `unsyncableCount === 0`, `revMapSize === 6000`, state sequence ends `"ok"`. Assert `facade.maxInFlight >= 2` during the binary push phase (P2: reverted serial push would yield `maxInFlight === 1`).

**Budget**: < 15 s.

---

### S2 — Transient binary failures recover (P1 + P3)

**Vault**: 5 800 text + 200 binary. 10 seeded binary paths fail twice then succeed.

**Transport**: `putAttachment` for those 10 paths rejects `Error("network timeout")` on calls 1-2, resolves on call 3. All `timeoutMs` arguments must be non-undefined (P1 contract check).

**Assertions**: `unsyncableCount === 0`, `revMapSize >= 5990`, `lastSeq !== "0"`. Assert that every `putAttachment` call received a `timeoutMs > 0`.

**Budget**: < 15 s.

---

### S3 — Persistently-failing binaries become unsyncable (P3 regression detector)

**Vault**: 100 text + 50 binary. All 50 binaries: `putAttachment` always rejects `Error("EIO")`.

**Transport**: Text ops succeed. All `putAttachment` calls reject unconditionally.

**Assertions**: `unsyncableCount === 50`, `revMapSize >= 100`, `lastSeq !== "0"`, `onError` called exactly once (not 50 times), state ends `"ok"`.

**Regression if P3 reverted**: retries never stop → vitest per-test timeout fires.

**Budget**: < 10 s.

---

### S4 — 409 backoff timing is bounded (P4 regression detector)

**Vault**: 1 binary file.

**Transport**: `putAttachment` rejects `CouchError(409)` for attempts 0–3, succeeds on attempt 4. `client.get` resolves immediately. Facade records `Date.now()` at each `putAttachment` call entry.

**Assertions**: `putAttachment` called exactly 5 times. Delay deltas between consecutive calls: `[~100, ~200, ~400, ~800]` ms (±10 ms), verifying `min(2^attempt × 100, 2000)` shape. Final `revMapSize === 1`, `unsyncableCount === 0`.

**Implementation**: `vi.useFakeTimers()` in this test's `beforeEach`. Advance virtual time with `vi.advanceTimersByTimeAsync(10_000)` concurrently while awaiting `forceFullSync()`. `Date.now()` inside the facade returns virtual time.

**Regression if P4 reverted**: delay deltas are uniform or unbounded; assertions fail.

**Budget**: < 5 s.

---

### S5 — PushLock prevents 409 storm (P5 regression detector)

**Vault**: 1 binary file (`bin/a.png`).

**Interleaving**: Start `engine.forceFullSync()` without awaiting, flush one microtask (`await Promise.resolve()`), then call `engine.handleLocalChange(binaryFile)`. Await both.

**Assertions**: `onError` never called, `revMapSize === 1`, `putAttachment` call count ≤ 2 (lock prevents duplicate in-flight push).

**Regression if P5 reverted**: two concurrent `putAttachment` calls with same stale rev → facade returns `CouchError(409)` on the second → `onError` fires.

**Budget**: < 5 s.

---

## 2. Mock Infrastructure Design

Reuse the `vi.mock("./couch-client")` module-mock pattern from `sync-engine.test.ts`. Build a stateful facade:

**`src/__mocks__/couch-facade.ts`** — exports `makeCouchFacade(opts)`:

```ts
interface FacadeOpts {
  textCount: number;
  binaryCount: number;
  failures?: Record<string, "always-fail" | { failCount: number }>;
}
```

Memory strategy: facade never materializes 6 000 doc objects. `allDocs` computes rows from index ranges; `allDocsByKeys` generates docs on demand via `seedDoc(id)`. Content is `"text-${n}"` — O(1) heap per query. A `callCounts: Map<string, number>` per `putAttachment` drives failure-plan lookups. `changes(0, { limit: 0 })` returns `{ last_seq: "6000", results: [] }` (the sentinel call inside `pullAllRemote`).

The facade also tracks concurrency: `let inFlight = 0; let maxInFlight = 0;` updated at `putAttachment` entry and exit (`finally { inFlight-- }`). `facade.maxInFlight` is exposed for S1's P2 assertion.

**`src/__mocks__/vault-generator.ts`** — exports `makeVaultFiles(textCount, binaryCount): VaultFile[]` with deterministic `path`, `mtime`, `size`.

---

## 3. Regression Matrix

```
Fix reverted  | Scenario  | Discriminator                         | How it fails
P1 (timeout)  | S2        | assert timeoutMs > 0 per call         | assertion fails immediately
P2 (parallel) | S1        | facade.maxInFlight >= 2               | serial push yields maxInFlight=1; fails
P3 (unsync.)  | S3        | putAttachment calls <= 150 total      | retries forever; test timeout
P4 (backoff)  | S4        | delay delta array [100,200,400,800]   | delta assertions fail
P5 (locks)    | S5        | onError call count === 0              | onError fires with "409 conflict"
```

---

## 4. File Layout

```
src/
  scenarios/
    sync-resilience.test.ts   # S1–S5 scenario tests
  __mocks__/
    couch-facade.ts           # makeCouchFacade()
    vault-generator.ts        # makeVaultFiles()
    obsidian.ts               # existing, unchanged
```

`TestVaultAdapter` and `TestStateStore` from `sync-engine.test.ts` should be extracted to `src/__mocks__/test-adapters.ts` and reused.

---

## 5. Runtime Budget

```
Scenario | Docs  | Fake timers | Est. time
S1       | 6 000 | no          | 10–15 s
S2       | 6 000 | no          | 10–15 s
S3       | 150   | no          | 3–5 s
S4       | 1     | yes         | 2–3 s
S5       | 1     | yes         | 2–3 s
Total    |       |             | ~30–40 s
```

S1/S2 are heaviest: `allDocs` fires 3 pages of 2 000 rows, then ~12 `allDocsByKeys` chunks at `META_BATCH_SIZE=500`. All resolved synchronously in the facade — no real latency. Suite stays well under 2 min.

---

## Developer Notes

1. **Fake timers scope**: `vi.useFakeTimers()` in S4/S5 `beforeEach` only. S1–S3 must NOT use fake timers — `yield()` calls inside `fullSync` require real microtask turns for event-loop liveness.
2. **Constants are module-level `const`**: `BINARY_PUSH_TIMEOUT_MS`, `BINARY_PUSH_MAX_FAILURES` etc. are unoverridable without a production refactor. Use the failure-plan mechanism + fake timers instead of lowering constants.
3. **lastSeq oracle**: Line 1208 of `sync-engine.ts` reads `changes(0, { limit: 0 })` to seed `lastSeq` at the end of `pullAllRemote`. Facade must recognize this sentinel call (distinguished by `limit: 0`) and return `{ last_seq: "6000", results: [] }`.
4. **S4 timing capture**: Record `Date.now()` at `putAttachment` *entry* (before any async work), not exit. With fake timers `Date.now()` returns virtual time; recording at entry isolates the sleep-only interval and excludes the `client.get` roundtrip from the delta.
5. **S5 engine must be running**: `handleLocalChange` returns early when `isRunning() === false` (confirmed by `sync-engine.test.ts` line 1048). Call `await engine.start()` before triggering the race; set `client.allDocs` and `client.changes` to succeed so `start()` completes. If microtask interleaving proves flaky in CI, an acceptable substitute: fire 10 concurrent `handleLocalChange` calls on the same binary after `forceFullSync()`; the lock invariant is identical and the test becomes deterministic.
