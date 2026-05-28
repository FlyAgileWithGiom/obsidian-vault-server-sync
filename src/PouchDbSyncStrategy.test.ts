/**
 * Tests for PouchDbSyncStrategy.
 *
 * Uses jsdom environment (configured in vitest.config.ts environmentMatchGlobs).
 * PouchDB and PouchDbFsBridge are mocked — only strategy lifecycle is tested here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Plugin } from "obsidian";
import type { SyncStrategy } from "./sync-strategy";

// ---- Mock pouchdb-browser -----------------------------------------------
// We intercept the PouchDB constructor and replace with an in-memory mock.
// vitest automatically hoists vi.mock() calls to the top of the file.
vi.mock("pouchdb-browser", () => {
  return {
    default: makePouchDBConstructor(),
  };
});

// ---- Mock ObsidianVaultAdapter ------------------------------------------
vi.mock("./ObsidianVaultAdapter", () => ({
  ObsidianVaultAdapter: vi.fn().mockImplementation(() => ({})),
}));

// ---- Mock PouchDbFsBridge ------------------------------------------------
const mockBridgeRegister = vi.fn();
const mockBridgeUnregister = vi.fn();
vi.mock("./PouchDbFsBridge", () => ({
  PouchDbFsBridge: vi.fn().mockImplementation(() => ({
    register: mockBridgeRegister,
    unregister: mockBridgeUnregister,
  })),
}));

// ---- PouchDB mock factory -----------------------------------------------

type SyncEventHandler = (...args: unknown[]) => void;

interface MockSyncHandle {
  cancel: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  _emit(event: string, ...args: unknown[]): void;
}

// Track the most recently created sync handle so tests can inspect/drive it
let lastSyncHandle: MockSyncHandle | null = null;
let lastReplicateHandle: MockSyncHandle | null = null;
// Track PouchDB constructor calls
let pouchConstructorCalls: string[] = [];

function makeMockSyncHandle(): MockSyncHandle {
  const listeners: Map<string, SyncEventHandler[]> = new Map();
  const handle: MockSyncHandle = {
    cancel: vi.fn(),
    on: vi.fn((event: string, handler: SyncEventHandler) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(handler);
      return handle;
    }),
    _emit(event: string, ...args: unknown[]) {
      for (const h of listeners.get(event) ?? []) h(...args);
    },
  };
  return handle;
}

function makePouchDBConstructor() {
  // Returns a constructor function that, when called with `new`, gives a mock DB
  function PouchDBMock(name: string) {
    pouchConstructorCalls.push(name);
  }
  PouchDBMock.prototype.sync = vi.fn((_remote: string, _opts: unknown) => {
    const handle = makeMockSyncHandle();
    lastSyncHandle = handle;
    return handle;
  });
  PouchDBMock.prototype.replicate = {
    from: vi.fn((_remote: string, _opts: unknown) => {
      const handle = makeMockSyncHandle();
      lastReplicateHandle = handle;
      // Immediately emit complete so testConnection resolves
      setTimeout(() => handle._emit("complete"), 0);
      return handle;
    }),
  };
  PouchDBMock.prototype.info = vi.fn().mockResolvedValue({
    db_name: "test",
    doc_count: 0,
    update_seq: 0,
  });
  PouchDBMock.prototype.allDocs = vi.fn().mockResolvedValue({ rows: [], total_rows: 0, offset: 0 });
  return PouchDBMock;
}

// ---- Minimal Plugin mock -------------------------------------------------

interface PluginWithInternals extends Plugin {
  _domHandlers: Map<string, EventListener[]>;
  _triggerDom(event: string): void;
}

function makePlugin(): PluginWithInternals {
  const domHandlers: Map<string, EventListener[]> = new Map();
  const plugin = {
    app: {
      vault: {} as Plugin["app"]["vault"],
    },
    registerEvent: vi.fn(),
    registerDomEvent: vi.fn(
      (
        _target: EventTarget,
        event: string,
        handler: EventListener,
      ) => {
        if (!domHandlers.has(event)) domHandlers.set(event, []);
        domHandlers.get(event)!.push(handler);
      },
    ),
    _domHandlers: domHandlers,
    _triggerDom(event: string) {
      const handlers = domHandlers.get(event) ?? [];
      for (const h of handlers) h(new Event(event));
    },
  } as unknown as PluginWithInternals;
  return plugin;
}

// ---- Import subject under test -------------------------------------------
// Must import AFTER vi.mock() declarations so mocks are in place
import { PouchDbSyncStrategy } from "./PouchDbSyncStrategy";

// ---- Helpers -------------------------------------------------------------

function makeSettings() {
  return {
    couchDbUrl: "https://sync.example.com",
    couchDbName: "test-vault",
    couchDbUser: "alice",
    couchDbPassword: "secret",
    syncDebounceMs: 500,
    excludePatterns: [],
  };
}

function makeApp() {
  return { vault: {} } as unknown as import("obsidian").App;
}

// ---- Tests ---------------------------------------------------------------

describe("PouchDbSyncStrategy — construction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastSyncHandle = null;
    lastReplicateHandle = null;
    pouchConstructorCalls = [];
  });

  it("constructs without error and implements SyncStrategy", () => {
    const strategy: SyncStrategy = new PouchDbSyncStrategy(makeSettings(), makeApp());
    expect(strategy).toBeDefined();
    expect(typeof strategy.register).toBe("function");
    expect(typeof strategy.start).toBe("function");
    expect(typeof strategy.stop).toBe("function");
  });

  it("creates PouchDB with name derived from couchDbName setting", () => {
    new PouchDbSyncStrategy(makeSettings(), makeApp());
    expect(pouchConstructorCalls[0]).toBe("vault-sync-test-vault");
  });

  it("initialises as not running", () => {
    const strategy = new PouchDbSyncStrategy(makeSettings(), makeApp());
    expect(strategy.isRunning()).toBe(false);
  });
});

describe("PouchDbSyncStrategy — register()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastSyncHandle = null;
    pouchConstructorCalls = [];
  });

  it("delegates vault event wiring to bridge.register()", () => {
    const strategy = new PouchDbSyncStrategy(makeSettings(), makeApp());
    const plugin = makePlugin();
    strategy.register(plugin);
    expect(mockBridgeRegister).toHaveBeenCalledWith(plugin);
  });

  it("subscribes to visibilitychange DOM event", () => {
    const strategy = new PouchDbSyncStrategy(makeSettings(), makeApp());
    const plugin = makePlugin();
    strategy.register(plugin);
    expect(plugin.registerDomEvent).toHaveBeenCalledWith(
      document,
      "visibilitychange",
      expect.any(Function),
    );
  });

  it("does not start sync on register alone (sync starts on start())", () => {
    const strategy = new PouchDbSyncStrategy(makeSettings(), makeApp());
    const plugin = makePlugin();
    strategy.register(plugin);
    expect(lastSyncHandle).toBeNull();
  });
});

describe("PouchDbSyncStrategy — start() / stop()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastSyncHandle = null;
    pouchConstructorCalls = [];
  });

  it("start() creates db.sync handle and marks as running", async () => {
    const strategy = new PouchDbSyncStrategy(makeSettings(), makeApp());
    const plugin = makePlugin();
    strategy.register(plugin);

    await strategy.start();

    expect(lastSyncHandle).not.toBeNull();
    expect(strategy.isRunning()).toBe(true);
  });

  it("start() calls onStateChange with 'syncing'", async () => {
    const strategy = new PouchDbSyncStrategy(makeSettings(), makeApp());
    const onStateChange = vi.fn();
    strategy.onStateChange = onStateChange;
    strategy.register(makePlugin());

    await strategy.start();

    expect(onStateChange).toHaveBeenCalledWith("syncing");
  });

  it("stop() cancels the sync handle and marks as not running", async () => {
    const strategy = new PouchDbSyncStrategy(makeSettings(), makeApp());
    strategy.register(makePlugin());
    await strategy.start();

    strategy.stop();

    expect(lastSyncHandle!.cancel).toHaveBeenCalled();
    expect(strategy.isRunning()).toBe(false);
  });

  it("stop() is safe to call when not started (no-op)", () => {
    const strategy = new PouchDbSyncStrategy(makeSettings(), makeApp());
    strategy.register(makePlugin());
    // Never called start()
    expect(() => strategy.stop()).not.toThrow();
  });

  it("stop() calls bridge.unregister() to cancel the PouchDB changes listener", async () => {
    const strategy = new PouchDbSyncStrategy(makeSettings(), makeApp());
    strategy.register(makePlugin());
    await strategy.start();

    strategy.stop();

    expect(mockBridgeUnregister).toHaveBeenCalled();
  });

  it("sync handle uses live=true and retry=true options", async () => {
    const { PouchDbFsBridge: MockBridge } = await import("./PouchDbFsBridge");
    const PouchDB = (await import("pouchdb-browser")).default;
    const syncSpy = vi.spyOn(PouchDB.prototype, "sync");

    const strategy = new PouchDbSyncStrategy(makeSettings(), makeApp());
    strategy.register(makePlugin());
    await strategy.start();

    expect(syncSpy).toHaveBeenCalledWith(expect.any(String), { live: true, retry: true });
    // Cleanup
    strategy.stop();
    syncSpy.mockRestore();
    void MockBridge; // suppress unused warning
  });
});

describe("PouchDbSyncStrategy — visibilitychange handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastSyncHandle = null;
    pouchConstructorCalls = [];
  });

  it("visibility 'visible' after start() cancels old handle and starts new one", async () => {
    const strategy = new PouchDbSyncStrategy(makeSettings(), makeApp());
    const plugin = makePlugin();
    strategy.register(plugin);
    await strategy.start();

    const firstHandle = lastSyncHandle!;

    // Simulate app coming to foreground:
    // set document.visibilityState to "visible" and invoke the registered handler directly
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    plugin._triggerDom("visibilitychange");

    expect(firstHandle.cancel).toHaveBeenCalled();
    expect(lastSyncHandle).not.toBe(firstHandle);
    expect(strategy.isRunning()).toBe(true);

    strategy.stop();
  });

  it("visibility 'visible' before start() is a no-op (started guard)", () => {
    const strategy = new PouchDbSyncStrategy(makeSettings(), makeApp());
    const plugin = makePlugin();
    strategy.register(plugin);
    // NOT started

    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    plugin._triggerDom("visibilitychange");

    expect(lastSyncHandle).toBeNull(); // No sync created
  });

  it("visibility 'hidden' does not cancel sync", async () => {
    const strategy = new PouchDbSyncStrategy(makeSettings(), makeApp());
    const plugin = makePlugin();
    strategy.register(plugin);
    await strategy.start();

    const handle = lastSyncHandle!;

    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    plugin._triggerDom("visibilitychange");

    expect(handle.cancel).not.toHaveBeenCalled();

    strategy.stop();
  });
});

describe("PouchDbSyncStrategy — callbacks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastSyncHandle = null;
    pouchConstructorCalls = [];
  });

  it("sync 'error' event calls onError and onStateChange('error')", async () => {
    const strategy = new PouchDbSyncStrategy(makeSettings(), makeApp());
    const onError = vi.fn();
    const onStateChange = vi.fn();
    strategy.onError = onError;
    strategy.onStateChange = onStateChange;
    strategy.register(makePlugin());
    await strategy.start();

    lastSyncHandle!._emit("error", new Error("network failure"));

    expect(onError).toHaveBeenCalledWith(expect.stringContaining("network failure"));
    expect(onStateChange).toHaveBeenCalledWith("error");
  });

  it("sync 'complete' event calls onStateChange('ok')", async () => {
    const strategy = new PouchDbSyncStrategy(makeSettings(), makeApp());
    const onStateChange = vi.fn();
    strategy.onStateChange = onStateChange;
    strategy.register(makePlugin());
    await strategy.start();

    lastSyncHandle!._emit("complete");

    expect(onStateChange).toHaveBeenCalledWith("ok");
  });
});

describe("PouchDbSyncStrategy — getDiagnostics()", () => {
  it("returns a valid SyncDiagnostics object when not running", () => {
    const strategy = new PouchDbSyncStrategy(makeSettings(), makeApp());
    const diag = strategy.getDiagnostics();
    expect(diag.running).toBe(false);
    expect(diag.state).toBe("idle");
    expect(diag.lastError).toBeNull();
  });
});

describe("PouchDbSyncStrategy — forceFullSync() / planFullSync()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastSyncHandle = null;
    lastReplicateHandle = null;
    pouchConstructorCalls = [];
  });

  it("forceFullSync() resolves (does not throw)", async () => {
    const strategy = new PouchDbSyncStrategy(makeSettings(), makeApp());
    strategy.register(makePlugin());
    // forceFullSync should resolve, not reject
    await expect(strategy.forceFullSync()).resolves.toBeUndefined();
  });

  it("forceFullSync() calls db.replicate.from with live:false", async () => {
    const PouchDB = (await import("pouchdb-browser")).default;
    const replicateSpy = vi.spyOn(PouchDB.prototype.replicate, "from");

    const strategy = new PouchDbSyncStrategy(makeSettings(), makeApp());
    strategy.register(makePlugin());
    await strategy.forceFullSync();

    expect(replicateSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ live: false }),
    );
    replicateSpy.mockRestore();
  });

  it("forceFullSync() starts live sync after initial pull completes", async () => {
    const PouchDB = (await import("pouchdb-browser")).default;
    const syncSpy = vi.spyOn(PouchDB.prototype, "sync");

    const strategy = new PouchDbSyncStrategy(makeSettings(), makeApp());
    strategy.register(makePlugin());
    await strategy.forceFullSync();

    // After replicate.from 'complete', should have started live sync
    expect(syncSpy).toHaveBeenCalledWith(
      expect.any(String),
      { live: true, retry: true },
    );
    syncSpy.mockRestore();
  });

  it("planFullSync() resolves with a valid FullSyncPlan object", async () => {
    const strategy = new PouchDbSyncStrategy(makeSettings(), makeApp());
    const plan = await strategy.planFullSync();
    expect(plan).toBeDefined();
    expect(plan.wouldPushNew).toBeDefined();
    expect(plan.wouldPushNew.count).toBeGreaterThanOrEqual(0);
    expect(plan.wouldDeleteLocalTombstoned).toBeDefined();
    expect(plan.alreadyTombstoned).toBeDefined();
    expect(plan.excludedCount).toBeDefined();
  });

  it("planFullSync() returns doc_count from db.info() in wouldPushNew.count", async () => {
    const PouchDB = (await import("pouchdb-browser")).default;
    vi.spyOn(PouchDB.prototype, "info").mockResolvedValueOnce({
      db_name: "test",
      doc_count: 42,
      update_seq: 0,
    });

    const strategy = new PouchDbSyncStrategy(makeSettings(), makeApp());
    const plan = await strategy.planFullSync();
    expect(plan.wouldPushNew.count).toBe(42);
  });
});

describe("PouchDbSyncStrategy — remote URL construction", () => {
  it("includes credentials in URL when set", async () => {
    const { PouchDbFsBridge: MockBridge } = await import("./PouchDbFsBridge");
    const PouchDB = (await import("pouchdb-browser")).default;
    const syncSpy = vi.spyOn(PouchDB.prototype, "sync");

    const strategy = new PouchDbSyncStrategy({
      couchDbUrl: "https://sync.example.com",
      couchDbName: "my-vault",
      couchDbUser: "alice",
      couchDbPassword: "s3cr3t",
      syncDebounceMs: 500,
      excludePatterns: [],
    }, makeApp());
    strategy.register(makePlugin());
    await strategy.start();

    expect(syncSpy).toHaveBeenCalledWith(
      "https://alice:s3cr3t@sync.example.com/my-vault",
      expect.anything(),
    );

    strategy.stop();
    syncSpy.mockRestore();
    void MockBridge;
  });

  it("works without credentials", async () => {
    const { PouchDbFsBridge: MockBridge } = await import("./PouchDbFsBridge");
    const PouchDB = (await import("pouchdb-browser")).default;
    const syncSpy = vi.spyOn(PouchDB.prototype, "sync");

    const strategy = new PouchDbSyncStrategy({
      couchDbUrl: "http://localhost:5984",
      couchDbName: "test",
      couchDbUser: "",
      couchDbPassword: "",
      syncDebounceMs: 500,
      excludePatterns: [],
    }, makeApp());
    strategy.register(makePlugin());
    await strategy.start();

    expect(syncSpy).toHaveBeenCalledWith("http://localhost:5984/test", expect.anything());

    strategy.stop();
    syncSpy.mockRestore();
    void MockBridge;
  });
});
