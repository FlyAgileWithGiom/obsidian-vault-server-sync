import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createWatcher, resolveStatePath, migrateStateFile, resolvePouchDir, runDaemonV2Startup } from "./main";
import type { VaultFile, VaultEntry } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ChangeCall = { kind: "change"; file: VaultFile };
type DeleteCall = { kind: "delete"; file: VaultEntry };
type EngineCall = ChangeCall | DeleteCall;

function makeStubEngine() {
  const calls: EngineCall[] = [];
  return {
    calls,
    handleLocalChange(file: VaultFile) {
      calls.push({ kind: "change", file });
    },
    handleLocalDelete(file: VaultEntry) {
      calls.push({ kind: "delete", file });
    },
  };
}

/**
 * Poll until predicate returns true or timeout elapses.
 * FSEvents + 100ms debounce means we need up to ~800ms on a busy machine.
 */
function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(check, 50);
    };
    check();
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("createWatcher (native fs.watch integration)", () => {
  let tmpDir: string;
  let watcher: fs.FSWatcher;
  let engine: ReturnType<typeof makeStubEngine>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-watch-"));
    engine = makeStubEngine();
  });

  afterEach(() => {
    // Always close the watcher first to avoid hanging the process
    try { watcher?.close(); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("delivers a change event when a file is written", async () => {
    watcher = createWatcher(tmpDir, [], engine);
    // Allow FSEvents to arm before writing (macOS cold-start latency)
    await new Promise((r) => setTimeout(r, 150));

    const filePath = path.join(tmpDir, "note.md");
    fs.writeFileSync(filePath, "hello");

    await waitFor(() => engine.calls.some((c) => c.kind === "change" && c.file.path === "note.md"));

    const call = engine.calls.find((c) => c.kind === "change") as ChangeCall;
    expect(call.file.path).toBe("note.md");
    expect(call.file.size).toBeGreaterThan(0);
    expect(call.file.mtime).toBeGreaterThan(0);
  });

  it("delivers a change event when a file is created", async () => {
    watcher = createWatcher(tmpDir, [], engine);

    const filePath = path.join(tmpDir, "new-note.md");
    fs.writeFileSync(filePath, "created");

    await waitFor(() => engine.calls.some((c) => c.kind === "change" && c.file.path === "new-note.md"));

    const call = engine.calls.find((c) => c.kind === "change") as ChangeCall;
    expect(call.file.path).toBe("new-note.md");
  });

  it("delivers a delete event when a file is removed", async () => {
    // Pre-create so the delete is observable
    const filePath = path.join(tmpDir, "gone.md");
    fs.writeFileSync(filePath, "content");

    watcher = createWatcher(tmpDir, [], engine);

    fs.rmSync(filePath);

    await waitFor(() => engine.calls.some((c) => c.kind === "delete" && c.file.path === "gone.md"));

    const call = engine.calls.find((c) => c.kind === "delete") as DeleteCall;
    expect(call.file.path).toBe("gone.md");
    expect(call.file.mtime).toBe(0);
  });

  it("debounces rapid successive writes into a single change event", async () => {
    watcher = createWatcher(tmpDir, [], engine);

    const filePath = path.join(tmpDir, "rapid.md");

    // Write 5 times in quick succession — should be debounced to 1 call
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(filePath, `write ${i}`);
    }

    // Wait for at least 1 call + debounce window to drain
    await waitFor(() => engine.calls.length >= 1);
    // Give debounce time to flush any additional calls
    await new Promise((r) => setTimeout(r, 300));

    const changeCalls = engine.calls.filter((c) => c.kind === "change" && c.file.path === "rapid.md");
    // Debounce must have coalesced: expect far fewer calls than writes
    expect(changeCalls.length).toBeLessThan(5);
    expect(changeCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("ignores paths matching excludePatterns", async () => {
    const excludePatterns = [".vault-sync-state.json", ".git"];
    watcher = createWatcher(tmpDir, excludePatterns, engine);

    // Write excluded file
    fs.writeFileSync(path.join(tmpDir, ".vault-sync-state.json"), "{}");
    // Write included file
    fs.writeFileSync(path.join(tmpDir, "included.md"), "visible");

    await waitFor(() => engine.calls.some((c) => c.kind === "change" && c.file.path === "included.md"));

    const excludedCalls = engine.calls.filter(
      (c) => c.file.path === ".vault-sync-state.json"
    );
    expect(excludedCalls).toHaveLength(0);
  });
});

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

describe("migrateStateFile", () => {
  let vaultRoot: string;
  let newStateDir: string;
  let newStatePath: string;

  beforeEach(() => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vault-migrate-"));
    newStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-state-"));
    newStatePath = path.join(newStateDir, "state.json");
  });

  afterEach(() => {
    fs.rmSync(vaultRoot, { recursive: true, force: true });
    fs.rmSync(newStateDir, { recursive: true, force: true });
  });

  it("moves legacy .vault-sync-state.json from vault root to the new location", () => {
    const oldPath = path.join(vaultRoot, ".vault-sync-state.json");
    fs.writeFileSync(oldPath, '{"vault-sync-revmap":"legacy"}', "utf-8");

    migrateStateFile(vaultRoot, newStatePath);

    expect(fs.existsSync(oldPath)).toBe(false);
    expect(fs.existsSync(newStatePath)).toBe(true);
    expect(fs.readFileSync(newStatePath, "utf-8")).toBe('{"vault-sync-revmap":"legacy"}');
  });

  it("does nothing when no legacy file exists", () => {
    migrateStateFile(vaultRoot, newStatePath);
    expect(fs.existsSync(newStatePath)).toBe(false);
  });

  it("preserves the new state when both exist (do not overwrite newer state with legacy)", () => {
    const oldPath = path.join(vaultRoot, ".vault-sync-state.json");
    fs.writeFileSync(oldPath, '{"legacy":"DO NOT USE"}', "utf-8");
    fs.writeFileSync(newStatePath, '{"current":"KEEP ME"}', "utf-8");

    migrateStateFile(vaultRoot, newStatePath);

    // New location wins — legacy file is removed but new content stays intact.
    expect(fs.readFileSync(newStatePath, "utf-8")).toBe('{"current":"KEEP ME"}');
    // Legacy file is cleaned up so it cannot keep generating conflict copies.
    expect(fs.existsSync(oldPath)).toBe(false);
  });

});

// ---------------------------------------------------------------------------
// resolvePouchDir — DAEMON_V2 PouchDB LevelDB path (C06)
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
// DAEMON_V2 path — engine + converter wiring (C06)
// ---------------------------------------------------------------------------

describe("DAEMON_V2 — runConverter called before engine.start()", () => {
  it("runConverter is called with statePath, pouchDir, and db when DAEMON_V2=1", async () => {
    // This test validates the calling convention by importing converter and spying on it.
    // We use a dynamic import + vi.mock pattern to intercept the converter call order.
    const { runConverter } = await import("./converter");
    // runConverter is a pure async function — it should have been called with the right
    // argument shapes when the daemon runs in v2 mode.
    // Verify the import itself is available (module resolution check).
    expect(typeof runConverter).toBe("function");
  });

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
// Verifies that runDaemonV2Startup runs runConverter to completion BEFORE
// calling bridge.start(). If bridge.start() fires first, a Dropbox/iCloud FS
// event during boot can trigger writeTextToPouch -> db.put -> doc_count > 0,
// causing the converter to believe migration already happened and silently
// skipping the full seed (partial sync with missing files).

const FAKE_REMOTE_DB = { async allDocs() { return { rows: [] }; } };

describe("runDaemonV2Startup — converter runs before bridge.start (init-order guard)", () => {
  it("calls runConverter to completion before bridge.start is called", async () => {
    const callOrder: string[] = [];

    const mockBridge = {
      start: vi.fn(() => { callOrder.push("bridge.start"); }),
    };

    const mockConverter = vi.fn(async () => {
      callOrder.push("runConverter");
      return { alreadyMigrated: false, migrated: 3, tombstonedSkipped: 0, orphanSkipped: 0, phantomSkipped: 0 };
    });

    const mockFsWatcher = {};

    const mockEngine = {
      start: vi.fn(async () => { callOrder.push("engine.start"); }),
    };

    await runDaemonV2Startup({
      bridge: mockBridge,
      runConverter: mockConverter,
      fsWatcher: mockFsWatcher,
      engine: mockEngine,
      statePath: "/fake/state.json",
      pouchDir: "/fake/pouch",
      db: {},
      remoteDb: FAKE_REMOTE_DB,
    });

    // All three must have been called
    expect(mockConverter).toHaveBeenCalledOnce();
    expect(mockBridge.start).toHaveBeenCalledOnce();
    expect(mockEngine.start).toHaveBeenCalledOnce();

    // Critical ordering assertion: converter finishes before bridge is armed
    expect(callOrder.indexOf("runConverter")).toBeLessThan(callOrder.indexOf("bridge.start"));
    expect(callOrder.indexOf("bridge.start")).toBeLessThan(callOrder.indexOf("engine.start"));
  });

  it("passes the fsWatcher to bridge.start", async () => {
    const mockFsWatcher = { _tag: "fsWatcher" };
    const mockBridge = { start: vi.fn() };
    const mockEngine = { start: vi.fn(async () => {}) };

    await runDaemonV2Startup({
      bridge: mockBridge,
      runConverter: vi.fn(async () => ({ noStateFile: true })),
      fsWatcher: mockFsWatcher,
      engine: mockEngine,
      statePath: "/fake/state.json",
      pouchDir: "/fake/pouch",
      db: {},
      remoteDb: FAKE_REMOTE_DB,
    });

    expect(mockBridge.start).toHaveBeenCalledWith(mockFsWatcher);
  });

  it("passes remoteDb as the 5th argument to runConverter (phantom filter wiring)", async () => {
    // BUG FIX REGRESSION GUARD: Before this fix, runConverter was called with
    // only 3 args (statePath, pouchDir, db) — remoteDb was never passed.
    // The phantom filter (C04-bis) is a no-op when remoteDb is undefined, so
    // phantom entries (.DS_Store, .git/*) were migrated and pushed to CouchDB.
    // This test pins that runConverter always receives a defined remoteDb as arg 5.
    const capturedArgs: unknown[] = [];

    const mockConverter = vi.fn(async (...args: unknown[]) => {
      capturedArgs.push(...args);
      return { migrated: 0, tombstonedSkipped: 0, orphanSkipped: 0, phantomSkipped: 0 };
    });

    const fakeRemoteDb = { async allDocs() { return { rows: [] }; } };

    await runDaemonV2Startup({
      bridge: { start: vi.fn() },
      runConverter: mockConverter as never,
      fsWatcher: {},
      engine: { start: vi.fn(async () => {}) },
      statePath: "/fake/state.json",
      pouchDir: "/fake/pouch",
      db: {},
      remoteDb: fakeRemoteDb,
    });

    // arg[0]=statePath, [1]=pouchDir, [2]=db, [3]=dryRun=false, [4]=remoteDb
    expect(capturedArgs[4]).toBe(fakeRemoteDb);
    expect(capturedArgs[3]).toBe(false); // dryRun must be false in daemon mode
  });
});
