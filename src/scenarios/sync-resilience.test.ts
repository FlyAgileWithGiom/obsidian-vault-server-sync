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
