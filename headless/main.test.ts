import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createWatcher, resolveStatePath, migrateStateFile } from "./main";
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
