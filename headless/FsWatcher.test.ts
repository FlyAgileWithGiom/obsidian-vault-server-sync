/**
 * Tests for FsWatcher — headless daemon VaultWatcher implementation.
 *
 * Uses Node environment (default vitest environment for headless/ files).
 * fs.watch is mocked — no real filesystem access.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EventEmitter } from "node:events";

// ---- Mock fs module --------------------------------------------------------
// We mock fs.watch to avoid real OS watcher setup and to drive events manually.

type WatchCallback = (eventType: string, rawFilename: string | Buffer | null) => void;
type ErrorCallback = (error: Error) => void;

interface MockFsWatcher {
  on(event: "change", cb: WatchCallback): this;
  on(event: "error", cb: ErrorCallback): this;
  close(): void;
  _triggerChange(eventType: string, filename: string | null): void;
  _triggerError(err: Error): void;
  closed: boolean;
}

let lastFsWatcher: MockFsWatcher | null = null;

vi.mock("node:fs", () => {
  function makeWatcher(): MockFsWatcher {
    const changeHandlers: WatchCallback[] = [];
    const errorHandlers: ErrorCallback[] = [];
    const watcher: MockFsWatcher = {
      on(event: string, cb: WatchCallback | ErrorCallback) {
        if (event === "change") changeHandlers.push(cb as WatchCallback);
        if (event === "error") errorHandlers.push(cb as ErrorCallback);
        return this;
      },
      close() { this.closed = true; },
      _triggerChange(eventType: string, filename: string | null) {
        for (const h of changeHandlers) h(eventType, filename);
      },
      _triggerError(err: Error) {
        for (const h of errorHandlers) h(err);
      },
      closed: false,
    };
    return watcher;
  }

  return {
    watch: vi.fn((_path: string, _opts: unknown) => {
      const w = makeWatcher();
      lastFsWatcher = w;
      return w;
    }),
    statSync: vi.fn(),
  };
});

// Import statSync and watch to control their behavior in tests
import * as fs from "node:fs";
import { FsWatcher } from "./FsWatcher";
import type { FileEvent } from "../src/WatcherAdapter";

const VAULT_ROOT = "/home/user/vault";
const DEBOUNCE_MS = 100;

// ---- Helper to flush microtasks + debounce --------------------------------
const flushDebounce = async () => {
  await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
};

describe("FsWatcher — basic dispatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    lastFsWatcher = null;
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => false } as fs.Stats);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(fs.statSync).mockReset();
  });

  it("calls fs.watch with recursive:true and the vault root", () => {
    const watcher = new FsWatcher(VAULT_ROOT, []);
    watcher.start(() => {});

    expect(fs.watch).toHaveBeenCalledWith(VAULT_ROOT, { recursive: true, persistent: true });
    watcher.stop();
  });

  it("emits change event for a normal file", async () => {
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => false } as fs.Stats);

    const events: FileEvent[] = [];
    const watcher = new FsWatcher(VAULT_ROOT, []);
    watcher.start((e) => events.push(e));

    lastFsWatcher!._triggerChange("rename", "notes/hello.md");
    await flushDebounce();

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "change", path: "notes/hello.md" });
    watcher.stop();
  });

  it("emits delete event when stat() fails (file gone)", async () => {
    vi.mocked(fs.statSync).mockImplementation(() => { throw new Error("ENOENT"); });

    const events: FileEvent[] = [];
    const watcher = new FsWatcher(VAULT_ROOT, []);
    watcher.start((e) => events.push(e));

    lastFsWatcher!._triggerChange("rename", "notes/gone.md");
    await flushDebounce();

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "delete", path: "notes/gone.md" });
    watcher.stop();
  });

  it("skips directory events (stat.isDirectory() === true)", async () => {
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as fs.Stats);

    const events: FileEvent[] = [];
    const watcher = new FsWatcher(VAULT_ROOT, []);
    watcher.start((e) => events.push(e));

    lastFsWatcher!._triggerChange("rename", "some-folder");
    await flushDebounce();

    expect(events).toHaveLength(0);
    watcher.stop();
  });

  it("suppresses events when filename is null", async () => {
    const events: FileEvent[] = [];
    const watcher = new FsWatcher(VAULT_ROOT, []);
    watcher.start((e) => events.push(e));

    lastFsWatcher!._triggerChange("rename", null);
    await flushDebounce();

    expect(events).toHaveLength(0);
    watcher.stop();
  });
});

describe("FsWatcher — debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    lastFsWatcher = null;
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => false } as fs.Stats);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(fs.statSync).mockReset();
  });

  it("coalesces rapid events on the same path into a single dispatch", async () => {
    const events: FileEvent[] = [];
    const watcher = new FsWatcher(VAULT_ROOT, []);
    watcher.start((e) => events.push(e));

    // Fire 5 rapid events for the same path — only 1 should dispatch
    lastFsWatcher!._triggerChange("rename", "notes/rapid.md");
    lastFsWatcher!._triggerChange("rename", "notes/rapid.md");
    lastFsWatcher!._triggerChange("rename", "notes/rapid.md");
    lastFsWatcher!._triggerChange("rename", "notes/rapid.md");
    lastFsWatcher!._triggerChange("rename", "notes/rapid.md");

    await flushDebounce();

    expect(events).toHaveLength(1);
    watcher.stop();
  });

  it("dispatches separate events for different paths", async () => {
    const events: FileEvent[] = [];
    const watcher = new FsWatcher(VAULT_ROOT, []);
    watcher.start((e) => events.push(e));

    lastFsWatcher!._triggerChange("rename", "a.md");
    lastFsWatcher!._triggerChange("rename", "b.md");
    await flushDebounce();

    expect(events).toHaveLength(2);
    const paths = events.map(e => e.path).sort();
    expect(paths).toEqual(["a.md", "b.md"]);
    watcher.stop();
  });
});

describe("FsWatcher — exclusions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    lastFsWatcher = null;
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => false } as fs.Stats);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(fs.statSync).mockReset();
  });

  it("skips files matching an excluded pattern exactly", async () => {
    const events: FileEvent[] = [];
    const watcher = new FsWatcher(VAULT_ROOT, ["state.json"]);
    watcher.start((e) => events.push(e));

    lastFsWatcher!._triggerChange("rename", "state.json");
    await flushDebounce();

    expect(events).toHaveLength(0);
    watcher.stop();
  });

  it("skips files under an excluded path prefix", async () => {
    const events: FileEvent[] = [];
    const watcher = new FsWatcher(VAULT_ROOT, [".git"]);
    watcher.start((e) => events.push(e));

    lastFsWatcher!._triggerChange("rename", ".git/FETCH_HEAD");
    await flushDebounce();

    expect(events).toHaveLength(0);
    watcher.stop();
  });

  it("does NOT skip files that only partially match an excluded name", async () => {
    const events: FileEvent[] = [];
    const watcher = new FsWatcher(VAULT_ROOT, ["state.json"]);
    watcher.start((e) => events.push(e));

    // "not-state.json" should NOT be excluded
    lastFsWatcher!._triggerChange("rename", "not-state.json");
    await flushDebounce();

    expect(events).toHaveLength(1);
    watcher.stop();
  });

  it("skips a file inside a trailing-slash pattern (.trash/ excludes .trash/foo.md)", async () => {
    const events: FileEvent[] = [];
    // Pattern with trailing slash — as stored in real vault config
    const watcher = new FsWatcher(VAULT_ROOT, [".trash/"]);
    watcher.start((e) => events.push(e));

    lastFsWatcher!._triggerChange("rename", ".trash/foo.md");
    await flushDebounce();

    expect(events).toHaveLength(0);
    watcher.stop();
  });

  it("does NOT skip a sibling folder (.trash/ does not exclude .trasher/note.md)", async () => {
    const events: FileEvent[] = [];
    const watcher = new FsWatcher(VAULT_ROOT, [".trash/"]);
    watcher.start((e) => events.push(e));

    lastFsWatcher!._triggerChange("rename", ".trasher/note.md");
    await flushDebounce();

    expect(events).toHaveLength(1);
    watcher.stop();
  });
});

describe("FsWatcher — stop()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    lastFsWatcher = null;
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => false } as fs.Stats);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(fs.statSync).mockReset();
  });

  it("closes the underlying fs.FSWatcher on stop()", () => {
    const watcher = new FsWatcher(VAULT_ROOT, []);
    watcher.start(() => {});
    const fsWatcher = lastFsWatcher!;

    watcher.stop();

    expect(fsWatcher.closed).toBe(true);
  });

  it("does not dispatch events after stop()", async () => {
    const events: FileEvent[] = [];
    const watcher = new FsWatcher(VAULT_ROOT, []);
    watcher.start((e) => events.push(e));
    const fsWatcher = lastFsWatcher!;

    watcher.stop();

    // Trigger after stop — handler is null, should be ignored
    fsWatcher._triggerChange("rename", "late.md");
    await flushDebounce();

    expect(events).toHaveLength(0);
  });

  it("cancels pending debounce timers on stop()", async () => {
    const events: FileEvent[] = [];
    const watcher = new FsWatcher(VAULT_ROOT, []);
    watcher.start((e) => events.push(e));

    // Trigger a change then stop before debounce fires
    lastFsWatcher!._triggerChange("rename", "pending.md");
    watcher.stop();

    // Advance past debounce — no event should fire
    await flushDebounce();

    expect(events).toHaveLength(0);
  });
});

describe("FsWatcher — macOS spurious self-referential event", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    lastFsWatcher = null;
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => false } as fs.Stats);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(fs.statSync).mockReset();
  });

  it("suppresses event where filename equals vault root basename", async () => {
    // macOS FSEvents fires an event with rawFilename === basename(vaultRoot)
    // when anything changes in the directory. This must be suppressed.
    const vaultRoot = "/home/user/MyVault";
    const events: FileEvent[] = [];
    const watcher = new FsWatcher(vaultRoot, []);
    watcher.start((e) => events.push(e));

    lastFsWatcher!._triggerChange("rename", "MyVault"); // spurious
    await flushDebounce();

    expect(events).toHaveLength(0);
    watcher.stop();
  });
});
