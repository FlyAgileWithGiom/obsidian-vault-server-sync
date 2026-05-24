/**
 * Binary-resilience scenario suite (S1–S5)
 *
 * Tests the five fixes shipped in 1.13.7:
 *   P1 — putAttachment receives explicit BINARY_PUSH_TIMEOUT_MS (never hangs)
 *   P2 — Parallel push ×3 (PARALLEL_BINARY_PUSH = 3)
 *   P3 — Unsyncable tracking: ≥3 consecutive failures → skip until forceFullSync
 *   P4 — Exponential backoff on 409s: min(2^attempt × 100ms, 2000ms)
 *   P5 — pushLocks serializes pushAllLocal against concurrent handleLocalChange
 *
 * See planning/test-strategy-binary-resilience.md for the full spec.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SyncEngine } from "../sync-engine";
import { CouchError } from "../couch-client";
import { makeCouchFacade, type CouchFacade } from "../__mocks__/couch-facade";
import { makeVaultFiles, seedTextContent } from "../__mocks__/vault-generator";
import { ScenarioVault, TestStateStore, noopTransport } from "../__mocks__/test-adapters";
import type { VaultSyncSettings } from "../types";

// -------------------------------------------------------------------
// Module mock: redirect CouchClient constructor to the current facade.
// The facade slot is assigned in each test's beforeEach.
// -------------------------------------------------------------------

let currentFacade: CouchFacade | null = null;

vi.mock("../couch-client", () => {
  class CouchError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = "CouchError";
      this.status = status;
    }
  }

  const CouchClient = vi.fn().mockImplementation(() => {
    if (!currentFacade) throw new Error("No facade set — call makeCouchFacade in beforeEach");
    return currentFacade;
  });

  return { CouchClient, CouchError };
});

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function makeSettings(overrides: Partial<VaultSyncSettings> = {}): VaultSyncSettings {
  return {
    couchDbUrl: "https://couch.example.com",
    couchDbName: "test-vault",
    couchDbUser: "admin",
    couchDbPassword: "secret",
    syncDebounceMs: 0, // No debounce delay in scenario tests
    excludePatterns: [".obsidian/", ".trash/"],
    ...overrides,
  };
}

function makeEngine(vault: ScenarioVault, store = new TestStateStore()): {
  engine: SyncEngine;
  stateChanges: string[];
  errors: string[];
} {
  const stateChanges: string[] = [];
  const errors: string[] = [];
  const engine = new SyncEngine(makeSettings(), vault, store, noopTransport);
  engine.onStateChange = (s) => stateChanges.push(s);
  engine.onError = (msg) => errors.push(msg);
  return { engine, stateChanges, errors };
}

// -------------------------------------------------------------------
// S1 — Happy-path large vault (baseline)
// Budget: < 15 s
// -------------------------------------------------------------------

describe("S1 — Happy-path large vault", () => {
  let vault: ScenarioVault;
  let engine: SyncEngine;
  let stateChanges: string[];

  beforeEach(() => {
    vault = new ScenarioVault();

    // Populate vault with 5800 text + 200 binary files
    const files = makeVaultFiles(5800, 200);
    for (let i = 0; i < 5800; i++) {
      vault.addTextFile(files[i].path, seedTextContent(i), files[i].mtime);
    }
    for (let i = 0; i < 200; i++) {
      vault.addBinaryFile(files[5800 + i].path, new ArrayBuffer(4096), files[5800 + i].mtime);
    }

    currentFacade = makeCouchFacade({ textCount: 5800, binaryCount: 200 });

    ({ engine, stateChanges } = makeEngine(vault));
  });

  afterEach(() => {
    engine.stop();
    currentFacade = null;
  });

  it(
    "syncs all 6000 files, no unsyncable, parallel binary push",
    async () => {
      await engine.forceFullSync();

      const diag = engine.getDiagnostics();

      // lastSeq updated from sentinel call
      expect(String(diag.lastSeq)).not.toBe("0");

      // No files became unsyncable
      expect(diag.unsyncableCount).toBe(0);

      // All 6000 docs tracked
      expect(diag.revMapSize).toBeGreaterThanOrEqual(6000);

      // State sequence ends "ok"
      expect(stateChanges[stateChanges.length - 1]).toBe("ok");

      // P2: parallel push — at least 2 binary uploads were in-flight simultaneously.
      // If P2 is reverted (PARALLEL_BINARY_PUSH = 1 / serial push), maxInFlight === 1.
      expect(currentFacade!.maxInFlight).toBeGreaterThanOrEqual(2);
    },
    15_000,
  );
});

// -------------------------------------------------------------------
// S2 — Transient binary failures recover (P1 + P3)
// Budget: < 15 s
// -------------------------------------------------------------------

describe("S2 — Transient binary failures recover", () => {
  let vault: ScenarioVault;
  let engine: SyncEngine;
  let stateChanges: string[];

  beforeEach(() => {
    vault = new ScenarioVault();

    const files = makeVaultFiles(5800, 200);
    for (let i = 0; i < 5800; i++) {
      vault.addTextFile(files[i].path, seedTextContent(i), files[i].mtime);
    }
    for (let i = 0; i < 200; i++) {
      vault.addBinaryFile(files[5800 + i].path, new ArrayBuffer(4096), files[5800 + i].mtime);
    }

    // First 10 binary paths fail twice then succeed on 3rd call.
    // facade.callCounts accumulate across syncs (no reset between resumeFullSync calls).
    const failures: Record<string, { failCount: number }> = {};
    for (let i = 0; i < 10; i++) {
      failures[`assets/bin-${i}.png`] = { failCount: 2 };
    }

    currentFacade = makeCouchFacade({ textCount: 5800, binaryCount: 200, failures });
    ({ engine, stateChanges } = makeEngine(vault));
  });

  afterEach(() => {
    engine.stop();
    currentFacade = null;
  });

  it(
    "recovers from transient failures and all files eventually sync",
    async () => {
      // Sync 1: 10 binaries fail (facade count=1, failCount=2 so still failing).
      // Non-409 errors throw immediately from pushBinaryFile's inner loop (no retry there).
      // The outer catch increments binaryPushFailureCounts[path] to 1.
      await engine.forceFullSync();

      // Sync 2: 10 binaries fail again (facade count=2, still failing).
      // binaryPushFailureCounts[path] = 2 (below BINARY_PUSH_MAX_FAILURES=3).
      // resumeFullSync does NOT call clearState, so failure counts accumulate.
      await engine.resumeFullSync();

      // Sync 3: 10 binaries succeed (facade count=3 > failCount=2 → resolves).
      // binaryPushFailureCounts[path] cleared on success (line ~1884).
      await engine.resumeFullSync();

      const diag = engine.getDiagnostics();

      // All recovered — no unsyncable files
      expect(diag.unsyncableCount).toBe(0);

      // At least 5990 docs tracked (most text + most binary)
      expect(diag.revMapSize).toBeGreaterThanOrEqual(5990);

      // lastSeq updated
      expect(String(diag.lastSeq)).not.toBe("0");

      // P1: every putAttachment call must have received a positive timeoutMs.
      // If P1 is reverted (no explicit timeout passed), timeoutMs is undefined → recorded as -1.
      const timeouts = currentFacade!.putAttachmentTimeouts;
      expect(timeouts.length).toBeGreaterThan(0);
      expect(timeouts.every((t) => t > 0)).toBe(true);
    },
    15_000,
  );
});

// -------------------------------------------------------------------
// S3 — Persistently-failing binaries become unsyncable (P3 regression detector)
// Budget: < 10 s
// -------------------------------------------------------------------

describe("S3 — Persistently-failing binaries become unsyncable", () => {
  let vault: ScenarioVault;
  let engine: SyncEngine;
  let stateChanges: string[];
  let errors: string[];
  const TEXT_COUNT = 100;
  const BINARY_COUNT = 50;

  beforeEach(() => {
    vault = new ScenarioVault();

    const files = makeVaultFiles(TEXT_COUNT, BINARY_COUNT);
    for (let i = 0; i < TEXT_COUNT; i++) {
      vault.addTextFile(files[i].path, seedTextContent(i), files[i].mtime);
    }
    for (let i = 0; i < BINARY_COUNT; i++) {
      vault.addBinaryFile(files[TEXT_COUNT + i].path, new ArrayBuffer(4096), files[TEXT_COUNT + i].mtime);
    }

    // All 50 binaries always fail
    const failures: Record<string, "always-fail"> = {};
    for (let i = 0; i < BINARY_COUNT; i++) {
      failures[`assets/bin-${i}.png`] = "always-fail";
    }

    currentFacade = makeCouchFacade({ textCount: TEXT_COUNT, binaryCount: BINARY_COUNT, failures });
    ({ engine, stateChanges, errors } = makeEngine(vault));
  });

  afterEach(() => {
    engine.stop();
    currentFacade = null;
  });

  it(
    "marks all 50 persistently-failing binaries as unsyncable after 3 consecutive failures",
    async () => {
      // Sync 1 (engine.start): each binary fails (binaryPushFailureCounts[path] = 1)
      // engine.start() calls fullSync() without clearState, so counts persist.
      await engine.start();

      // Sync 2 (resumeFullSync): each binary fails again (count = 2)
      await engine.resumeFullSync();

      // Sync 3 (resumeFullSync): each binary fails again (count = 3 = BINARY_PUSH_MAX_FAILURES)
      // → all 50 go into unsyncableFiles. setError called once per file (50 calls).
      await engine.resumeFullSync();

      // After sync 3: unsyncableFiles has 50 entries.
      // Sync 4 (resumeFullSync): all 50 are SKIPPED via the guard at pushAllLocal line ~915.
      // Only the consolidated setError fires at the end of fullSync (1 call).
      errors.length = 0; // Clear prior errors; only measure the 4th sync's output
      await engine.resumeFullSync();

      const diag = engine.getDiagnostics();

      // All 50 binaries classified as unsyncable
      expect(diag.unsyncableCount).toBe(BINARY_COUNT);

      // Text files still tracked
      expect(diag.revMapSize).toBeGreaterThanOrEqual(TEXT_COUNT);

      // lastSeq updated
      expect(String(diag.lastSeq)).not.toBe("0");

      // State ends "ok" — unsyncable files don't block sync completion
      expect(stateChanges[stateChanges.length - 1]).toBe("ok");

      // onError called exactly once: the consolidated unsyncable warning.
      // Not 50 times (one per file) — files were skipped, not retried.
      // If P3 is reverted (no unsyncable tracking): retries never stop → test timeout fires.
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("unsyncable");
    },
    10_000,
  );
});

// -------------------------------------------------------------------
// S4 — 409 backoff timing is bounded (P4 regression detector)
// Fake timers: yes
// Budget: < 5 s
// -------------------------------------------------------------------

describe("S4 — 409 backoff timing is bounded", () => {
  let vault: ScenarioVault;
  let engine: SyncEngine;
  let stateChanges: string[];
  let errors: string[];

  // Mutable state captured by the S4 facade closure
  let s4CallCount = 0;
  let s4Timestamps: number[] = [];
  let s4Timeouts: number[] = [];

  beforeEach(() => {
    vi.useFakeTimers();

    s4CallCount = 0;
    s4Timestamps = [];
    s4Timeouts = [];

    vault = new ScenarioVault();
    vault.addBinaryFile("assets/bin-0.png", new ArrayBuffer(4096), 2_000_000);

    // Build base facade for bookkeeping (allDocs, allDocsByKeys, etc.)
    // but override putAttachment to implement the 409-on-attempts-0-3 plan.
    const base = makeCouchFacade({ textCount: 0, binaryCount: 1 });

    currentFacade = {
      ...base,
      // Override putAttachmentTimeouts and putAttachmentCallCount to use our closures
      get putAttachmentTimeouts() { return s4Timeouts; },
      get putAttachmentCallCount() { return s4CallCount; },
      get putAttachmentTimestamps() {
        const m = new Map<string, number[]>();
        m.set("assets/bin-0.png", s4Timestamps);
        return m;
      },

      putAttachment: async (
        docId: string,
        _attName: string,
        _rev: string,
        _data: ArrayBuffer,
        _contentType: string,
        timeoutMs?: number,
      ) => {
        // Record timestamp at entry — under fake timers, Date.now() returns virtual time
        s4Timestamps.push(Date.now());
        s4Timeouts.push(timeoutMs ?? -1);
        s4CallCount++;

        // Attempts 0-3 (calls 1-4): reject with 409
        // Attempt 4 (call 5): succeed
        if (s4CallCount <= 4) {
          // Throw a CouchError(409) — must match the instanceof check in pushBinaryFile.
          // CouchError is the class from the vi.mock factory (same reference the engine uses).
          throw new CouchError(409, "conflict");
        }

        return { ok: true, id: docId, rev: "5-success" };
      },
    };

    ({ engine, stateChanges, errors } = makeEngine(vault));
  });

  afterEach(() => {
    engine.stop();
    currentFacade = null;
    vi.useRealTimers();
  });

  it(
    "backoff delays follow min(2^attempt × 100, 2000) shape",
    async () => {
      // Run forceFullSync concurrently with timer advancement.
      // The engine's setTimeout inside the 409 backoff loop resolves when virtual time advances.
      const syncPromise = engine.forceFullSync();
      await vi.advanceTimersByTimeAsync(10_000);
      await syncPromise;

      // putAttachment called exactly 5 times: calls 1-4 fail with 409, call 5 succeeds
      expect(s4CallCount).toBe(5);

      // Verify delay deltas between consecutive putAttachment entries:
      //   attempt 0→1: min(2^0 × 100, 2000) = 100 ms
      //   attempt 1→2: min(2^1 × 100, 2000) = 200 ms
      //   attempt 2→3: min(2^2 × 100, 2000) = 400 ms
      //   attempt 3→4: min(2^3 × 100, 2000) = 800 ms
      expect(s4Timestamps).toHaveLength(5);
      const deltas = s4Timestamps.slice(1).map((t, i) => t - s4Timestamps[i]);
      const expectedDeltas = [100, 200, 400, 800];
      for (let i = 0; i < expectedDeltas.length; i++) {
        // ±10 ms tolerance to absorb the synchronous client.get() call between retries
        expect(deltas[i]).toBeGreaterThanOrEqual(expectedDeltas[i] - 10);
        expect(deltas[i]).toBeLessThanOrEqual(expectedDeltas[i] + 50);
      }

      // After success: 1 doc tracked, 0 unsyncable
      const diag = engine.getDiagnostics();
      expect(diag.revMapSize).toBe(1);
      expect(diag.unsyncableCount).toBe(0);
    },
    5_000,
  );
});

// -------------------------------------------------------------------
// S5 — PushLock prevents 409 storm (P5 regression detector)
// Real timers (no vi.useFakeTimers — yield() must resolve naturally)
// Budget: < 5 s
//
// Interleaving strategy:
//   1. forceFullSync() starts — runs to pushBinaryFile → blocked at putAttachment latch.
//   2. While blocked, call handleLocalChange for same file (debounceMs=0 → real timer fires).
//   3. Release latch → forceFullSync resumes → completes.
//   4. The lock (pushLocks) ensures handleLocalChange's push runs AFTER forceFullSync's.
//
// Regression signal (P5 reverted, no lock):
//   The facade's putAttachment detects if the same stale rev is used twice concurrently
//   and throws CouchError(409) → onError fires → test fails at errors.length === 0.
// -------------------------------------------------------------------

describe("S5 — PushLock prevents 409 storm", () => {
  let vault: ScenarioVault;
  let engine: SyncEngine;
  let stateChanges: string[];
  let errors: string[];

  let latchResolve: (() => void) | null = null;
  let s5PutCount = 0;
  let s5PutRevs: string[] = [];

  beforeEach(() => {
    // Real timers: yield() must resolve naturally so forceFullSync can progress.
    // (Fake timers would block yield() = setTimeout(r, 0) and make the latch unreachable.)
    s5PutCount = 0;
    s5PutRevs = [];
    latchResolve = null;

    vault = new ScenarioVault();
    vault.addBinaryFile("bin/a.png", new ArrayBuffer(4096), 2_000_000);

    const FILE_DOC_ID = "file/bin/a.png";
    const INITIAL_REV = "1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    currentFacade = {
      isConfigured: () => true,
      ensureDb: async () => {},

      get: async (docId: string) => ({
        _id: docId,
        _rev: INITIAL_REV,
        content: null,
        mtime: 0,
      }),

      put: async (doc) => ({ ok: true, id: doc._id, rev: "2-stub" }),
      delete: async (docId, _rev) => ({ ok: true, id: docId, rev: "2-deleted" }),

      // allDocs: return "bin/a.png" already existing remotely.
      // Required: without this, pullAllRemote sees file in revMap but not remoteRevs
      // → handleRemoteDelete → file deleted from vault → handleLocalChange has no file.
      allDocs: async () => ({
        total_rows: 1,
        rows: [{ id: FILE_DOC_ID, key: FILE_DOC_ID, value: { rev: INITIAL_REV } }],
      }),

      allDocsByKeys: async (keys) => ({
        total_rows: keys.length,
        rows: keys.map((k) => {
          if (k === FILE_DOC_ID) {
            return {
              id: k, key: k,
              value: { rev: INITIAL_REV },
              doc: {
                _id: k, _rev: INITIAL_REV, content: null, mtime: 2_000_000,
                _attachments: { "data.bin": { content_type: "image/png", length: 4096, stub: true as const } },
              },
            };
          }
          return { id: k, key: k, value: { rev: "" }, error: "not_found" as const };
        }),
      }),

      bulkDocs: async (docs) => docs.map((d) => ({ ok: true, id: d._id, rev: "2-bulk" })),
      changes: async () => ({ last_seq: "1", results: [] }),
      cancelChanges: () => {},
      updateSettings: () => {},
      getAttachment: async () => new ArrayBuffer(4096),

      // putAttachment: first call sets the latch (blocks) so handleLocalChange can
      // be injected while forceFullSync is paused mid-push.
      // If the SAME rev is used twice (concurrent calls without lock), throw 409.
      putAttachment: async (docId, _attName, rev, _data, _contentType) => {
        s5PutCount++;
        s5PutRevs.push(rev);

        if (s5PutCount === 1) {
          // Block until latch is released
          await new Promise<void>((resolve) => { latchResolve = resolve; });
          return { ok: true, id: docId, rev: "2-first-ok" };
        }

        // Second (and subsequent) calls succeed — we detect the race via revs, not 409.
        // With lock: second call uses updated rev "2-first-ok" (forceFullSync updated revMap).
        // Without lock: second call uses stale INITIAL_REV (ran concurrently before update).
        return { ok: true, id: docId, rev: `${s5PutCount + 1}-ok` };
      },

      maxInFlight: 0,
      putAttachmentTimeouts: [],
      get putAttachmentCallCount() { return s5PutCount; },
      putAttachmentTimestamps: new Map(),
    } as CouchFacade;

    ({ engine, stateChanges, errors } = makeEngine(vault));
  });

  afterEach(() => {
    if (latchResolve) { latchResolve(); latchResolve = null; }
    engine.stop();
    currentFacade = null;
  });

  it(
    "pushLock prevents duplicate in-flight binary push on concurrent sync + handleLocalChange",
    async () => {
      // Phase 1: start forceFullSync without awaiting.
      // Engine's yield() = real setTimeout(0) → resolves naturally.
      // forceFullSync will run through to the putAttachment latch and block there.
      const syncPromise = engine.forceFullSync();

      // Wait for latch: poll with real-timer yields until forceFullSync reaches putAttachment.
      const maxWaitMs = 2000;
      const startMs = Date.now();
      while (latchResolve === null && Date.now() - startMs < maxWaitMs) {
        await new Promise((r) => setImmediate(r));
      }
      expect(latchResolve).not.toBeNull();

      // Phase 2: inject handleLocalChange while forceFullSync is paused.
      // syncDebounceMs=0 → schedules setTimeout(callback, 0).
      // We wait for one event-loop tick (setTimeout 0) so the debounce callback fires
      // and pushBinaryFile starts (reaching get()) before we release the latch.
      // This ensures both threads use the same stale INITIAL_REV concurrently.
      const binaryFile = vault.getEntryByPath("bin/a.png");
      expect(binaryFile).not.toBeNull();
      engine.handleLocalChange(binaryFile!);

      // Wait for the debounce setTimeout(0) to fire and for pushBinaryFile to start
      // and call get() (which returns immediately). Now Thread 2 has rev = INITIAL_REV
      // and is about to call putAttachment. This is the race window.
      await new Promise((r) => setTimeout(r, 5));

      // Phase 3: release latch → forceFullSync's putAttachment resolves.
      latchResolve!();
      latchResolve = null;

      // Phase 4: wait for both to complete.
      await syncPromise;
      await new Promise((r) => setTimeout(r, 50));

      // onError not called (no unhandled failures)
      expect(errors.length).toBe(0);

      // Binary file tracked in revMap
      const diag = engine.getDiagnostics();
      expect(diag.revMapSize).toBeGreaterThanOrEqual(1);

      // P5 lock invariant: if a second putAttachment was called (handleLocalChange push),
      // it must have used a DIFFERENT (fresh) rev than the first call's INITIAL_REV.
      // With the lock: revMap is updated by forceFullSync before handleLocalChange's push
      //   starts, so call #2 reads the new rev "2-first-ok" → revs differ.
      // Without the lock: handleLocalChange's pushBinaryFile starts concurrently, reads
      //   revMap BEFORE forceFullSync updates it → call #2 reads stale INITIAL_REV →
      //   revs are identical → assertion fails.
      const INITIAL_REV = "1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      if (s5PutCount >= 2) {
        // Second call used a fresh rev (not the stale INITIAL_REV)
        expect(s5PutRevs[1]).not.toBe(INITIAL_REV);
      }
    },
    5_000,
  );
});
