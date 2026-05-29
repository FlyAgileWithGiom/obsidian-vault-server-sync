/**
 * Tests for PouchDbSyncEngine.
 *
 * Uses jsdom environment (configured in vitest.config.ts environmentMatchGlobs).
 * PouchDB and PouchDbFsBridge are injected as mocks — only engine lifecycle is
 * tested here.
 *
 * Unlike PouchDbSyncStrategy.test.ts, PouchDbSyncEngine accepts (settings, db, bridge)
 * directly. This makes tests simpler: no module-level mock for pouchdb-browser needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Plugin } from "obsidian";
import { PouchDbSyncEngine } from "./PouchDbSyncEngine";
import type { VaultSyncSettings } from "./types";

// ---- Minimal Plugin mock -------------------------------------------------

interface PluginWithInternals extends Plugin {
  _domHandlers: Map<string, EventListener[]>;
  _triggerDom(event: string): void;
}

function makePlugin(): PluginWithInternals {
  const domHandlers: Map<string, EventListener[]> = new Map();
  const plugin = {
    app: { vault: {} as Plugin["app"]["vault"] },
    registerEvent: vi.fn(),
    registerDomEvent: vi.fn((_target: EventTarget, event: string, handler: EventListener) => {
      if (!domHandlers.has(event)) domHandlers.set(event, []);
      domHandlers.get(event)!.push(handler);
    }),
    _domHandlers: domHandlers,
    _triggerDom(event: string) {
      for (const h of domHandlers.get(event) ?? []) h(new Event(event));
    },
  } as unknown as PluginWithInternals;
  return plugin;
}

// ---- PouchDB mock factory -----------------------------------------------

type SyncEventHandler = (...args: unknown[]) => void;

interface MockSyncHandle {
  cancel: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  _emit(event: string, ...args: unknown[]): void;
}

let lastSyncHandle: MockSyncHandle | null = null;
let lastReplicateHandle: MockSyncHandle | null = null;

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

function makeMockDb(docCount = 0) {
  return {
    sync: vi.fn((_remote: string, _opts: unknown) => {
      const handle = makeMockSyncHandle();
      lastSyncHandle = handle;
      return handle;
    }),
    replicate: {
      from: vi.fn((_remote: string, _opts: unknown) => {
        const handle = makeMockSyncHandle();
        lastReplicateHandle = handle;
        setTimeout(() => handle._emit("complete"), 0);
        return handle;
      }),
    },
    info: vi.fn().mockResolvedValue({ db_name: "test", doc_count: docCount, update_seq: 0 }),
    allDocs: vi.fn().mockResolvedValue({ rows: [], total_rows: 0, offset: 0 }),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockBridge() {
  return { start: vi.fn(), stop: vi.fn(), setDb: vi.fn() };
}

function makeSettings(): VaultSyncSettings {
  return {
    couchDbUrl: "https://sync.example.com",
    couchDbName: "test-vault",
    couchDbUser: "alice",
    couchDbPassword: "secret",
    syncDebounceMs: 500,
    excludePatterns: [],
  };
}

function makeEngine(opts: { docCount?: number } = {}) {
  const db = makeMockDb(opts.docCount ?? 0);
  const bridge = makeMockBridge();
  // dbFactory returns the same mock db so destroy+recreate keeps assertions on same object.
  const dbFactory = () => db as unknown as Parameters<typeof PouchDbSyncEngine>[1];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const engine = new PouchDbSyncEngine(makeSettings(), db as any, bridge as any, dbFactory as any);
  return { engine, db, bridge };
}

// ---- Tests ---------------------------------------------------------------

describe("PouchDbSyncEngine — construction", () => {
  beforeEach(() => { lastSyncHandle = null; lastReplicateHandle = null; });

  it("constructs without error", () => {
    const { engine } = makeEngine();
    expect(engine).toBeDefined();
    expect(typeof engine.register).toBe("function");
    expect(typeof engine.start).toBe("function");
    expect(typeof engine.stop).toBe("function");
  });

  it("initialises as not running", () => {
    expect(makeEngine().engine.isRunning()).toBe(false);
  });
});

describe("PouchDbSyncEngine — register()", () => {
  beforeEach(() => { lastSyncHandle = null; });

  it("delegates vault event wiring to bridge.start() via ObsidianVaultWatcher", () => {
    const { engine, bridge } = makeEngine();
    engine.register(makePlugin());
    expect(bridge.start).toHaveBeenCalledWith(expect.objectContaining({ start: expect.any(Function) }));
  });

  it("subscribes to visibilitychange DOM event", () => {
    const { engine } = makeEngine();
    const plugin = makePlugin();
    engine.register(plugin);
    expect(plugin.registerDomEvent).toHaveBeenCalledWith(document, "visibilitychange", expect.any(Function));
  });

  it("does not start sync on register alone", () => {
    const { engine } = makeEngine();
    engine.register(makePlugin());
    expect(lastSyncHandle).toBeNull();
  });
});

describe("PouchDbSyncEngine — start() / stop()", () => {
  beforeEach(() => { lastSyncHandle = null; });

  it("start() creates db.sync handle and marks as running", async () => {
    const { engine } = makeEngine();
    engine.register(makePlugin());
    await engine.start();
    expect(lastSyncHandle).not.toBeNull();
    expect(engine.isRunning()).toBe(true);
  });

  it("start() calls onStateChange with 'syncing'", async () => {
    const { engine } = makeEngine();
    const onStateChange = vi.fn();
    engine.onStateChange = onStateChange;
    engine.register(makePlugin());
    await engine.start();
    expect(onStateChange).toHaveBeenCalledWith("syncing");
  });

  it("stop() cancels the sync handle and marks as not running", async () => {
    const { engine } = makeEngine();
    engine.register(makePlugin());
    await engine.start();
    engine.stop();
    expect(lastSyncHandle!.cancel).toHaveBeenCalled();
    expect(engine.isRunning()).toBe(false);
  });

  it("stop() is safe to call when not started (no-op)", () => {
    const { engine } = makeEngine();
    engine.register(makePlugin());
    expect(() => engine.stop()).not.toThrow();
  });

  it("stop() calls bridge.stop()", async () => {
    const { engine, bridge } = makeEngine();
    engine.register(makePlugin());
    await engine.start();
    engine.stop();
    expect(bridge.stop).toHaveBeenCalled();
  });

  it("sync handle uses live=true and retry=true options", async () => {
    const { engine, db } = makeEngine();
    engine.register(makePlugin());
    await engine.start();
    expect(db.sync).toHaveBeenCalledWith(expect.any(String), { live: true, retry: true });
    engine.stop();
  });
});

describe("PouchDbSyncEngine — visibilitychange handler", () => {
  beforeEach(() => { lastSyncHandle = null; });

  afterEach(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  it("visibility 'visible' after start() cancels old handle and starts new one", async () => {
    const { engine } = makeEngine();
    const plugin = makePlugin();
    engine.register(plugin);
    await engine.start();
    const firstHandle = lastSyncHandle!;
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    plugin._triggerDom("visibilitychange");
    expect(firstHandle.cancel).toHaveBeenCalled();
    expect(lastSyncHandle).not.toBe(firstHandle);
    engine.stop();
  });

  it("visibility 'visible' before start() is a no-op (started guard)", () => {
    const { engine } = makeEngine();
    const plugin = makePlugin();
    engine.register(plugin);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    plugin._triggerDom("visibilitychange");
    expect(lastSyncHandle).toBeNull();
  });

  it("visibility 'hidden' does not cancel sync", async () => {
    const { engine } = makeEngine();
    const plugin = makePlugin();
    engine.register(plugin);
    await engine.start();
    const handle = lastSyncHandle!;
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    plugin._triggerDom("visibilitychange");
    expect(handle.cancel).not.toHaveBeenCalled();
    engine.stop();
  });
});

describe("PouchDbSyncEngine — callbacks", () => {
  beforeEach(() => { lastSyncHandle = null; });

  it("sync 'error' event calls onError and onStateChange('error')", async () => {
    const { engine } = makeEngine();
    const onError = vi.fn();
    const onStateChange = vi.fn();
    engine.onError = onError;
    engine.onStateChange = onStateChange;
    engine.register(makePlugin());
    await engine.start();
    lastSyncHandle!._emit("error", new Error("network failure"));
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("network failure"));
    expect(onStateChange).toHaveBeenCalledWith("error");
  });

  it("sync 'complete' event calls onStateChange('ok')", async () => {
    const { engine } = makeEngine();
    const onStateChange = vi.fn();
    engine.onStateChange = onStateChange;
    engine.register(makePlugin());
    await engine.start();
    lastSyncHandle!._emit("complete");
    expect(onStateChange).toHaveBeenCalledWith("ok");
  });
});

describe("PouchDbSyncEngine — getDiagnostics()", () => {
  it("returns a valid SyncDiagnostics object when not running", () => {
    const { engine } = makeEngine();
    const diag = engine.getDiagnostics();
    expect(diag.running).toBe(false);
    expect(diag.state).toBe("idle");
    expect(diag.lastError).toBeNull();
  });

  it("populates the four formerly-missing timing fields as null/0 (no NaN)", () => {
    // These belonged to the retired PouchDbSyncStrategy; getDiagnostics() omitted them,
    // violating SyncDiagnostics. They must be present and never NaN.
    const diag = makeEngine().engine.getDiagnostics();
    expect(diag.avgFetchMs).toBeNull();
    expect(diag.fetchSampleCount).toBe(0);
    expect(diag.avgApplyMs).toBeNull();
    expect(diag.applySampleCount).toBe(0);
  });

  it("reports syncPhase 'idle' and binaryProgress null before any pull", () => {
    const diag = makeEngine().engine.getDiagnostics();
    expect(diag.syncPhase).toBe("idle");
    expect(diag.binaryProgress).toBeNull();
  });

  it("reports syncPhase 'binary-backfill' after phase-1 completes (state still 'syncing')", async () => {
    const { engine } = makeEngine({ docCount: 0 });
    engine.register(makePlugin());
    await engine.start();
    // Phase-1 (mock replicate.from auto-completes) goes text-ready, then startLiveSync()
    // moves the phase to binary-backfill (the live db.sync backlog). State stays "syncing"
    // until a caught-up pause — never "ok" while binaries are still pending.
    const diag = engine.getDiagnostics();
    expect(diag.syncPhase).toBe("binary-backfill");
    expect(diag.state).toBe("syncing");
    engine.stop();
  });

  it("reports syncPhase 'complete' and binaryProgress null after a caught-up pause", async () => {
    const { engine } = makeEngine({ docCount: 0 });
    engine.register(makePlugin());
    await engine.start();
    lastSyncHandle!._emit("change", { docs_written: 6750, pending: 0 });
    lastSyncHandle!._emit("paused");
    const diag = engine.getDiagnostics();
    expect(diag.syncPhase).toBe("complete");
    expect(diag.state).toBe("ok");
    expect(diag.binaryProgress).toBeNull();
    engine.stop();
  });
});

describe("PouchDbSyncEngine — forceFullSync() / planFullSync()", () => {
  beforeEach(() => { lastSyncHandle = null; lastReplicateHandle = null; });

  it("forceFullSync() resolves (does not throw)", async () => {
    const { engine } = makeEngine();
    engine.register(makePlugin());
    await expect(engine.forceFullSync()).resolves.toBeUndefined();
  });

  it("forceFullSync() calls db.replicate.from with live:false", async () => {
    const { engine, db } = makeEngine();
    engine.register(makePlugin());
    await engine.forceFullSync();
    expect(db.replicate.from).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ live: false }));
  });

  it("forceFullSync() starts live sync after initial pull completes", async () => {
    const { engine, db } = makeEngine();
    engine.register(makePlugin());
    await engine.forceFullSync();
    expect(db.sync).toHaveBeenCalledWith(expect.any(String), { live: true, retry: true });
  });

  it("planFullSync() resolves with a valid FullSyncPlan", async () => {
    const { engine } = makeEngine();
    const plan = await engine.planFullSync();
    expect(plan.wouldPushNew).toBeDefined();
    expect(plan.wouldDeleteLocalTombstoned).toBeDefined();
    expect(plan.excludedCount).toBeDefined();
  });

  it("planFullSync() uses db.info() doc_count for wouldPushNew.count", async () => {
    const db = makeMockDb(42);
    const bridge = makeMockBridge();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine = new PouchDbSyncEngine(makeSettings(), db as any, bridge as any);
    const plan = await engine.planFullSync();
    expect(plan.wouldPushNew.count).toBe(42);
  });
});

describe("PouchDbSyncEngine — remote URL construction", () => {
  beforeEach(() => { lastSyncHandle = null; });

  it("includes credentials in URL when set", async () => {
    const db = makeMockDb(5);
    const bridge = makeMockBridge();
    const engine = new PouchDbSyncEngine(
      { couchDbUrl: "https://sync.example.com", couchDbName: "my-vault", couchDbUser: "alice", couchDbPassword: "s3cr3t", syncDebounceMs: 500, excludePatterns: [] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any, bridge as any,
    );
    engine.register(makePlugin());
    await engine.start();
    expect(db.sync).toHaveBeenCalledWith("https://alice:s3cr3t@sync.example.com/my-vault", expect.anything());
    engine.stop();
  });

  it("works without credentials", async () => {
    const db = makeMockDb(5);
    const bridge = makeMockBridge();
    const engine = new PouchDbSyncEngine(
      { couchDbUrl: "http://localhost:5984", couchDbName: "test", couchDbUser: "", couchDbPassword: "", syncDebounceMs: 500, excludePatterns: [] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any, bridge as any,
    );
    engine.register(makePlugin());
    await engine.start();
    expect(db.sync).toHaveBeenCalledWith("http://localhost:5984/test", expect.anything());
    engine.stop();
  });
});

describe("PouchDbSyncEngine — isFirstRun() branching", () => {
  beforeEach(() => { lastSyncHandle = null; lastReplicateHandle = null; });

  it("start() with doc_count=0 runs replicate.from before startLiveSync", async () => {
    const { engine, db } = makeEngine({ docCount: 0 });
    engine.register(makePlugin());
    await engine.start();
    expect(db.replicate.from).toHaveBeenCalled();
    expect(db.sync).toHaveBeenCalled();
    expect(
      (db.replicate.from as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    ).toBeLessThan(
      (db.sync as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    );
    engine.stop();
  });

  it("start() with doc_count>0 skips replicate.from and goes directly to live sync", async () => {
    const { engine, db } = makeEngine({ docCount: 5 });
    engine.register(makePlugin());
    await engine.start();
    expect(db.replicate.from).not.toHaveBeenCalled();
    expect(db.sync).toHaveBeenCalled();
    engine.stop();
  });

  it("phase-1 pull uses the text selector and checkpoint:'target'", async () => {
    const { engine, db } = makeEngine({ docCount: 0 });
    engine.register(makePlugin());
    await engine.start();
    expect(db.replicate.from).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        live: false,
        selector: { _attachments: { $exists: false } },
        checkpoint: "target",
      }),
    );
    engine.stop();
  });

  it("after phase-1 completes, state stays 'syncing' (not 'ok') — binaries still pending", async () => {
    const onStateChange = vi.fn();
    const { engine } = makeEngine({ docCount: 0 });
    engine.onStateChange = onStateChange;
    engine.register(makePlugin());
    await engine.start();
    // Phase-1 (mock replicate.from auto-completes) starts live sync but must NOT set 'ok':
    // doing so would render "Synced" while the binary backfill has not happened.
    expect(onStateChange).not.toHaveBeenCalledWith("ok");
    expect(onStateChange).toHaveBeenCalledWith("syncing");
    engine.stop();
  });

  it("live sync reaches 'ok' only on a caught-up pause (pending === 0)", async () => {
    const onStateChange = vi.fn();
    const { engine } = makeEngine({ docCount: 0 });
    engine.onStateChange = onStateChange;
    engine.register(makePlugin());
    await engine.start();
    // The live db.sync handle drives completion. A change with pending>0 then a pause is
    // an error-backoff pause — must NOT complete.
    lastSyncHandle!._emit("change", { docs_written: 10, pending: 42 });
    lastSyncHandle!._emit("paused");
    expect(onStateChange).not.toHaveBeenCalledWith("ok");
    // Feed drains (pending 0) then pauses → genuinely caught up → 'ok'.
    lastSyncHandle!._emit("change", { docs_written: 6750, pending: 0 });
    lastSyncHandle!._emit("paused");
    expect(onStateChange).toHaveBeenCalledWith("ok");
    engine.stop();
  });

  it("fires a one-shot 'Notes ready' notice at the text-ready transition", async () => {
    const notices: string[] = [];
    const { engine } = makeEngine({ docCount: 0 });
    engine.onNotice = (msg: string) => notices.push(msg);
    engine.register(makePlugin());
    await engine.start();
    // Phase-1 completion is the "notes usable" moment — the user-visible win.
    const readyNotices = notices.filter((m) => /notes ready/i.test(m));
    expect(readyNotices).toHaveLength(1);
    engine.stop();
  });
});

describe("PouchDbSyncEngine — cleanupLegacyRevMap()", () => {
  beforeEach(() => { lastSyncHandle = null; lastReplicateHandle = null; });

  it("calls localStorage.removeItem for legacy keys after initial pull", async () => {
    const removedKeys: string[] = [];
    const originalLS = global.localStorage;
    Object.defineProperty(global, "localStorage", {
      value: { removeItem: (key: string) => { removedKeys.push(key); }, getItem: () => null, setItem: () => {}, clear: () => {} },
      configurable: true, writable: true,
    });
    const { engine } = makeEngine({ docCount: 0 });
    engine.register(makePlugin());
    await engine.start();
    expect(removedKeys).toContain("vault-sync-revmap");
    expect(removedKeys).toContain("vault-sync-last-seq");
    Object.defineProperty(global, "localStorage", { value: originalLS, configurable: true, writable: true });
    engine.stop();
  });

  it("does NOT call removeItem when doc_count > 0 (no migration)", async () => {
    const removedKeys: string[] = [];
    const originalLS = global.localStorage;
    Object.defineProperty(global, "localStorage", {
      value: { removeItem: (key: string) => { removedKeys.push(key); }, getItem: () => null, setItem: () => {}, clear: () => {} },
      configurable: true, writable: true,
    });
    const { engine } = makeEngine({ docCount: 10 });
    engine.register(makePlugin());
    await engine.start();
    expect(removedKeys).not.toContain("vault-sync-revmap");
    Object.defineProperty(global, "localStorage", { value: originalLS, configurable: true, writable: true });
    engine.stop();
  });
});

describe("PouchDbSyncEngine — replaceLocalFromServer()", () => {
  beforeEach(() => { lastSyncHandle = null; lastReplicateHandle = null; });

  it("calls db.destroy() then runs initial pull (replicate.from)", async () => {
    const { engine, db } = makeEngine({ docCount: 5 });
    engine.register(makePlugin());
    await engine.replaceLocalFromServer();
    expect(db.destroy).toHaveBeenCalled();
    expect(db.replicate.from).toHaveBeenCalled();
    expect(
      (db.destroy as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    ).toBeLessThan(
      (db.replicate.from as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    );
  });

  it("resolves even when db.destroy() rejects (non-fatal)", async () => {
    const db = makeMockDb(5);
    (db.destroy as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("destroy failed"));
    const bridge = makeMockBridge();
    const dbFactory = () => db as unknown as Parameters<typeof PouchDbSyncEngine>[1];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine = new PouchDbSyncEngine(makeSettings(), db as any, bridge as any, dbFactory as any);
    engine.register(makePlugin());
    await expect(engine.replaceLocalFromServer()).resolves.toBeUndefined();
    expect(db.replicate.from).toHaveBeenCalled();
  });

  it("throws clearly when dbFactory is absent", async () => {
    const db = makeMockDb(5);
    const bridge = makeMockBridge();
    // No factory passed — replaceLocalFromServer must throw before touching the db.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine = new PouchDbSyncEngine(makeSettings(), db as any, bridge as any);
    await expect(engine.replaceLocalFromServer()).rejects.toThrow("dbFactory");
    expect(db.destroy).not.toHaveBeenCalled();
  });

  it("calls bridge.setDb() with the new db after recreating", async () => {
    const { engine, db, bridge } = makeEngine({ docCount: 5 });
    engine.register(makePlugin());
    await engine.replaceLocalFromServer();
    expect(bridge.setDb).toHaveBeenCalledWith(db);
    expect(bridge.setDb).toHaveBeenCalledBefore
      ? expect(bridge.setDb.mock.invocationCallOrder[0]).toBeLessThan(
          (db.replicate.from as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
        )
      : undefined; // Invocation order check
  });
});
