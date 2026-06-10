import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveStatePath,
  resolvePouchDir,
  runDaemonV2Startup,
  runReconcileOnStartup,
  loadConfig,
  scrubInVaultConfig,
} from "./main";
import {
  SECRET_ID_COUCH_USER,
  SECRET_ID_COUCH_PASSWORD,
  ENV_COUCH_USER,
  ENV_COUCH_PASSWORD,
  type SecretStore,
} from "../src/secret-store";

// ---------------------------------------------------------------------------
// State file location (issue #54)
// ---------------------------------------------------------------------------

describe("resolveStatePath", () => {
  // The 2026-05-23 incident: daemon wrote .vault-sync-state.json at vault root.
  // When the vault lives in Dropbox/iCloud, cloud sync creates "conflicted copy"
  // variants of the state file on every fast write burst. Those copies are then
  // walked as user content and pushed to CouchDB. Infinite loop.
  // Fix: state file must live OUTSIDE the vault and outside cloud-sync scope.

  it("returns a path outside the vault root (macOS Application Support)", () => {
    const vaultRoot = "/Users/alice/Dropbox/MyVault";
    const dbName = "vault-myvault";
    const result = resolveStatePath(vaultRoot, dbName, { platform: "darwin", home: "/Users/alice" });
    expect(result.startsWith(vaultRoot)).toBe(false);
    expect(result).toBe("/Users/alice/Library/Application Support/vault-sync-daemon/vault-myvault/state.json");
  });

  it("returns ~/.config path on Linux", () => {
    const result = resolveStatePath("/home/bob/vault", "vault-bob", { platform: "linux", home: "/home/bob" });
    expect(result).toBe("/home/bob/.config/vault-sync-daemon/vault-bob/state.json");
  });

  it("returns %APPDATA% path on Windows", () => {
    const result = resolveStatePath("C:\\vault", "vault-x", {
      platform: "win32", home: "C:\\Users\\X", appData: "C:\\Users\\X\\AppData\\Roaming",
    });
    // path.join produces forward slashes on Linux test host, but the leading
    // %APPDATA% segment must be preserved.
    expect(result).toContain("vault-sync-daemon");
    expect(result).toContain("vault-x");
    expect(result).toContain("state.json");
    expect(result).toContain("AppData");
  });

  it("disambiguates by dbName (different vaults => different state paths)", () => {
    const a = resolveStatePath("/Users/alice/A", "vault-a", { platform: "darwin", home: "/Users/alice" });
    const b = resolveStatePath("/Users/alice/B", "vault-b", { platform: "darwin", home: "/Users/alice" });
    expect(a).not.toBe(b);
  });

  it("stable slug: same couchDbName from different vault roots produces the same state path (cross-run identity)", () => {
    // Two calls that differ only in vaultRoot but share the same dbName must
    // resolve to the same path so a daemon restart on the same DB never creates
    // a duplicate state file (regression guard for issue #54 migration).
    const first  = resolveStatePath("/Users/alice/VaultA", "my-vault", { platform: "darwin", home: "/Users/alice" });
    const second = resolveStatePath("/Users/alice/VaultB", "my-vault", { platform: "darwin", home: "/Users/alice" });
    expect(first).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// resolvePouchDir — PouchDB LevelDB path (C06)
// ---------------------------------------------------------------------------

describe("resolvePouchDir", () => {
  it("returns AppSupport/<dbName>/pouch/ on macOS", () => {
    const result = resolvePouchDir("vault-obsidiannotes", { platform: "darwin", home: "/Users/alice" });
    expect(result).toBe("/Users/alice/Library/Application Support/vault-sync-daemon/vault-obsidiannotes/pouch");
  });

  it("returns ~/.config/<dbName>/pouch/ on Linux", () => {
    const result = resolvePouchDir("vault-bob", { platform: "linux", home: "/home/bob" });
    expect(result).toBe("/home/bob/.config/vault-sync-daemon/vault-bob/pouch");
  });

  it("returns %APPDATA%/<dbName>/pouch/ on Windows", () => {
    const result = resolvePouchDir("vault-x", {
      platform: "win32", home: "C:\\Users\\X", appData: "C:\\Users\\X\\AppData\\Roaming",
    });
    expect(result).toContain("vault-sync-daemon");
    expect(result).toContain("vault-x");
    expect(result).toContain("pouch");
  });

  it("pouchDir is a sibling of statePath, not the same path", () => {
    const stateDir = path.dirname(
      resolveStatePath("/vault", "vault-test", { platform: "darwin", home: "/Users/alice" }),
    );
    const pouchDir = resolvePouchDir("vault-test", { platform: "darwin", home: "/Users/alice" });
    // Both live under vault-sync-daemon/vault-test/ but are distinct subdirs
    expect(pouchDir).not.toBe(stateDir);
    expect(path.dirname(pouchDir)).toBe(stateDir);
  });

  it("disambiguates by dbName", () => {
    const a = resolvePouchDir("vault-a", { platform: "darwin", home: "/Users/alice" });
    const b = resolvePouchDir("vault-b", { platform: "darwin", home: "/Users/alice" });
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// DAEMON_V2 path — PouchDB data directory layout (C06)
// ---------------------------------------------------------------------------

describe("DAEMON_V2 — PouchDB data directory layout", () => {
  it("resolvePouchDir places PouchDB under the same vault-sync-daemon dir as resolveStatePath", () => {
    const dbName = "vault-obsidiannotes";
    const env = { platform: "darwin" as NodeJS.Platform, home: "/Users/alice" };
    const statePath = resolveStatePath("/vault", dbName, env);
    const pouchDir = resolvePouchDir(dbName, env);

    // Both resolve to the same parent dir (vault-sync-daemon/dbName/)
    const stateParent = path.dirname(statePath);  // vault-sync-daemon/dbName
    const pouchParent = path.dirname(pouchDir);   // vault-sync-daemon/dbName

    expect(stateParent).toBe(pouchParent);
    // Pouch sub-directory name is "pouch"
    expect(path.basename(pouchDir)).toBe("pouch");
  });

  it("PouchDB db path resolves to ~/Library/Application Support/vault-sync-daemon/<dbName>/pouch on macOS", () => {
    const dbName = "vault-obsidiannotes";
    const pouchDir = resolvePouchDir(dbName, { platform: "darwin", home: os.homedir() });
    expect(pouchDir).toContain("Library/Application Support/vault-sync-daemon");
    expect(pouchDir).toContain(dbName);
    expect(pouchDir).toEndWith("pouch");
  });
});

// Extend the vi import to add a toEndWith-compatible check
declare global {
  interface Array<T> {
    includes(searchElement: T, fromIndex?: number): boolean;
  }
}

// Custom matcher shim: path ends with expected suffix
expect.extend({
  toEndWith(received: string, suffix: string) {
    const pass = received.endsWith(suffix);
    return {
      pass,
      message: () => `expected "${received}" to end with "${suffix}"`,
    };
  },
});

// Augment vitest types for custom matcher
declare module "vitest" {
  interface Assertion<R = unknown> {
    toEndWith(suffix: string): R;
  }
}

// ---------------------------------------------------------------------------
// BUG #69 — Init-order regression guard
// ---------------------------------------------------------------------------
// Verifies that runDaemonV2Startup runs reconcile to completion BEFORE calling
// bridge.start(). If bridge.start() fires first, a Dropbox/iCloud FS event
// during boot can arm the watcher/changes feed before the local PouchDB has
// been reconciled against disk, racing the reconcile pass.

const FAKE_RECONCILE = vi.fn(async () => null);

describe("runDaemonV2Startup — reconcile runs before bridge.start (init-order guard)", () => {
  it("calls reconcile to completion before bridge.start is called", async () => {
    const callOrder: string[] = [];

    const mockBridge = {
      start: vi.fn(() => { callOrder.push("bridge.start"); }),
    };

    const mockReconcile = vi.fn(async () => {
      callOrder.push("runReconcile");
      return null;
    });

    const mockFsWatcher = {};

    const mockEngine = {
      start: vi.fn(async () => { callOrder.push("engine.start"); }),
    };

    await runDaemonV2Startup({
      bridge: mockBridge,
      runReconcile: mockReconcile,
      fsWatcher: mockFsWatcher,
      engine: mockEngine,
    });

    // All three must have been called
    expect(mockReconcile).toHaveBeenCalledOnce();
    expect(mockBridge.start).toHaveBeenCalledOnce();
    expect(mockEngine.start).toHaveBeenCalledOnce();

    // Critical ordering: reconcile → bridge.start → engine.start
    expect(callOrder.indexOf("runReconcile")).toBeLessThan(callOrder.indexOf("bridge.start"));
    expect(callOrder.indexOf("bridge.start")).toBeLessThan(callOrder.indexOf("engine.start"));
  });

  it("passes the fsWatcher to bridge.start", async () => {
    const mockFsWatcher = { _tag: "fsWatcher" };
    const mockBridge = { start: vi.fn() };
    const mockEngine = { start: vi.fn(async () => {}) };

    await runDaemonV2Startup({
      bridge: mockBridge,
      runReconcile: FAKE_RECONCILE,
      fsWatcher: mockFsWatcher,
      engine: mockEngine,
    });

    expect(mockBridge.start).toHaveBeenCalledWith(mockFsWatcher);
  });
});

// ---------------------------------------------------------------------------
// Reconcile gate + skip-on-fail (RC2 Cycle 3)
// ---------------------------------------------------------------------------

describe("runReconcileOnStartup — first-run gate (AC2.6)", () => {
  it("skips reconcile on first run: returns null when doc_count === 0", async () => {
    const db = {
      info: vi.fn(async () => ({ doc_count: 0 })),
      allDocs: vi.fn(async () => ({ rows: [] })),
      get: vi.fn(async () => { throw { status: 404 }; }),
    };

    const result = await runReconcileOnStartup({
      db,
      bridge: {
        reconcilePush: vi.fn(),
        reconcilePull: vi.fn(),
        reconcileTombstone: vi.fn(),
        reconcileSuppressEcho: vi.fn(),
      },
      vaultAdapter: { getFiles: () => [], async readText() { throw new Error("not called"); }, async readBinary(): Promise<ArrayBuffer> { throw new Error("not called"); }, async createText(): Promise<import("../src/types").VaultFile> { throw new Error("not called"); }, async createBinary(): Promise<import("../src/types").VaultFile> { throw new Error("not called"); }, getEntryByPath(): import("../src/types").VaultEntry | null { return null; } },
      remoteDb: { async allDocs() { return { rows: [] }; } },
      excludePatterns: [],
    });

    expect(result).toBeNull();
    // allDocs / reconcile actions must NOT have been called
    expect(db.allDocs).not.toHaveBeenCalled();
  });

  it("runs reconcile when doc_count > 0 (non-first-run)", async () => {
    const db = {
      info: vi.fn(async () => ({ doc_count: 5 })),
      allDocs: vi.fn(async () => ({ rows: [] })),
      get: vi.fn(async () => { throw { status: 404 }; }),
    };

    const result = await runReconcileOnStartup({
      db,
      bridge: {
        reconcilePush: vi.fn(),
        reconcilePull: vi.fn(),
        reconcileTombstone: vi.fn(),
        reconcileSuppressEcho: vi.fn(),
      },
      vaultAdapter: { getFiles: () => [], async readText() { throw new Error("not called"); }, async readBinary(): Promise<ArrayBuffer> { throw new Error("not called"); }, async createText(): Promise<import("../src/types").VaultFile> { throw new Error("not called"); }, async createBinary(): Promise<import("../src/types").VaultFile> { throw new Error("not called"); }, getEntryByPath(): import("../src/types").VaultEntry | null { return null; } },
      remoteDb: { async allDocs() { return { rows: [] }; } },
      excludePatterns: [],
    });

    // With no vault files and no local docs, counts are all zero but non-null
    expect(result).not.toBeNull();
    expect(db.allDocs).toHaveBeenCalled();
  });
});

describe("runReconcileOnStartup — skip-on-fetch-fail (critical safety)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("skips reconcile and returns null when fetchRemoteRevs throws (CouchDB unreachable)", async () => {
    // Pre-seed some local doc IDs so the union set is non-empty and allDocs IS called.
    // fetchRemoteRevs has retry logic (PHANTOM_BATCH_MAX_RETRIES=3 + backoff);
    // we use fake timers so the test doesn't actually wait 7s.
    const db = {
      info: vi.fn(async () => ({ doc_count: 5 })),
      allDocs: vi.fn(async () => ({ rows: [
        { id: "file/doc-a.md" },
        { id: "file/doc-b.md" },
      ] })),
      get: vi.fn(async () => { throw { status: 404 }; }),
    };
    const bridge = {
      reconcilePush: vi.fn(),
      reconcilePull: vi.fn(),
      reconcileTombstone: vi.fn(),
      reconcileSuppressEcho: vi.fn(),
    };

    // Simulate CouchDB unreachable: remoteDb throws on every allDocs call
    const unreachableRemoteDb = {
      async allDocs() { throw new Error("ECONNREFUSED"); },
    };

    // Kick off reconcile (it will stall in the retry backoff setTimeout calls)
    const resultPromise = runReconcileOnStartup({
      db,
      bridge,
      vaultAdapter: { getFiles: () => [], async readText() { throw new Error("not called"); }, async readBinary(): Promise<ArrayBuffer> { throw new Error("not called"); }, async createText(): Promise<import("../src/types").VaultFile> { throw new Error("not called"); }, async createBinary(): Promise<import("../src/types").VaultFile> { throw new Error("not called"); }, getEntryByPath(): import("../src/types").VaultEntry | null { return null; } },
      remoteDb: unreachableRemoteDb,
      excludePatterns: [],
    });

    // Advance through all retry backoffs (1s + 2s + 4s = 7s, run all pending timers)
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result).toBeNull();
    // No push/tombstone must have been applied without remote knowledge
    expect(bridge.reconcilePush).not.toHaveBeenCalled();
    expect(bridge.reconcileTombstone).not.toHaveBeenCalled();
  });

  it("bridge.start and engine.start still called after skip-on-fetch-fail", async () => {
    const callOrder: string[] = [];

    const failingReconcile = async () => {
      // Simulate fetchRemoteRevs throwing inside runReconcileOnStartup;
      // the result is null (skip-on-fail) — bridge.start must still be called.
      callOrder.push("runReconcile");
      return null;
    };

    const mockBridge = { start: vi.fn(() => { callOrder.push("bridge.start"); }) };
    const mockEngine = { start: vi.fn(async () => { callOrder.push("engine.start"); }) };

    await runDaemonV2Startup({
      bridge: mockBridge,
      runReconcile: failingReconcile,
      fsWatcher: {},
      engine: mockEngine,
    });

    expect(callOrder).toEqual(["runReconcile", "bridge.start", "engine.start"]);
  });
});

// ---------------------------------------------------------------------------
// Crash-safe replace marker (BUG: wipe-before-destroy crash window)
//
// The bug: replaceLocalFromServer() wiped the FS BEFORE destroying PouchDB.
// If the process died in that window, the next boot saw:
//   - PouchDB with all 319 docs (not destroyed)
//   - FS empty (already wiped)
// runReconcileOnStartup ran, found all docs FS-absent, and tombstoned all of
// them → propagated to CouchDB → 319 notes deleted across all devices.
//
// The fix (three parts):
//   1. Reverse the order: destroy PouchDB FIRST, then wipe FS.
//   2. Write a durable marker before touching anything.
//   3. On startup: if marker is present, skip reconcile entirely (treat as
//      first-run regardless of doc_count) and resume with a fresh full pull.
//      Clear the marker only after the pull completes successfully.
// ---------------------------------------------------------------------------

describe("runReconcileOnStartup — crash-safe replace marker (BUG crash window)", () => {
  it("skips reconcile and returns null when hasReplaceMarker returns true (even with doc_count > 0)", async () => {
    // Simulates the crash-during-replace scenario: PouchDB has 319 docs (it was
    // partially populated during a prior pull that crashed), and the FS may be
    // empty. Without the marker guard, runReconcileOnStartup would tombstone all
    // 319 docs. With the marker, it must skip entirely.
    const db = {
      info: vi.fn(async () => ({ doc_count: 319 })),
      allDocs: vi.fn(async () => ({
        rows: [
          { id: "file/note-1.md" },
          { id: "file/note-2.md" },
          { id: "file/note-3.md" },
        ],
      })),
      get: vi.fn(async (id: string) => ({
        _id: id, _rev: "1-abc", content: "was here",
      })),
    };
    const bridge = {
      reconcilePush: vi.fn(),
      reconcilePull: vi.fn(),
      reconcileTombstone: vi.fn(),
      reconcileSuppressEcho: vi.fn(),
    };

    const result = await runReconcileOnStartup({
      db,
      bridge,
      vaultAdapter: {
        getFiles: () => [], // FS is empty — exactly the crash-window state
        async readText() { throw new Error("not called"); },
        async readBinary(): Promise<ArrayBuffer> { throw new Error("not called"); },
        async createText(): Promise<import("../src/types").VaultFile> { throw new Error("not called"); },
        async createBinary(): Promise<import("../src/types").VaultFile> { throw new Error("not called"); },
        getEntryByPath(): import("../src/types").VaultEntry | null { return null; },
      },
      remoteDb: {
        // Remote has the docs — same revs as local (exactly the AC2.3a tombstone condition).
        // Shape: { key, value: { rev, deleted? } } as fetchRemoteRevs expects.
        async allDocs(_opts: { keys: string[]; include_docs: false }) {
          return {
            rows: [
              { key: "file/note-1.md", value: { rev: "1-abc" } },
              { key: "file/note-2.md", value: { rev: "1-abc" } },
              { key: "file/note-3.md", value: { rev: "1-abc" } },
            ],
          };
        },
      },
      excludePatterns: [],
      hasReplaceMarker: () => true, // marker present — replace was in progress
    });

    // Must skip entirely when marker is present
    expect(result).toBeNull();

    // The critical assertion: tombstone must NEVER be called when marker is present.
    // Without the fix, reconcile would call reconcileTombstone 3 times (AC2.3a),
    // deleting all 3 notes and propagating deletions to CouchDB.
    expect(bridge.reconcileTombstone).not.toHaveBeenCalled();
    expect(bridge.reconcilePush).not.toHaveBeenCalled();
    // allDocs must not be called — skipped before reaching that point
    expect(db.allDocs).not.toHaveBeenCalled();
  });

  it("still runs reconcile normally when hasReplaceMarker returns false", async () => {
    // Control: without marker, non-first-run reconcile still runs as before
    const db = {
      info: vi.fn(async () => ({ doc_count: 5 })),
      allDocs: vi.fn(async () => ({ rows: [] })),
      get: vi.fn(async () => { throw { status: 404 }; }),
    };

    const result = await runReconcileOnStartup({
      db,
      bridge: {
        reconcilePush: vi.fn(),
        reconcilePull: vi.fn(),
        reconcileTombstone: vi.fn(),
        reconcileSuppressEcho: vi.fn(),
      },
      vaultAdapter: {
        getFiles: () => [],
        async readText() { throw new Error("not called"); },
        async readBinary(): Promise<ArrayBuffer> { throw new Error("not called"); },
        async createText(): Promise<import("../src/types").VaultFile> { throw new Error("not called"); },
        async createBinary(): Promise<import("../src/types").VaultFile> { throw new Error("not called"); },
        getEntryByPath(): import("../src/types").VaultEntry | null { return null; },
      },
      remoteDb: { async allDocs() { return { rows: [] }; } },
      excludePatterns: [],
      hasReplaceMarker: () => false, // no marker — normal reconcile path
    });

    // Non-first-run with no marker should still run reconcile (non-null result)
    expect(result).not.toBeNull();
    expect(db.allDocs).toHaveBeenCalled();
  });

  it("still runs reconcile normally when hasReplaceMarker is absent (backwards-compatible)", async () => {
    // Callers that don't pass hasReplaceMarker get the original behavior
    const db = {
      info: vi.fn(async () => ({ doc_count: 5 })),
      allDocs: vi.fn(async () => ({ rows: [] })),
      get: vi.fn(async () => { throw { status: 404 }; }),
    };

    const result = await runReconcileOnStartup({
      db,
      bridge: {
        reconcilePush: vi.fn(),
        reconcilePull: vi.fn(),
        reconcileTombstone: vi.fn(),
        reconcileSuppressEcho: vi.fn(),
      },
      vaultAdapter: {
        getFiles: () => [],
        async readText() { throw new Error("not called"); },
        async readBinary(): Promise<ArrayBuffer> { throw new Error("not called"); },
        async createText(): Promise<import("../src/types").VaultFile> { throw new Error("not called"); },
        async createBinary(): Promise<import("../src/types").VaultFile> { throw new Error("not called"); },
        getEntryByPath(): import("../src/types").VaultEntry | null { return null; },
      },
      remoteDb: { async allDocs() { return { rows: [] }; } },
      excludePatterns: [],
      // hasReplaceMarker intentionally absent
    });

    expect(result).not.toBeNull();
    expect(db.allDocs).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Resilient apply-loop (#79 crash-loop class): one bad reconcile action must
// not abort daemon startup. After FIX #1 (markDeletedInPouch rethrows non-404),
// reconcileTombstone can throw on a catastrophic error (DB closed / IO / bad
// doc). Without a per-action guard, that propagates out of the loop → out of
// runReconcile → aborts runDaemonV2Startup → LaunchAgent restart → crash-loop.
// The fix: log-and-continue per action, count the failure, keep applying the
// rest. (Distinct from FIX #1's silent swallow — failures are logged + counted.)
// ---------------------------------------------------------------------------

describe("runReconcileOnStartup — resilient apply-loop (#79 crash-loop class)", () => {
  it("logs and continues when one tombstone action throws (no crash-loop)", async () => {
    // Two local docs, both FS-absent and remote not_found → reconcile produces
    // two tombstone actions (FS-absent + remote===undefined → tombstone).
    const db = {
      info: vi.fn(async () => ({ doc_count: 5 })),
      allDocs: vi.fn(async () => ({ rows: [
        { id: "file/doomed.md" },
        { id: "file/survivor.md" },
      ] })),
      // localGet must return a doc (FS-absent + local doc present → tombstone branch)
      get: vi.fn(async (docId: string) => ({ _id: docId, _rev: "1-abc", content: "x" })),
    };

    // First tombstone throws a catastrophic non-404 (the class FIX #1 now rethrows);
    // the second resolves. Proves the loop still ATTEMPTS the survivor.
    const reconcileTombstone = vi.fn()
      .mockRejectedValueOnce(new Error("PouchDB database is closed"))
      .mockResolvedValueOnce(undefined);

    const bridge = {
      reconcilePush: vi.fn(),
      reconcilePull: vi.fn(),
      reconcileTombstone,
      reconcileSuppressEcho: vi.fn(),
    };

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    let result: Awaited<ReturnType<typeof runReconcileOnStartup>>;
    let errorCallCount: number;
    try {
      // The loop must NOT throw out — this await resolving is the core assertion.
      result = await runReconcileOnStartup({
        db,
        bridge,
        vaultAdapter: {
          getFiles: () => [], // both docs FS-absent
          async readText() { throw new Error("not called"); },
          async readBinary(): Promise<ArrayBuffer> { throw new Error("not called"); },
          async createText(): Promise<import("../src/types").VaultFile> { throw new Error("not called"); },
          async createBinary(): Promise<import("../src/types").VaultFile> { throw new Error("not called"); },
          getEntryByPath(): import("../src/types").VaultEntry | null { return null; },
        },
        // not_found for every key → empty remoteRevs map → FS-absent docs tombstone
        remoteDb: { async allDocs({ keys }: { keys: string[] }) {
          return { rows: keys.map((key) => ({ key, error: "not_found" })) };
        } },
        excludePatterns: [],
      });
    } finally {
      // Capture call count BEFORE restore — mockRestore() wipes the call record.
      errorCallCount = errorSpy.mock.calls.length;
      errorSpy.mockRestore();
    }

    // The survivor was still attempted (loop did not abort on the first failure).
    expect(reconcileTombstone).toHaveBeenCalledTimes(2);

    // Failure logged (not silently swallowed — the anti-pattern FIX #1 removed).
    expect(errorCallCount).toBeGreaterThan(0);

    // Failure counted; the survivor counted as a success, not as the failure.
    expect(result).not.toBeNull();
    expect(result!.failed).toBe(1);
    expect(result!.tombstone).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// loadConfig + Phase A/B (#78) — credential precedence and out-of-vault store
// ---------------------------------------------------------------------------

/** In-memory SecretStore stand-in; never touches the real keychain. */
function fakeStore(initial: Record<string, string> = {}): SecretStore & {
  _dump(): Record<string, string>;
} {
  const m = new Map(Object.entries(initial));
  return {
    async get(id) {
      return m.has(id) ? (m.get(id) as string) : null;
    },
    async set(id, value) {
      m.set(id, value);
    },
    isAvailable() {
      return true;
    },
    _dump() {
      return Object.fromEntries(m);
    },
  };
}

function tmpVault(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vault-sync-cfg-"));
}

function writeConfig(vaultRoot: string, config: Record<string, unknown>): string {
  const p = path.join(vaultRoot, ".vault-sync.json");
  fs.writeFileSync(p, JSON.stringify(config, null, 2));
  return p;
}

describe("loadConfig — credential precedence (env > store > legacy in-vault) (#78)", () => {
  it("uses the store secret over the legacy in-vault secret", async () => {
    const vault = tmpVault();
    writeConfig(vault, {
      couchDbUrl: "https://couch.example.com",
      couchDbName: "vault-x",
      couchDbUser: "legacy-user",
      couchDbPassword: "legacy-pass",
      excludePatterns: [],
    });
    const store = fakeStore({
      [SECRET_ID_COUCH_USER]: "store-user",
      [SECRET_ID_COUCH_PASSWORD]: "store-pass",
    });

    const cfg = await loadConfig(vault, { store, env: {} });
    expect(cfg.couchDbUser).toBe("store-user");
    expect(cfg.couchDbPassword).toBe("store-pass");
  });

  it("prefers env over both store and legacy", async () => {
    const vault = tmpVault();
    writeConfig(vault, {
      couchDbUrl: "https://couch.example.com",
      couchDbName: "vault-x",
      couchDbUser: "legacy-user",
      couchDbPassword: "legacy-pass",
      excludePatterns: [],
    });
    const store = fakeStore({
      [SECRET_ID_COUCH_USER]: "store-user",
      [SECRET_ID_COUCH_PASSWORD]: "store-pass",
    });
    const env = { [ENV_COUCH_USER]: "env-user", [ENV_COUCH_PASSWORD]: "env-pass" };

    const cfg = await loadConfig(vault, { store, env });
    expect(cfg.couchDbUser).toBe("env-user");
    expect(cfg.couchDbPassword).toBe("env-pass");
  });

  it("Phase A: copies a legacy in-vault secret into the store without deleting it from the file", async () => {
    const vault = tmpVault();
    const configPath = writeConfig(vault, {
      couchDbUrl: "https://couch.example.com",
      couchDbName: "vault-x",
      couchDbUser: "legacy-user",
      couchDbPassword: "legacy-pass",
      excludePatterns: [],
    });
    const store = fakeStore();

    const cfg = await loadConfig(vault, { store, env: {} });
    expect(cfg.couchDbUser).toBe("legacy-user");
    expect(cfg.couchDbPassword).toBe("legacy-pass");

    // Store now seeded from the file...
    expect(store._dump()[SECRET_ID_COUCH_USER]).toBe("legacy-user");
    expect(store._dump()[SECRET_ID_COUCH_PASSWORD]).toBe("legacy-pass");

    // ...and the file STILL carries the secret (never deleted on load — invariant 2).
    const onDisk = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(onDisk.couchDbUser).toBe("legacy-user");
    expect(onDisk.couchDbPassword).toBe("legacy-pass");
  });

  it("FAIL-SAFE: returns empty credentials (does not exit/throw) when no secret is found anywhere", async () => {
    const vault = tmpVault();
    // File present (so couchDbUrl/couchDbName exist) but no secret keys.
    writeConfig(vault, {
      couchDbUrl: "https://couch.example.com",
      couchDbName: "vault-x",
      excludePatterns: [],
    });
    const store = fakeStore();

    // Must RETURN a config with empty creds — never process.exit, never throw.
    // Empty creds -> credential-less URL -> plain 401 -> reconcile skip, not a
    // destructive tombstone-everything resync (invariant 8).
    const cfg = await loadConfig(vault, { store, env: {} });
    expect(cfg.couchDbUser).toBe("");
    expect(cfg.couchDbPassword).toBe("");
    // Non-secret config still loaded.
    expect(cfg.couchDbUrl).toBe("https://couch.example.com");
    expect(cfg.couchDbName).toBe("vault-x");
  });

  it("still exits when the config FILE is missing (file is the only source of url/name)", async () => {
    const vault = tmpVault();
    // No .vault-sync.json written.
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code?: number) => {
        throw new Error("process.exit called");
      }) as never);
    try {
      await expect(loadConfig(vault, { store: fakeStore(), env: {} })).rejects.toThrow(
        "process.exit called",
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("scrubInVaultConfig — Phase B for the daemon (#78)", () => {
  it("removes the secret keys only after confirming the store has both, leaving the file otherwise intact", async () => {
    const vault = tmpVault();
    const configPath = writeConfig(vault, {
      couchDbUrl: "https://couch.example.com",
      couchDbName: "vault-x",
      couchDbUser: "alice",
      couchDbPassword: "hunter2",
      excludePatterns: [".trash/"],
    });
    const store = fakeStore({
      [SECRET_ID_COUCH_USER]: "alice",
      [SECRET_ID_COUCH_PASSWORD]: "hunter2",
    });

    const result = await scrubInVaultConfig(configPath, store);
    expect(result.scrubbed).toBe(true);

    const onDisk = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(onDisk.couchDbUser).toBeUndefined();
    expect(onDisk.couchDbPassword).toBeUndefined();
    expect(onDisk.couchDbUrl).toBe("https://couch.example.com");
    expect(onDisk.couchDbName).toBe("vault-x");
    expect(onDisk.excludePatterns).toEqual([".trash/"]);
  });

  it("refuses to scrub when the store is missing a credential (write-before-delete)", async () => {
    const vault = tmpVault();
    const configPath = writeConfig(vault, {
      couchDbUrl: "https://couch.example.com",
      couchDbName: "vault-x",
      couchDbUser: "alice",
      couchDbPassword: "hunter2",
      excludePatterns: [],
    });
    // Store has user but not password.
    const store = fakeStore({ [SECRET_ID_COUCH_USER]: "alice" });

    const result = await scrubInVaultConfig(configPath, store);
    expect(result.scrubbed).toBe(false);

    const onDisk = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(onDisk.couchDbUser).toBe("alice");
    expect(onDisk.couchDbPassword).toBe("hunter2");
  });

  it("is a no-op when the file has no secret keys", async () => {
    const vault = tmpVault();
    const configPath = writeConfig(vault, {
      couchDbUrl: "https://couch.example.com",
      couchDbName: "vault-x",
      excludePatterns: [],
    });
    const store = fakeStore({
      [SECRET_ID_COUCH_USER]: "alice",
      [SECRET_ID_COUCH_PASSWORD]: "hunter2",
    });

    const result = await scrubInVaultConfig(configPath, store);
    expect(result.scrubbed).toBe(false);
  });
});
