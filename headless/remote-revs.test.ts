/**
 * Tests for headless/remote-revs.ts — fetchRemoteRevs helper.
 *
 * AC2.0-bis guard: tests exercise a LARGE key set spanning multiple batches
 * (250 ids → 5 batches of 50) to prove the helper does NOT collapse to a
 * single POST. A 3-doc mock test that stays green after collapsing to one
 * request would be a "Vert ≠ couvert" false negative.
 *
 * Row semantics verified:
 *   - present → Map entry { rev, deleted: false }
 *   - tombstone (value.deleted=true) → Map entry { rev, deleted: true }
 *   - not_found / error → absent from Map
 *
 * The tombstone case is asserted with deep-equal (not just "present") because
 * reconcile (next cycle) must distinguish tombstone from absent.
 */

import { describe, it, expect, vi } from "vitest";
import {
  fetchRemoteRevs,
  PHANTOM_BATCH_SIZE,
  type RemoteDbForPhantomCheck,
  type RemoteRevEntry,
} from "./remote-revs";

// ---- Remote mock helpers ----------------------------------------------------

type AllDocsRow =
  | { id: string; key: string; value: { rev: string; deleted?: boolean } }
  | { key: string; error: string };

/**
 * Minimal remote mock: existing ids return a value row, deleted ids return
 * value.deleted:true, all others return { key, error: "not_found" }.
 */
function makeRemoteMock(
  existingIds: Set<string>,
  deletedIds: Set<string> = new Set(),
) {
  const batchCalls: string[][] = [];

  const mock: RemoteDbForPhantomCheck & { _batchCalls: string[][] } = {
    _batchCalls: batchCalls,

    async allDocs(opts: { keys: string[]; include_docs: false }) {
      batchCalls.push([...opts.keys]);
      const rows: AllDocsRow[] = opts.keys.map(key => {
        if (existingIds.has(key)) {
          return { id: key, key, value: { rev: "1-abc" } };
        }
        if (deletedIds.has(key)) {
          return { id: key, key, value: { rev: "2-deleted", deleted: true } };
        }
        return { key, error: "not_found" };
      });
      return { rows };
    },
  };

  return mock;
}

/**
 * Remote mock that fails the first `failCount` calls then succeeds.
 */
function makeRetryMock(
  existingIds: Set<string>,
  failCount: number,
) {
  let callCount = 0;
  const batchCalls: string[][] = [];

  const mock: RemoteDbForPhantomCheck & { _batchCalls: string[][] } = {
    _batchCalls: batchCalls,

    async allDocs(opts: { keys: string[]; include_docs: false }) {
      batchCalls.push([...opts.keys]);
      if (callCount < failCount) {
        callCount++;
        throw new Error(`simulated allDocs timeout (attempt ${callCount})`);
      }
      callCount++;
      const rows = opts.keys.map(key =>
        existingIds.has(key)
          ? { id: key, key, value: { rev: "1-abc" } }
          : { key, error: "not_found" },
      );
      return { rows };
    },
  };

  return mock;
}

// ---- Tests ------------------------------------------------------------------

describe("fetchRemoteRevs()", () => {
  // ---- Row semantics --------------------------------------------------------

  describe("row outcome semantics", () => {
    it("present doc → Map entry { rev, deleted: false }", async () => {
      const remoteDb = makeRemoteMock(new Set(["file/a.md"]));
      const result = await fetchRemoteRevs(remoteDb, ["file/a.md"]);

      expect(result.has("file/a.md")).toBe(true);
      expect(result.get("file/a.md")).toEqual<RemoteRevEntry>({
        rev: "1-abc",
        deleted: false,
      });
    });

    it("tombstoned doc → Map entry { rev, deleted: true } (NOT absent)", async () => {
      // Critical: tombstone must be PRESENT in the map with deleted:true.
      // Reconcile (next cycle) distinguishes "remote tombstone" from "remote never had it".
      // A helper that drops tombstones would look green on converter tests but would
      // cause reconcile to mis-classify tombstoned docs as "never existed".
      const remoteDb = makeRemoteMock(new Set(), new Set(["file/dead.md"]));
      const result = await fetchRemoteRevs(remoteDb, ["file/dead.md"]);

      expect(result.has("file/dead.md")).toBe(true);
      expect(result.get("file/dead.md")).toEqual<RemoteRevEntry>({
        rev: "2-deleted",
        deleted: true,
      });
    });

    it("not_found / error doc → absent from Map", async () => {
      const remoteDb = makeRemoteMock(new Set()); // nothing exists
      const result = await fetchRemoteRevs(remoteDb, ["file/ghost.md"]);

      expect(result.has("file/ghost.md")).toBe(false);
      expect(result.size).toBe(0);
    });

    it("mixed row outcomes in one call — all three outcomes", async () => {
      const ids = ["file/present.md", "file/dead.md", "file/ghost.md"];
      const remoteDb = makeRemoteMock(
        new Set(["file/present.md"]),
        new Set(["file/dead.md"]),
      );
      const result = await fetchRemoteRevs(remoteDb, ids);

      // present
      expect(result.get("file/present.md")).toEqual<RemoteRevEntry>({
        rev: "1-abc",
        deleted: false,
      });
      // tombstone — present in map, deleted:true
      expect(result.get("file/dead.md")).toEqual<RemoteRevEntry>({
        rev: "2-deleted",
        deleted: true,
      });
      // not_found — absent
      expect(result.has("file/ghost.md")).toBe(false);

      expect(result.size).toBe(2);
    });

    it("empty id list → empty Map, no allDocs call", async () => {
      const remoteDb = makeRemoteMock(new Set());
      const result = await fetchRemoteRevs(remoteDb, []);

      expect(result.size).toBe(0);
      expect(remoteDb._batchCalls).toHaveLength(0);
    });
  });

  // ---- Batching (AC2.0-bis) -------------------------------------------------

  describe("batching — AC2.0-bis guard", () => {
    it("250 ids → exactly 5 batches of 50 each (PHANTOM_BATCH_SIZE=50)", async () => {
      // This test is the AC2.0-bis guard: if the helper ever collapses to a
      // single POST, this will fail with batchCalls.length === 1.
      // The real Mantu vault has ~14k docs — a single POST times out on Fly.io.
      const ids: string[] = [];
      const existingIds = new Set<string>();

      for (let i = 0; i < 250; i++) {
        const id = `file/doc-${i}.md`;
        ids.push(id);
        if (i >= 200) existingIds.add(id); // last 50 exist, first 200 are not_found
      }

      const remoteDb = makeRemoteMock(existingIds);
      const result = await fetchRemoteRevs(remoteDb, ids);

      // Batching invariants
      expect(remoteDb._batchCalls).toHaveLength(5);
      for (const batch of remoteDb._batchCalls) {
        expect(batch).toHaveLength(PHANTOM_BATCH_SIZE);
      }

      // Map correctness: 50 present entries (ids 200-249), 200 not_found (absent)
      expect(result.size).toBe(50);
      for (const id of ids.slice(200)) {
        expect(result.get(id)).toEqual<RemoteRevEntry>({ rev: "1-abc", deleted: false });
      }
      for (const id of ids.slice(0, 200)) {
        expect(result.has(id)).toBe(false);
      }
    });

    it("51 ids → 2 batches (50 + 1)", async () => {
      const ids = Array.from({ length: 51 }, (_, i) => `file/doc-${i}.md`);
      const remoteDb = makeRemoteMock(new Set());
      await fetchRemoteRevs(remoteDb, ids);

      expect(remoteDb._batchCalls).toHaveLength(2);
      expect(remoteDb._batchCalls[0]).toHaveLength(50);
      expect(remoteDb._batchCalls[1]).toHaveLength(1);
    });

    it("exactly 50 ids → 1 batch (boundary: no off-by-one split)", async () => {
      const ids = Array.from({ length: 50 }, (_, i) => `file/doc-${i}.md`);
      const remoteDb = makeRemoteMock(new Set());
      await fetchRemoteRevs(remoteDb, ids);

      expect(remoteDb._batchCalls).toHaveLength(1);
      expect(remoteDb._batchCalls[0]).toHaveLength(50);
    });
  });

  // ---- Retry and abort (behavior-preserving) --------------------------------

  describe("retry / abort behavior", () => {
    it("retries on transient failure and succeeds on 2nd attempt", async () => {
      const remoteDb = makeRetryMock(new Set(["file/a.md"]), 1 /* fail once */);

      vi.useFakeTimers();
      const resultPromise = fetchRemoteRevs(remoteDb, ["file/a.md", ".DS_Store"]);
      // Advance past the 1s backoff for retry 1
      await vi.advanceTimersByTimeAsync(1_500);
      const result = await resultPromise;
      vi.useRealTimers();

      expect(result.has("file/a.md")).toBe(true);
      expect(result.has(".DS_Store")).toBe(false);
      // 2 calls: initial (fail) + 1 retry (success)
      expect(remoteDb._batchCalls).toHaveLength(2);
    });

    it("throws after exhausting all retries (abort — never silently treat as absent)", async () => {
      // If fetchRemoteRevs silently returned an empty map on exhaustion, callers
      // would treat ALL queried ids as "not found" — a correctness catastrophe
      // (reconcile would push everything as if remote is empty).
      const remoteDb = makeRetryMock(new Set(), 10 /* always fails */);

      vi.useFakeTimers();
      const resultPromise = fetchRemoteRevs(remoteDb, ["file/a.md"]);

      const rejectionAssertion = expect(resultPromise).rejects.toThrow(
        /phantom check failed for batch.*aborting migration/,
      );

      // Advance past all backoffs: 1s + 2s + 4s = 7s total
      await vi.advanceTimersByTimeAsync(10_000);
      await rejectionAssertion;
      vi.useRealTimers();

      // 1 initial + 3 retries = 4 total attempts
      expect(remoteDb._batchCalls).toHaveLength(4);
    });
  });
});
