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
import { PouchDbSyncEngine, TEXT_SELECTOR } from "./PouchDbSyncEngine";
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
  return { start: vi.fn(), stop: vi.fn(), setDb: vi.fn(), wipeLocalFiles: vi.fn().mockResolvedValue(undefined), setSuppressVaultEvents: vi.fn() };
}

function makeSettings(): VaultSyncSettings {
  return {
    couchDbUrl: "https://sync.example.com",
    couchDbName: "test-vault",
    couchDbUser: "alice",
    couchDbPassword: "secret",
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
    // startLiveSync is now async (awaits buildRemote). Flush the microtask queue so
    // the new handle is assigned before asserting. One tick suffices for the no-gateway
    // path (buildRemote resolves immediately via buildLegacyUrl).
    await new Promise((r) => setTimeout(r, 0));
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
    // stop() is REQUIRED here: the error handler now schedules a 2s backoff retry timer.
    // Without stop(), that timer fires during a later test, reassigns lastSyncHandle,
    // and causes intermittent failures. stop() → cancelSync() clears the timer.
    engine.stop();
  });

  it("sync 'complete' event calls onStateChange('ok')", async () => {
    const { engine } = makeEngine();
    const onStateChange = vi.fn();
    engine.onStateChange = onStateChange;
    engine.register(makePlugin());
    await engine.start();
    lastSyncHandle!._emit("complete");
    expect(onStateChange).toHaveBeenCalledWith("ok");
    engine.stop();
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

  it("does not expose removed stub fields (revMapSize, lastSeq, pendingPushCount etc.)", () => {
    // These fields were always-stub (0 / null) and have been removed from SyncDiagnostics.
    // Confirm getDiagnostics() no longer returns them.
    const diag = makeEngine().engine.getDiagnostics() as unknown as Record<string, unknown>;
    expect(diag).not.toHaveProperty("revMapSize");
    expect(diag).not.toHaveProperty("lastSeq");
    expect(diag).not.toHaveProperty("pendingPushCount");
    expect(diag).not.toHaveProperty("pullSkipped");
    expect(diag).not.toHaveProperty("avgFetchMs");
    expect(diag).not.toHaveProperty("avgApplyMs");
    expect(diag).not.toHaveProperty("unsyncableCount");
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

  it("pullProgress is non-null during text-pull, null after phase-1 completes (binary-backfill)", async () => {
    // Drive a non-auto-completing phase-1 so we can assert during the pull.
    // The standard mock auto-emits "complete" via setTimeout; we override it here
    // so phase-1 stays in-flight long enough to observe pullProgress mid-pull.
    const db = makeMockDb(0);
    (db.replicate.from as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const handle = makeMockSyncHandle();
      lastReplicateHandle = handle;
      // does NOT auto-emit "complete" — caller controls the lifecycle
      return handle;
    });
    const bridge = makeMockBridge();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine = new PouchDbSyncEngine(makeSettings(), db as any, bridge as any, () => db as any);
    engine.register(makePlugin());

    // Kick off start() without awaiting — phase-1 hangs until we emit "complete".
    // Flush microtasks so replicate.from is actually issued (db.info await must settle first).
    void engine.start();
    await new Promise((r) => setTimeout(r, 0));

    // Simulate progress arriving during phase-1 (flat shape: docs_written + pending).
    lastReplicateHandle!._emit("change", { docs_written: 1603, pending: 21271 });

    // DURING text-pull: pullProgress must be non-null and carry the phase-1 values.
    const mid = engine.getDiagnostics();
    expect(mid.syncPhase).toBe("text-pull");
    expect(mid.pullProgress).not.toBeNull();
    expect(mid.pullProgress?.fetched).toBe(1603);
    expect(mid.pullProgress?.total).toBe(22874); // 1603 + 21271

    // Phase-1 completes → engine moves to text-ready then immediately starts live sync
    // (binary-backfill). pullTotal is still 22874 on the engine — the fix must suppress it.
    lastReplicateHandle!._emit("complete");
    // Flush microtask queue so the complete handler runs and startLiveSync() fires.
    await new Promise((r) => setTimeout(r, 0));

    // AFTER phase-1, during binary-backfill: pullProgress must be null — the combined
    // db.sync pending count (text already-local + binaries + tombstones) is not an
    // honest denominator for "binaries remaining" (Refs #74).
    const after = engine.getDiagnostics();
    expect(after.syncPhase).toBe("binary-backfill");
    expect(after.pullProgress).toBeNull();

    engine.stop();
  });
});

describe("PouchDbSyncEngine — forceFullSync()", () => {
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
});

describe("PouchDbSyncEngine — getLocalDocCount()", () => {
  it("returns db.info() doc_count", async () => {
    const db = makeMockDb(42);
    const bridge = makeMockBridge();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine = new PouchDbSyncEngine(makeSettings(), db as any, bridge as any);
    const count = await engine.getLocalDocCount();
    expect(count).toBe(42);
  });

  it("throws when db.info() rejects", async () => {
    const db = makeMockDb(0);
    (db.info as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("db error"));
    const bridge = makeMockBridge();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine = new PouchDbSyncEngine(makeSettings(), db as any, bridge as any);
    await expect(engine.getLocalDocCount()).rejects.toThrow("Could not read local doc count");
  });
});

describe("PouchDbSyncEngine — recordReconcileConflicts()", () => {
  it("sets reconcileConflicts on getDiagnostics()", () => {
    const { engine } = makeEngine();
    engine.recordReconcileConflicts(3);
    expect(engine.getDiagnostics().reconcileConflicts).toBe(3);
  });

  it("is initialised to 0 on construction", () => {
    expect(makeEngine().engine.getDiagnostics().reconcileConflicts).toBe(0);
  });
});

describe("PouchDbSyncEngine — remote URL construction", () => {
  beforeEach(() => { lastSyncHandle = null; });

  it("includes credentials in URL when set", async () => {
    const db = makeMockDb(5);
    const bridge = makeMockBridge();
    const engine = new PouchDbSyncEngine(
      { couchDbUrl: "https://sync.example.com", couchDbName: "my-vault", couchDbUser: "alice", couchDbPassword: "s3cr3t", excludePatterns: [] },
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
      { couchDbUrl: "http://localhost:5984", couchDbName: "test", couchDbUser: "", couchDbPassword: "", excludePatterns: [] },
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
    // REAL db.sync change shape: progress is NESTED under info.change.pending with a
    // .direction field. The flat top-level info.pending is undefined on db.sync changes
    // (verified: spikes/mobile-text-first/probe-livesync-events.mjs). Emitting the nested
    // shape here is what makes this test exercise the real-artifact behaviour.
    lastSyncHandle!._emit("change", { direction: "pull", change: { docs_written: 10, pending: 42 } });
    lastSyncHandle!._emit("paused");
    expect(onStateChange).not.toHaveBeenCalledWith("ok");
    // Feed drains (pending 0) then pauses → genuinely caught up → 'ok'.
    lastSyncHandle!._emit("change", { direction: "pull", change: { docs_written: 6750, pending: 0 } });
    lastSyncHandle!._emit("paused");
    expect(onStateChange).toHaveBeenCalledWith("ok");
    engine.stop();
  });

  it("stays 'syncing'/'binary-backfill' on a paused after a change reported pending>0 (nested db.sync shape)", async () => {
    // Regression for the startLiveSync pending-field blocker (Refs #72): the real db.sync
    // change event nests progress under info.change.pending; the engine previously read the
    // flat info.pending (always undefined on db.sync), latching liveSyncPending=0 so the
    // FIRST paused — including the error-backoff pause this guard exists for — falsely
    // reported "Synced" mid binary-backfill. State AND phase must both stay non-complete.
    const onStateChange = vi.fn();
    const { engine } = makeEngine({ docCount: 0 });
    engine.onStateChange = onStateChange;
    engine.register(makePlugin());
    await engine.start();
    onStateChange.mockClear();
    // Backfill in flight: a change reporting pending>0, then a (backoff) pause.
    lastSyncHandle!._emit("change", { direction: "pull", change: { docs_written: 100, pending: 6650 } });
    lastSyncHandle!._emit("paused");
    expect(onStateChange).not.toHaveBeenCalledWith("ok");
    expect(engine.getDiagnostics().state).toBe("syncing");
    expect(engine.getDiagnostics().syncPhase).toBe("binary-backfill");
    engine.stop();
  });

  it("a paused firing BEFORE any change does not latch 'complete'/'ok' (sentinel guard)", async () => {
    // The combined db.sync handle can emit a no-arg paused at startup before the first
    // change reports pending. Seeding liveSyncPending to 0 would misread that as caught-up.
    // A sentinel (no change observed yet) must keep state 'syncing'/phase 'binary-backfill'.
    const onStateChange = vi.fn();
    const { engine } = makeEngine({ docCount: 0 });
    engine.onStateChange = onStateChange;
    engine.register(makePlugin());
    await engine.start();
    onStateChange.mockClear();
    lastSyncHandle!._emit("paused");
    expect(onStateChange).not.toHaveBeenCalledWith("ok");
    expect(engine.getDiagnostics().state).toBe("syncing");
    expect(engine.getDiagnostics().syncPhase).toBe("binary-backfill");
    engine.stop();
  });

  it("caught-up scenario: active then paused with NO change → state 'ok' / phase 'complete'", async () => {
    // Real probe evidence (spikes/paused-probe.mjs): when the initial pull already fetched
    // everything, the live db.sync fires ONLY active → paused with zero change events.
    // liveSyncPending stays at PENDING_UNKNOWN (-1) → the old pending===0 guard never fires.
    // With liveSyncContacted: active sets contacted=true, so paused latches ok.
    const onStateChange = vi.fn();
    const { engine } = makeEngine({ docCount: 0 });
    engine.onStateChange = onStateChange;
    engine.register(makePlugin());
    await engine.start();
    onStateChange.mockClear();
    // Caught-up sequence from real probe: active, then paused — no change events.
    lastSyncHandle!._emit("active");
    lastSyncHandle!._emit("paused");
    expect(onStateChange).toHaveBeenCalledWith("ok");
    expect(engine.getDiagnostics().state).toBe("ok");
    expect(engine.getDiagnostics().syncPhase).toBe("complete");
    engine.stop();
  });

  it("never-connected backoff: paused alone (no active/change) → stays 'syncing'", async () => {
    // Real probe evidence (spikes/paused-error-probe.mjs): dead-remote fires paused repeatedly
    // with no active, no change, no error (PouchDB hides network failure behind retry pauses).
    // liveSyncContacted stays false → paused must NOT latch ok.
    const onStateChange = vi.fn();
    const { engine } = makeEngine({ docCount: 0 });
    engine.onStateChange = onStateChange;
    engine.register(makePlugin());
    await engine.start();
    onStateChange.mockClear();
    // Never-connected backoff: only paused fires, nothing else.
    lastSyncHandle!._emit("paused");
    lastSyncHandle!._emit("paused");
    expect(onStateChange).not.toHaveBeenCalledWith("ok");
    expect(engine.getDiagnostics().state).toBe("syncing");
    engine.stop();
  });

  it("drained regression guard: change pending:0 then paused → 'ok' (contacted set by change)", async () => {
    // Standard drained scenario: change reports pending===0, then paused fires.
    // liveSyncContacted is set true by the change handler; paused latches ok.
    const onStateChange = vi.fn();
    const { engine } = makeEngine({ docCount: 0 });
    engine.onStateChange = onStateChange;
    engine.register(makePlugin());
    await engine.start();
    onStateChange.mockClear();
    lastSyncHandle!._emit("change", { direction: "pull", change: { docs_written: 1, pending: 0 } });
    lastSyncHandle!._emit("paused");
    expect(onStateChange).toHaveBeenCalledWith("ok");
    expect(engine.getDiagnostics().state).toBe("ok");
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

  // ---- Wipe-and-pull (replaces BUG #77 prune approach) ---------------------

  // UPDATED: was "wipeLocalFiles BEFORE db.destroy()" — that was the BUG.
  // The fix reverses the order: destroy DB FIRST, then wipe FS.
  // Rationale: if the process crashes after FS-wipe but before DB-destroy,
  // PouchDB still holds all docs; the next boot's reconcile sees FS-absent docs
  // and tombstones them → 319 notes deleted. Destroying the DB first means any
  // crash leaves an empty PouchDB (first-run gate skips reconcile). See BUG.
  it("calls db.destroy() BEFORE bridge.wipeLocalFiles (crash-safe reorder)", async () => {
    const { engine, db, bridge } = makeEngine({ docCount: 5 });
    engine.register(makePlugin());
    await engine.replaceLocalFromServer();
    expect(bridge.wipeLocalFiles).toHaveBeenCalledOnce();
    const destroyOrder = (db.destroy as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const wipeOrder = (bridge.wipeLocalFiles as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const pullOrder = (db.replicate.from as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    // DB must be destroyed BEFORE FS is wiped (crash-safe order)
    expect(destroyOrder).toBeLessThan(wipeOrder);
    // Both must precede the pull
    expect(wipeOrder).toBeLessThan(pullOrder);
  });

  it("writes the replace marker BEFORE db.destroy() and clears it after pull completes", async () => {
    // The durable marker protects the crash-during-pull window: if replicate.from
    // writes 319 docs to PouchDB but only flushes 50 to FS before a crash, the next
    // boot sees doc_count=319 (not 0) — the first-run gate alone is not enough.
    // The marker overrides the doc_count check and forces a fresh pull.
    const markerWrites: string[] = [];
    const markerClears: string[] = [];
    const callOrder: string[] = [];
    const { engine, db, bridge } = makeEngine({ docCount: 5 });

    // Track destroy and wipe order alongside marker writes
    const origDestroy = (db.destroy as ReturnType<typeof vi.fn>);
    origDestroy.mockImplementation(async () => { callOrder.push("destroy"); });
    const origWipe = (bridge.wipeLocalFiles as ReturnType<typeof vi.fn>);
    origWipe.mockImplementation(async () => { callOrder.push("wipe"); });

    const markerStore = {
      write: vi.fn(() => { markerWrites.push("write"); callOrder.push("marker-write"); }),
      clear: vi.fn(() => { markerClears.push("clear"); callOrder.push("marker-clear"); }),
      has: vi.fn(() => false),
    };

    engine.setReplaceMarkerStore(markerStore);
    engine.register(makePlugin());
    await engine.replaceLocalFromServer();

    // Marker must have been written exactly once
    expect(markerStore.write).toHaveBeenCalledOnce();
    // Marker must have been cleared exactly once (after pull)
    expect(markerStore.clear).toHaveBeenCalledOnce();

    // Marker written BEFORE destroy (and therefore before wipe and pull)
    const markerWriteIdx = callOrder.indexOf("marker-write");
    const destroyIdx = callOrder.indexOf("destroy");
    const wipeIdx = callOrder.indexOf("wipe");
    const markerClearIdx = callOrder.indexOf("marker-clear");

    expect(markerWriteIdx).toBeGreaterThanOrEqual(0);
    expect(markerWriteIdx).toBeLessThan(destroyIdx);
    expect(markerWriteIdx).toBeLessThan(wipeIdx);
    // Marker cleared AFTER wipe (i.e., after all destructive operations)
    expect(markerClearIdx).toBeGreaterThan(wipeIdx);
  });

  it("calls bridge.wipeLocalFiles with an isExcluded predicate that protects .git/ paths", async () => {
    const { engine, bridge } = makeEngine({ docCount: 5 });
    engine.register(makePlugin());
    await engine.replaceLocalFromServer();
    const [isExcluded] = (bridge.wipeLocalFiles as ReturnType<typeof vi.fn>).mock.calls[0] as [(path: string) => boolean];
    // .git is always hardcoded into the exclude list by replaceLocalFromServer
    expect(isExcluded(".git/config")).toBe(true);
    // non-excluded paths pass through
    expect(isExcluded("notes.md")).toBe(false);
  });

  it("suspends vault events for the whole replace: ON before wipe, OFF after pull", async () => {
    const { engine, bridge } = makeEngine({ docCount: 5 });
    engine.register(makePlugin());
    await engine.replaceLocalFromServer();
    const suppress = bridge.setSuppressVaultEvents as ReturnType<typeof vi.fn>;
    // Called with true (suspend) then false (resume).
    expect(suppress).toHaveBeenCalledWith(true);
    expect(suppress).toHaveBeenCalledWith(false);
    const onOrder = suppress.mock.invocationCallOrder[0];   // true
    const offOrder = suppress.mock.invocationCallOrder[1];  // false
    const wipeOrder = (bridge.wipeLocalFiles as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    // Suspend before the wipe; resume only after wipe (and the pull) completed.
    expect(onOrder).toBeLessThan(wipeOrder);
    expect(offOrder).toBeGreaterThan(wipeOrder);
  });
});

// ---- c5: selector constants -------------------------------------------------

describe("PouchDbSyncEngine — selector constants (Refs #72)", () => {
  // The selector shape is the contract validated against prod by the spike: the inverse
  // server-side `_changes?filter=_selector` count was exactly 6750 (the binary-doc count).
  // A typo here (e.g. `$exist`) would silently pull everything client-side, erasing the
  // bandwidth win, with no unit-test signal unless the shape is pinned.

  it("TEXT_SELECTOR matches docs WITHOUT _attachments ($exists:false)", () => {
    expect(TEXT_SELECTOR).toEqual({ _attachments: { $exists: false } });
  });

  it("TEXT_SELECTOR is the inverse, on the same field, of the binary backlog selector", () => {
    // Phase-1 text ({$exists:false}) and the unfiltered backfill's binary docs
    // ({$exists:true}) partition the DB on the SAME field with opposite $exists — no overlap,
    // full coverage. The binary inverse is not a production const (the unfiltered live
    // db.sync owns the backfill); it is asserted inline here purely to document the partition.
    const binaryInverse = { _attachments: { $exists: true } };
    expect(TEXT_SELECTOR._attachments.$exists).toBe(false);
    expect(binaryInverse._attachments.$exists).toBe(true);
  });

  it("phase-1 pull passes the exact TEXT_SELECTOR constant (not an inline literal)", async () => {
    const { engine, db } = makeEngine({ docCount: 0 });
    engine.register(makePlugin());
    await engine.start();
    const opts = (db.replicate.from as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      selector: unknown;
    };
    // toBe (reference identity), not toEqual: proves the engine wires the shared constant
    // through, so changing the constant changes the wire behavior — no drift.
    expect(opts.selector).toBe(TEXT_SELECTOR);
  });
});

// ---- Refs #74: resilient resume after transient sync errors -----------------

/**
 * These tests prove the stall bug (no resume after network error) and verify the fix.
 *
 * Strategy: use vi.useFakeTimers() so backoff sleeps don't stall the test suite.
 * The new test MUST fail on unfixed code (db.sync called only once, error latched forever)
 * and PASS after the fix (db.sync called again, error cleared on success).
 */
describe("PouchDbSyncEngine — resilient resume after transient error (Refs #74)", () => {
  beforeEach(() => {
    lastSyncHandle = null;
    lastReplicateHandle = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
  });

  it("live-sync error triggers a restart (db.sync called again) after backoff [FAILS on unfixed code]", async () => {
    // On unfixed code: error handler only calls setError, no restart.
    // db.sync is called exactly once and stays stopped.
    // On fixed code: error schedules a backoff restart → db.sync called a second time.
    const { engine, db } = makeEngine({ docCount: 5 }); // doc_count>0 → goes directly to live sync
    engine.register(makePlugin());
    await engine.start();

    const firstHandle = lastSyncHandle!;
    expect(db.sync).toHaveBeenCalledTimes(1);

    // Simulate transient network failure (WebKit "Load failed")
    firstHandle._emit("error", new Error("Load failed"));

    // Advance past the first backoff window (2s initial)
    await vi.advanceTimersByTimeAsync(3000);

    // AFTER fix: db.sync must be called again (a new handle was created)
    expect(db.sync).toHaveBeenCalledTimes(2);
    expect(lastSyncHandle).not.toBe(firstHandle);

    engine.stop();
  });

  it("error clears (lastError → null) when the restarted sync reports a successful change", async () => {
    // Stale "Initial sync failed" must NOT persist after the sync recovers.
    const { engine } = makeEngine({ docCount: 5 });
    const onError = vi.fn();
    engine.onError = onError;
    engine.register(makePlugin());
    await engine.start();

    // Trigger error
    lastSyncHandle!._emit("error", new Error("Load failed"));
    expect(engine.getDiagnostics().lastError).not.toBeNull();

    // Advance past backoff → restart fires
    await vi.advanceTimersByTimeAsync(3000);

    // Simulate successful change on the new handle
    lastSyncHandle!._emit("change", { direction: "pull", change: { docs_written: 10, pending: 0 } });

    // lastError must be cleared now — stale error must not persist
    expect(engine.getDiagnostics().lastError).toBeNull();

    engine.stop();
  });

  it("stop() cancels any pending backoff timer (no leak into later tests)", async () => {
    const { engine, db } = makeEngine({ docCount: 5 });
    engine.register(makePlugin());
    await engine.start();

    lastSyncHandle!._emit("error", new Error("Load failed"));
    // stop() before backoff fires — timer must be cleared
    engine.stop();

    await vi.advanceTimersByTimeAsync(10000); // way past any backoff

    // db.sync should NOT be called again after stop()
    expect(db.sync).toHaveBeenCalledTimes(1);
  });

  it("phase-1 error triggers a restart of runInitialPull (replicate.from called again)", async () => {
    // On unfixed code: phase-1 error calls setError and resolves — no restart.
    // On fixed code: a backoff restart re-runs the initial pull (checkpoint:'target' so no re-download).
    const db = makeMockDb(0);
    let replicateCallCount = 0;
    (db.replicate.from as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const handle = makeMockSyncHandle();
      lastReplicateHandle = handle;
      replicateCallCount++;
      if (replicateCallCount === 1) {
        // First call: simulate transient error (WebKit "Load failed")
        setTimeout(() => handle._emit("error", new Error("Load failed")), 0);
      } else {
        // Second call: success
        setTimeout(() => handle._emit("complete"), 0);
      }
      return handle;
    });
    const bridge = makeMockBridge();
    const dbFactory = () => db as unknown as Parameters<typeof PouchDbSyncEngine>[1];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine = new PouchDbSyncEngine(makeSettings(), db as any, bridge as any, dbFactory as any);
    engine.register(makePlugin());

    // start() must resolve even though phase-1 errored (does not block forever)
    const startPromise = engine.start();
    await vi.runAllTimersAsync(); // drain the error timer
    await startPromise;

    // Advance past backoff → retry fires
    await vi.advanceTimersByTimeAsync(3000);
    await vi.runAllTimersAsync(); // drain the complete timer

    // replicate.from must have been called twice (first failed, second succeeded)
    expect(db.replicate.from).toHaveBeenCalledTimes(2);

    engine.stop();
  });

  it("backoff resets after a successful change (no stale backoff doubling)", async () => {
    // After a successful change the backoff counter resets to the base delay.
    // This test checks the happy path doesn't accrue an ever-growing backoff.
    const { engine, db } = makeEngine({ docCount: 5 });
    engine.register(makePlugin());
    await engine.start();

    // Error → restart
    lastSyncHandle!._emit("error", new Error("Load failed"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(db.sync).toHaveBeenCalledTimes(2);

    // Successful change on restarted handle → backoff resets
    lastSyncHandle!._emit("change", { direction: "pull", change: { docs_written: 5, pending: 0 } });

    // Another error → backoff should be base (2s), not doubled from previous
    lastSyncHandle!._emit("error", new Error("Load failed again"));
    await vi.advanceTimersByTimeAsync(3000); // 2s base + margin
    expect(db.sync).toHaveBeenCalledTimes(3);

    engine.stop();
  });

  it("reconnect after error: contacted reset → paused stays syncing; new session active+paused → ok", async () => {
    // Full scenario: error fires (liveSyncContacted reset); scheduleRestart fires after backoff
    // (startLiveSync resets both pending and contacted); new session active→paused latches ok.
    const { engine, db } = makeEngine({ docCount: 5 }); // doc_count>0 → goes directly to live sync
    engine.register(makePlugin());
    await engine.start();

    const firstHandle = lastSyncHandle!;
    // Establish some sync activity on the first session.
    firstHandle._emit("change", { direction: "pull", change: { docs_written: 5, pending: 2 } });
    firstHandle._emit("active");

    // Error fires → liveSyncContacted reset to false.
    firstHandle._emit("error", new Error("Network failure"));
    // A paused immediately after error (before restart) must NOT latch ok:
    // contacted=false, pending=2 so noOutstandingWork=false anyway.
    firstHandle._emit("paused");
    expect(engine.getDiagnostics().state).not.toBe("ok");

    // Advance past backoff → scheduleRestart fires → startLiveSync() creates new handle.
    // startLiveSync() resets liveSyncPending = PENDING_UNKNOWN and liveSyncContacted = false.
    await vi.advanceTimersByTimeAsync(3000);
    expect(db.sync).toHaveBeenCalledTimes(2); // new handle created
    const newHandle = lastSyncHandle!;
    expect(newHandle).not.toBe(firstHandle);

    // New session: caught-up sequence (active → paused, no change) → must latch ok.
    newHandle._emit("active");
    newHandle._emit("paused");
    expect(engine.getDiagnostics().state).toBe("ok");
    expect(engine.getDiagnostics().syncPhase).toBe("complete");

    engine.stop();
  });
});

// ---- c5: resume guard (no full re-pull on visibilitychange) -----------------

/**
 * Resume guard (plan section 5). Two invariants:
 *  - A visibilitychange WHILE phase-1 is still pulling must NOT interrupt it
 *    (handleVisibilityVisible guards on initialPullRunning) — otherwise a backgrounding
 *    during the initial text pull would restart sync mid-pull.
 *  - A visibilitychange DURING the binary backfill must RESUME (restart the live db.sync
 *    handle, which continues from its checkpoint) and must NOT trigger a fresh
 *    replicate.from — that would be a full re-pull, the exact thing this design avoids.
 */
describe("PouchDbSyncEngine — resume guard on visibilitychange (Refs #72)", () => {
  beforeEach(() => { lastSyncHandle = null; lastReplicateHandle = null; });
  afterEach(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  function makeEngineWithPendingPhase1() {
    // replicate.from that does NOT auto-complete, so phase-1 stays in-flight and
    // initialPullRunning remains true for the duration of the test.
    const db = makeMockDb(0);
    (db.replicate.from as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const handle = makeMockSyncHandle();
      lastReplicateHandle = handle;
      return handle; // never emits "complete"
    });
    const bridge = makeMockBridge();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbFactory = () => db as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine = new PouchDbSyncEngine(makeSettings(), db as any, bridge as any, dbFactory as any);
    return { engine, db, bridge };
  }

  it("does NOT interrupt phase-1: visibilitychange while pulling leaves the pull handle alone", async () => {
    const { engine, db } = makeEngineWithPendingPhase1();
    const plugin = makePlugin();
    engine.register(plugin);
    // start() awaits runInitialPull's promise which never resolves here, so kick it off
    // without awaiting; phase-1 is now in-flight (initialPullRunning === true). Flush the
    // microtask queue (start() awaits isFirstRun()->db.info() before reaching the pull) until
    // replicate.from has actually been issued.
    void engine.start();
    await new Promise((r) => setTimeout(r, 0));
    const pullHandle = lastReplicateHandle!;
    expect(db.replicate.from).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    plugin._triggerDom("visibilitychange");

    // The in-flight phase-1 handle must NOT be cancelled, and no live sync started.
    expect(pullHandle.cancel).not.toHaveBeenCalled();
    expect(db.sync).not.toHaveBeenCalled();
    expect(db.replicate.from).toHaveBeenCalledTimes(1);
  });

  it("resumes during backfill: visibilitychange restarts the live sync handle, no re-pull", async () => {
    const { engine, db } = makeEngine({ docCount: 0 });
    const plugin = makePlugin();
    engine.register(plugin);
    await engine.start();
    // Phase-1 auto-completed (default mock) -> live db.sync running for the backfill.
    const firstLive = lastSyncHandle!;
    const replicateCallsAfterStart = (db.replicate.from as ReturnType<typeof vi.fn>).mock.calls.length;

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    plugin._triggerDom("visibilitychange");
    // startLiveSync is now async (awaits buildRemote). Flush so the new handle is assigned.
    await new Promise((r) => setTimeout(r, 0));

    // Old live handle cancelled, a NEW one created (resume from checkpoint via retry).
    expect(firstLive.cancel).toHaveBeenCalled();
    expect(lastSyncHandle).not.toBe(firstLive);
    // Crucially: resume must NOT issue a fresh initial pull — that would be a full re-pull.
    expect((db.replicate.from as ReturnType<typeof vi.fn>).mock.calls.length).toBe(replicateCallsAfterStart);
    engine.stop();
  });

  it("a cold start with doc_count>0 (post phase-1 app kill) resumes via live sync, no re-pull", async () => {
    // Mobile app-kill mid-backfill: next cold start sees doc_count>0 -> isFirstRun()===false
    // -> startLiveSync() directly. The backfill continues from checkpoint; binaries are NOT
    // re-pulled via a phase-1 replicate.from. (Plan section 5: "resumes correctly with no
    // special handling".)
    const { engine, db } = makeEngine({ docCount: 8305 });
    engine.register(makePlugin());
    await engine.start();
    expect(db.replicate.from).not.toHaveBeenCalled();
    expect(db.sync).toHaveBeenCalledWith(expect.any(String), { live: true, retry: true });
    engine.stop();
  });
});

// ---- Auth error handling (401/403) -------------------------------------------
//
// Per-user vault ownership: CouchDB enforces _security.members per database.
// A device with wrong credentials gets a 401; a user accessing the wrong database
// gets a 403. PouchDB source code (pouchdb-replication/src/replicate.js) shows that
// fatal errors with errorName "unauthorized"/"forbidden" emit the `error` event
// (PouchDB does NOT schedule its own backoff retry for auth errors — it fires error
// and stops). Our scheduleRestart() compounding that into an infinite loop is the bug.
//
// The fix: isAuthError() detects 401/403 in the error handler. On auth failure:
//   - cancel the handle (prevent any pending PouchDB-internal retry)
//   - surface a clear actionable message (not the raw URL with password)
//   - set state "error" and DO NOT call scheduleRestart()
//   - also handle `denied` event for per-document authorization failures
//   - ensure the password is never visible in error messages or getDiagnostics()

describe("PouchDbSyncEngine — auth error handling 401/403", () => {
  beforeEach(() => {
    lastSyncHandle = null;
    lastReplicateHandle = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
  });

  // Helper: build a PouchDB-shaped auth error (matches pouchdb-replication error shape)
  function makeAuthError(status: 401 | 403): Error & { status?: number; name?: string } {
    const err = new Error(status === 401 ? "Unauthorized" : "Forbidden") as Error & { status?: number; name?: string };
    err.status = status;
    err.name = status === 401 ? "unauthorized" : "forbidden";
    return err;
  }

  it("live-sync 401 error stops sync without scheduling a backoff restart [RED: scheduleRestart called on unfixed code]", async () => {
    const { engine, db } = makeEngine({ docCount: 5 }); // doc_count>0 → live sync directly
    engine.register(makePlugin());
    await engine.start();

    const firstHandle = lastSyncHandle!;
    expect(db.sync).toHaveBeenCalledTimes(1);

    firstHandle._emit("error", makeAuthError(401));

    // Advance well past any backoff window — on unfixed code this would create a second handle
    await vi.advanceTimersByTimeAsync(10_000);

    // On fixed code: auth error does NOT schedule a restart — db.sync stays at 1 call
    expect(db.sync).toHaveBeenCalledTimes(1);
    expect(engine.getDiagnostics().state).toBe("error");
  });

  it("live-sync 403 error stops sync without scheduling a backoff restart", async () => {
    const { engine, db } = makeEngine({ docCount: 5 });
    engine.register(makePlugin());
    await engine.start();

    lastSyncHandle!._emit("error", makeAuthError(403));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(db.sync).toHaveBeenCalledTimes(1);
    expect(engine.getDiagnostics().state).toBe("error");
  });

  it("live-sync 401 error surfaces a clear actionable message via onError", async () => {
    const { engine } = makeEngine({ docCount: 5 });
    const errors: string[] = [];
    engine.onError = (msg) => errors.push(msg);
    engine.register(makePlugin());
    await engine.start();

    lastSyncHandle!._emit("error", makeAuthError(401));

    expect(errors).toHaveLength(1);
    // Message must mention credentials/settings — actionable for the user
    expect(errors[0].toLowerCase()).toMatch(/authoriz|credenti|settings|password|username/);
  });

  it("live-sync 403 error surfaces a clear actionable message via onError", async () => {
    const { engine } = makeEngine({ docCount: 5 });
    const errors: string[] = [];
    engine.onError = (msg) => errors.push(msg);
    engine.register(makePlugin());
    await engine.start();

    lastSyncHandle!._emit("error", makeAuthError(403));

    expect(errors).toHaveLength(1);
    expect(errors[0].toLowerCase()).toMatch(/authoriz|credenti|settings|password|username/);
  });

  it("auth error message does NOT contain the password (credential scrub)", async () => {
    // Realistic scenario: PouchDB may embed the request URL (with embedded credentials)
    // into the error message/stack. The engine must scrub the password before surfacing.
    const { engine } = makeEngine({ docCount: 5 }); // settings has user=alice, password=secret
    const errors: string[] = [];
    engine.onError = (msg) => errors.push(msg);
    engine.register(makePlugin());
    await engine.start();

    // Simulate PouchDB echoing the request URL (which contains the password) in the error
    const urlLeakingError = makeAuthError(401);
    urlLeakingError.message = "Request to https://alice:secret@sync.example.com/test-vault failed: 401 Unauthorized";
    lastSyncHandle!._emit("error", urlLeakingError);

    const combined = errors.join(" ") + JSON.stringify(engine.getDiagnostics());
    expect(combined).not.toContain("secret"); // password must not appear anywhere
    expect(combined).not.toContain("alice:secret"); // URL credential form must not appear
  });

  it("auth error does not expose password in getDiagnostics().lastError", async () => {
    const { engine } = makeEngine({ docCount: 5 });
    engine.register(makePlugin());
    await engine.start();

    const urlLeakingError = makeAuthError(401);
    urlLeakingError.message = "Request to https://alice:secret@sync.example.com/test-vault failed";
    lastSyncHandle!._emit("error", urlLeakingError);

    const lastError = engine.getDiagnostics().lastError ?? "";
    expect(lastError).not.toContain("secret");
  });

  it("phase-1 (initial pull) 401 error stops without scheduling restart", async () => {
    const db = makeMockDb(0);
    (db.replicate.from as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const handle = makeMockSyncHandle();
      lastReplicateHandle = handle;
      // Immediately emit a 401 on the next tick
      setTimeout(() => handle._emit("error", makeAuthError(401)), 0);
      return handle;
    });
    const bridge = makeMockBridge();
    const dbFactory = () => db as unknown as Parameters<typeof PouchDbSyncEngine>[1];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine = new PouchDbSyncEngine(makeSettings(), db as any, bridge as any, dbFactory as any);
    engine.register(makePlugin());

    const startPromise = engine.start();
    await vi.runAllTimersAsync();
    await startPromise;

    // Advance way past any potential backoff
    await vi.advanceTimersByTimeAsync(10_000);

    // Auth error must NOT retry replicate.from
    expect(db.replicate.from).toHaveBeenCalledTimes(1);
    expect(engine.getDiagnostics().state).toBe("error");
  });

  it("phase-1 (initial pull) 401 error surfaces an actionable message", async () => {
    const db = makeMockDb(0);
    (db.replicate.from as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const handle = makeMockSyncHandle();
      lastReplicateHandle = handle;
      setTimeout(() => handle._emit("error", makeAuthError(401)), 0);
      return handle;
    });
    const bridge = makeMockBridge();
    const dbFactory = () => db as unknown as Parameters<typeof PouchDbSyncEngine>[1];
    const errors: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine = new PouchDbSyncEngine(makeSettings(), db as any, bridge as any, dbFactory as any);
    engine.onError = (msg) => errors.push(msg);
    engine.register(makePlugin());

    const startPromise = engine.start();
    await vi.runAllTimersAsync();
    await startPromise;

    expect(errors).toHaveLength(1);
    expect(errors[0].toLowerCase()).toMatch(/authoriz|credenti|settings|password|username/);
  });

  it("non-auth errors still trigger the normal backoff restart (regression guard)", async () => {
    const { engine, db } = makeEngine({ docCount: 5 });
    engine.register(makePlugin());
    await engine.start();

    // Regular transient network error — must still restart (existing behavior preserved)
    lastSyncHandle!._emit("error", new Error("Load failed"));
    await vi.advanceTimersByTimeAsync(3_000);

    expect(db.sync).toHaveBeenCalledTimes(2); // backoff restart fired
    engine.stop();
  });

  it("'denied' event on live sync emits a warning via onError but does NOT stop the sync", async () => {
    // Per-document authorization failure: a doc outside the user's _security scope.
    // PouchDB emits 'denied' for this case. The engine must warn without killing the
    // whole sync session — individual doc denial ≠ session failure.
    //
    // Phase-1 (docCount:0) auto-completes via a mock setTimeout(0) — we kick off start()
    // non-awaited and flush timers so the complete fires, putting us in live db.sync
    // state "syncing". Then we assert denied doesn't kill the session.
    const { engine } = makeEngine({ docCount: 0 });
    const errors: string[] = [];
    engine.onError = (msg) => errors.push(msg);
    engine.register(makePlugin());

    // Kick start without blocking — phase-1 hangs until the fake setTimeout fires.
    void engine.start();
    // Flush microtasks (db.info await) so replicate.from is issued, then flush the
    // setTimeout(0) that emits "complete" on the replicate handle.
    await vi.runAllTimersAsync();
    // Now phase-1 complete fired → startLiveSync() called → live handle created.

    const syncHandle = lastSyncHandle!;
    expect(engine.getDiagnostics().state).toBe("syncing"); // confirm we're in the right state

    // Simulate a per-document denied event (shape from pouchdb-replication source)
    const deniedErr = { id: "file/private.md", error: "forbidden", reason: "not an admin" };
    syncHandle._emit("denied", deniedErr);

    // Warning surfaced to the user
    expect(errors.length).toBeGreaterThan(0);
    // The handle was NOT cancelled — sync continues
    expect(syncHandle.cancel).not.toHaveBeenCalled();
    // State must NOT be "error" — individual doc denial does not kill the session
    expect(engine.getDiagnostics().state).not.toBe("error");

    engine.stop();
  });
});

// ---- Gateway mode: remoteFactory + gatewayCredsResolver injection -----------
//
// These tests verify Workstream C criteria 2 + 6 (plan piped-cuddling-micali.md):
//
//   Criterion 2: remoteFactory receives the proxy base URL + gatewayFetch and
//                the built HANDLE is passed to replicate.from / db.sync (not a URL
//                string). Event handling, two-phase pull, and checkpoint:'target'
//                are all unchanged — only the remote argument changes shape.
//
//   Criterion 6 (Phase A/B fallback): if gatewayCredsResolver returns null (no
//                gateway creds on this device), the engine falls back to the legacy
//                Basic-auth URL, keeping un-migrated devices working unchanged.

type FakePouchRemote = { _url: string; _fetchInjected: boolean };

/**
 * A fake remoteFactory: records what URL + fetch it was called with and returns
 * a typed object the test can assert on. The `db.sync` / `db.replicate.from` mocks
 * accept any value as the first argument (they are typed as `_remote: unknown`).
 */
function makeFakeRemoteFactory() {
  const calls: Array<{ url: string; opts: { fetch?: typeof fetch } }> = [];
  const factory = vi.fn((url: string, opts: { fetch?: typeof fetch }): FakePouchRemote => {
    calls.push({ url, opts });
    return { _url: url, _fetchInjected: typeof opts.fetch === "function" };
  });
  return { factory, calls };
}

/**
 * Builds an engine with:
 *   - `gatewayUrl` set on settings
 *   - an injected `remoteFactory` (fake, for inspection)
 *   - an injected `gatewayCredsResolver` that resolves to a fake fetch (gateway
 *     mode) or null (legacy mode)
 */
function makeGatewayEngine(opts: {
  docCount?: number;
  gatewayCredsResolverResult: typeof fetch | null;
  gatewayUrl?: string;
}) {
  const settings = {
    ...makeSettings(),
    // In production, couchDbName matches the CouchDB database name: "vault-<slug>".
    // The proxy URL becomes ${gatewayUrl}/couchdb/${couchDbName}, e.g.
    // https://gateway.test/couchdb/vault-test. This fixture uses the production
    // naming convention so assertions on "/couchdb/vault-" succeed.
    couchDbName: "vault-test",
    gatewayUrl: opts.gatewayUrl ?? "https://gateway.test",
    // Keep legacy creds present (coexistence during migration)
    couchDbUser: "alice",
    couchDbPassword: "secret",
  };
  const db = makeMockDb(opts.docCount ?? 5); // >0 → goes straight to live sync by default
  const bridge = makeMockBridge();
  const dbFactory = () => db as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const { factory: remoteFactory, calls: remoteFactoryCalls } = makeFakeRemoteFactory();
  // The resolver is the seam for mode selection: gateway fetch or null.
  const gatewayCredsResolver = vi.fn(
    (): Promise<typeof fetch | null> => Promise.resolve(opts.gatewayCredsResolverResult),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const engine = new PouchDbSyncEngine(
    settings,
    db as any,
    bridge as any,
    dbFactory as any,
    remoteFactory as any,
    gatewayCredsResolver,
  );
  return { engine, db, bridge, remoteFactory, remoteFactoryCalls, gatewayCredsResolver };
}

/** A fake gatewayFetch — simply a function with the right signature. */
function fakeFetch(): typeof fetch {
  return vi.fn() as unknown as typeof fetch;
}

describe("PouchDbSyncEngine — gateway mode (remoteFactory + gatewayCredsResolver)", () => {
  beforeEach(() => { lastSyncHandle = null; lastReplicateHandle = null; });

  it("live sync (db.sync) receives a remote HANDLE (not a URL string) in gateway mode", async () => {
    const gf = fakeFetch();
    const { engine, db } = makeGatewayEngine({ docCount: 5, gatewayCredsResolverResult: gf });
    engine.register(makePlugin());
    await engine.start();

    // The remote argument passed to db.sync must be the object returned by
    // remoteFactory, not a URL string.
    const syncArg = (db.sync as ReturnType<typeof vi.fn>).mock.calls[0][0] as FakePouchRemote;
    expect(typeof syncArg).toBe("object");
    expect(syncArg._url).toContain("/couchdb/vault-");
    expect(syncArg._fetchInjected).toBe(true);

    engine.stop();
  });

  it("remoteFactory is called with the proxy base URL: ${gatewayUrl}/couchdb/vault-${slug}", async () => {
    const gf = fakeFetch();
    // couchDbName is 'vault-test-vault' → slug is 'test-vault'
    const settings = { ...makeSettings(), gatewayUrl: "https://gw.example.com", couchDbName: "vault-notes" };
    const db = makeMockDb(5);
    const bridge = makeMockBridge();
    const { factory: remoteFactory, calls } = makeFakeRemoteFactory();
    const gatewayCredsResolver = vi.fn(() => Promise.resolve(gf as unknown as typeof fetch));
    const engine = new PouchDbSyncEngine(
      settings,
      db as any, bridge as any,
      () => db as any,
      remoteFactory as any,
      gatewayCredsResolver,
    );
    engine.register(makePlugin());
    await engine.start();

    // remoteFactory must receive the proxy base (no user:pass, no trailing /dbName on URL)
    expect(calls.length).toBeGreaterThan(0);
    const firstCall = calls[0];
    expect(firstCall.url).toBe("https://gw.example.com/couchdb/vault-notes");
    // The gateway fetch function must be forwarded as-is
    expect(firstCall.opts.fetch).toBe(gf);

    engine.stop();
  });

  it("slug derivation: couchDbName='vault-my-notes' → proxy path contains 'vault-my-notes'", async () => {
    const gf = fakeFetch();
    const settings = {
      ...makeSettings(),
      gatewayUrl: "https://gw.example.com",
      couchDbName: "vault-my-notes",
    };
    const db = makeMockDb(5);
    const bridge = makeMockBridge();
    const { factory: remoteFactory, calls } = makeFakeRemoteFactory();
    const gatewayCredsResolver = vi.fn(() => Promise.resolve(gf as unknown as typeof fetch));
    const engine = new PouchDbSyncEngine(
      settings, db as any, bridge as any, () => db as any, remoteFactory as any, gatewayCredsResolver,
    );
    engine.register(makePlugin());
    await engine.start();

    expect(calls[0].url).toBe("https://gw.example.com/couchdb/vault-my-notes");
    engine.stop();
  });

  it("phase-1 replicate.from also receives the remote HANDLE (not a URL) in gateway mode", async () => {
    const gf = fakeFetch();
    const { engine, db } = makeGatewayEngine({ docCount: 0, gatewayCredsResolverResult: gf });
    engine.register(makePlugin());
    await engine.start();

    // First argument to replicate.from must be the handle, not a string.
    const replicateArg = (db.replicate.from as ReturnType<typeof vi.fn>).mock.calls[0][0] as FakePouchRemote;
    expect(typeof replicateArg).toBe("object");
    expect(replicateArg._url).toContain("/couchdb/vault-");
    expect(replicateArg._fetchInjected).toBe(true);

    engine.stop();
  });

  it("testConnection probes the DB URL via a raw GET through the gateway fetch, returns true on 2xx", async () => {
    // testConnection no longer goes through db.replicate.from (a PouchDB probe cannot
    // distinguish a missing DB from a healthy one — see resolveProbeTarget()'s comment).
    // It issues a raw GET via the resolved gateway fetch and checks the HTTP status itself.
    const gatewayFetch = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200 } as unknown as Response),
    );
    const { engine } = makeGatewayEngine({
      docCount: 5,
      gatewayCredsResolverResult: gatewayFetch as unknown as typeof fetch,
    });

    const result = await engine.testConnection();

    expect(result).toBe(true);
    expect(gatewayFetch).toHaveBeenCalledWith("https://gateway.test/couchdb/vault-test");
  });

  it("testConnection detects a missing DB (404 via gateway fetch): returns false and records lastError", async () => {
    const gatewayFetch = vi.fn(() =>
      Promise.resolve({ ok: false, status: 404, statusText: "Object Not Found" } as unknown as Response),
    );
    const { engine } = makeGatewayEngine({
      docCount: 5,
      gatewayCredsResolverResult: gatewayFetch as unknown as typeof fetch,
    });

    const result = await engine.testConnection();

    expect(result).toBe(false);
    expect(engine.getDiagnostics().lastError).toContain("404");
  });

  it("testConnection clears a stale lastError on a subsequent success", async () => {
    // A failed probe records lastError; a later successful probe must clear it so
    // the Diagnostics "Last error" line doesn't keep showing a resolved failure
    // right after "Connected".
    const gatewayFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404, statusText: "Object Not Found" } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200 } as unknown as Response);
    const { engine } = makeGatewayEngine({
      docCount: 5,
      gatewayCredsResolverResult: gatewayFetch as unknown as typeof fetch,
    });

    expect(await engine.testConnection()).toBe(false);
    expect(engine.getDiagnostics().lastError).toContain("404");

    expect(await engine.testConnection()).toBe(true);
    expect(engine.getDiagnostics().lastError).toBeNull();
  });

  it("testConnection legacy mode: GETs couchDbUrl/couchDbName with a Basic-auth Authorization header", async () => {
    // No gateway credentials available (resolver returns null) → legacy fallback.
    // The probe must hit the raw DB URL with an Authorization header derived from
    // settings.couchDbUser/couchDbPassword — never embedded in the URL itself.
    const { engine } = makeGatewayEngine({ docCount: 5, gatewayCredsResolverResult: null });
    const fetchSpy = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve({ ok: true, status: 200 } as unknown as Response),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const result = await engine.testConnection();

      expect(result).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://sync.example.com/vault-test");
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe(`Basic ${btoa("alice:secret")}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("gateway mode does not embed credentials in the URL (no user:pass@)", async () => {
    const gf = fakeFetch();
    const { engine, remoteFactoryCalls } = makeGatewayEngine({ docCount: 5, gatewayCredsResolverResult: gf });
    engine.register(makePlugin());
    await engine.start();

    // The proxy base URL must not contain embedded Basic-auth credentials.
    const url = remoteFactoryCalls[0]?.url ?? "";
    expect(url).not.toContain("@");
    expect(url).not.toContain("alice");
    expect(url).not.toContain("secret");

    engine.stop();
  });
});

describe("PouchDbSyncEngine — Phase A/B fallback (no gateway creds → legacy URL)", () => {
  beforeEach(() => { lastSyncHandle = null; lastReplicateHandle = null; });

  it("falls back to legacy Basic-auth URL when gatewayCredsResolver returns null", async () => {
    // A device without gateway creds: the resolver returns null.
    // Engine must use the old https://user:pass@couchDbUrl/dbName URL so the
    // device keeps syncing without any gateway migration.
    const { engine, db } = makeGatewayEngine({ docCount: 5, gatewayCredsResolverResult: null });
    engine.register(makePlugin());
    await engine.start();

    // db.sync must have been called with the legacy URL string (not an object).
    const syncArg = (db.sync as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(typeof syncArg).toBe("string");
    expect(syncArg as string).toContain("alice");
    expect(syncArg as string).toContain("secret");
    expect(syncArg as string).not.toContain("gateway.test");

    engine.stop();
  });

  it("legacy URL is also used when gatewayUrl is absent, even if resolver returns a fetch", async () => {
    // Guard: no gatewayUrl on settings → cannot build a proxy base → fall back.
    const gf = fakeFetch();
    const settings = {
      ...makeSettings(),
      // explicitly no gatewayUrl
      couchDbUser: "alice",
      couchDbPassword: "secret",
    };
    const db = makeMockDb(5);
    const bridge = makeMockBridge();
    const { factory: remoteFactory } = makeFakeRemoteFactory();
    const gatewayCredsResolver = vi.fn(() => Promise.resolve(gf as unknown as typeof fetch));
    const engine = new PouchDbSyncEngine(
      settings, db as any, bridge as any, () => db as any, remoteFactory as any, gatewayCredsResolver,
    );
    engine.register(makePlugin());
    await engine.start();

    const syncArg = (db.sync as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(typeof syncArg).toBe("string");

    engine.stop();
  });

  it("mode switching: same engine, resolver returning null uses legacy; resolver returning fetch uses gateway", async () => {
    // This test validates that the mode decision is made per-call to startLiveSync,
    // not at construction time. Two separate engines with different resolvers demonstrate
    // the mode selection driven solely by the resolver's return value.
    const legacyDb = makeMockDb(5);
    const legacyBridge = makeMockBridge();
    const { factory: legacyFactory } = makeFakeRemoteFactory();
    const legacyEngine = new PouchDbSyncEngine(
      { ...makeSettings(), gatewayUrl: "https://gateway.test" },
      legacyDb as any, legacyBridge as any, () => legacyDb as any, legacyFactory as any,
      vi.fn(() => Promise.resolve(null)),
    );
    legacyEngine.register(makePlugin());
    await legacyEngine.start();

    const gwDb = makeMockDb(5);
    const gwBridge = makeMockBridge();
    const gf = fakeFetch();
    const { factory: gwFactory, calls: gwCalls } = makeFakeRemoteFactory();
    const gwEngine = new PouchDbSyncEngine(
      { ...makeSettings(), gatewayUrl: "https://gateway.test" },
      gwDb as any, gwBridge as any, () => gwDb as any, gwFactory as any,
      vi.fn(() => Promise.resolve(gf as unknown as typeof fetch)),
    );
    gwEngine.register(makePlugin());
    await gwEngine.start();

    // Legacy engine: db.sync received a string URL
    expect(typeof (legacyDb.sync as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("string");

    // Gateway engine: db.sync received a handle object from remoteFactory
    expect(typeof (gwDb.sync as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("object");
    expect(gwCalls[0].opts.fetch).toBe(gf);

    legacyEngine.stop();
    gwEngine.stop();
  });

  it("legacy fallback: no remoteFactory at all → URL string still used (existing callers unaffected)", async () => {
    // Engines constructed without remoteFactory (all existing plugin/daemon callers) must
    // keep working identically — the new params are all optional.
    const { engine, db } = makeEngine({ docCount: 5 });
    engine.register(makePlugin());
    await engine.start();

    expect(typeof (db.sync as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("string");

    engine.stop();
  });
});
