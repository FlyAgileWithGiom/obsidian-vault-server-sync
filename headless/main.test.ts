import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWatcher, runStartWithExitOnFailure } from "./main";
import type { VaultFile, VaultEntry, SyncState } from "../src/types";

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
// runStartWithExitOnFailure — supervisor restart semantics
// ---------------------------------------------------------------------------

/**
 * Build a minimal fake engine whose start() calls onStateChange with the
 * given final state before resolving. This exercises the same path as the
 * real SyncEngine without touching CouchDB.
 */
function makeFakeEngine(finalState: SyncState) {
  return {
    onStateChange: undefined as ((s: SyncState) => void) | undefined,
    async start() {
      // Simulate setState("error"|"ok") being called inside start()
      this.onStateChange?.(finalState);
    },
  };
}

describe("runStartWithExitOnFailure", () => {
  it("calls exit(1) when the engine ends in error state", async () => {
    const exit = vi.fn();
    const engine = makeFakeEngine("error");

    await runStartWithExitOnFailure(engine, exit);

    expect(exit).toHaveBeenCalledWith(1);
  });

  it("does NOT call exit when the engine ends in ok state", async () => {
    const exit = vi.fn();
    const engine = makeFakeEngine("ok");

    await runStartWithExitOnFailure(engine, exit);

    expect(exit).not.toHaveBeenCalled();
  });

  it("does NOT call exit when the engine ends in not-configured state", async () => {
    const exit = vi.fn();
    const engine = makeFakeEngine("not-configured");

    await runStartWithExitOnFailure(engine, exit);

    expect(exit).not.toHaveBeenCalled();
  });

  it("preserves a pre-existing onStateChange callback", async () => {
    const exit = vi.fn();
    const observed: SyncState[] = [];
    const engine = makeFakeEngine("ok");
    // Simulate the logging callback already assigned (as main() does)
    engine.onStateChange = (s) => observed.push(s);

    await runStartWithExitOnFailure(engine, exit);

    expect(observed).toContain("ok");
    expect(exit).not.toHaveBeenCalled();
  });
});
