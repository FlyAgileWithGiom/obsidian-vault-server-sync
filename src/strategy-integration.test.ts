/**
 * Integration tests for createStrategy() routing.
 *
 * Tests that main.ts createStrategy() returns the correct engine based on
 * Platform.isMobile and settings.syncStrategy override.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Platform } from "./__mocks__/obsidian";
import { DEFAULT_SETTINGS } from "./types";

// ---------------------------------------------------------------------------
// Mock heavy modules so onload() can run without real Obsidian/DOM
// ---------------------------------------------------------------------------

vi.mock("./sync-engine", () => ({
  CustomFetchSyncStrategy: vi.fn().mockImplementation(() => ({
    isRunning: vi.fn().mockReturnValue(false),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    register: vi.fn(),
    updateSettings: vi.fn(),
    onStateChange: null,
    onCountsChange: null,
    onError: null,
    onDiagnosticsChange: null,
    getDiagnostics: vi.fn().mockReturnValue({}),
    planFullSync: vi.fn().mockResolvedValue({}),
    forceFullSync: vi.fn().mockResolvedValue(undefined),
    resumeFullSync: vi.fn().mockResolvedValue(undefined),
    replaceLocalFromServer: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("./couch-client", () => ({
  CouchClient: vi.fn().mockImplementation(() => ({
    ping: vi.fn().mockResolvedValue(true),
  })),
}));

vi.mock("./settings-tab", () => ({
  VaultSyncSettingTab: vi.fn().mockImplementation(() => ({})),
}));

// Mock pouchdb-browser to avoid loading the real bundle
vi.mock("pouchdb-browser", () => ({
  default: vi.fn().mockImplementation(() => ({
    sync: vi.fn().mockReturnValue({ on: vi.fn().mockReturnThis(), cancel: vi.fn() }),
    replicate: { from: vi.fn().mockReturnValue({ on: vi.fn().mockReturnThis(), cancel: vi.fn() }) },
    info: vi.fn().mockResolvedValue({ doc_count: 0, update_seq: 0, db_name: "test" }),
    destroy: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock PouchDbFsBridge
vi.mock("./PouchDbFsBridge", () => ({
  PouchDbFsBridge: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

// Mock PouchDbSyncEngine to avoid importing pouchdb-browser at engine level
vi.mock("./PouchDbSyncEngine", () => ({
  PouchDbSyncEngine: vi.fn().mockImplementation((settings: unknown, db: unknown, bridge: unknown) => {
    void settings; void db; void bridge;
    return {
      isRunning: vi.fn().mockReturnValue(false),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      register: vi.fn(),
      updateSettings: vi.fn(),
      onStateChange: null,
      onCountsChange: null,
      onError: null,
      onDiagnosticsChange: null,
      getDiagnostics: vi.fn().mockReturnValue({}),
      planFullSync: vi.fn().mockResolvedValue({}),
      forceFullSync: vi.fn().mockResolvedValue(undefined),
      resumeFullSync: vi.fn().mockResolvedValue(undefined),
      replaceLocalFromServer: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import VaultSyncPlugin from "./main";
import { CustomFetchSyncStrategy } from "./sync-engine";
import { PouchDbSyncEngine } from "./PouchDbSyncEngine";

// ---------------------------------------------------------------------------
// Plugin factory (minimal — no real Obsidian DOM needed)
// ---------------------------------------------------------------------------

function makePlugin(overrides: Partial<typeof DEFAULT_SETTINGS> = {}): VaultSyncPlugin {
  const plugin = Object.create(VaultSyncPlugin.prototype) as VaultSyncPlugin;
  (plugin as unknown as { app: unknown }).app = {
    vault: {
      getName: vi.fn().mockReturnValue("test-vault"),
      adapter: {
        read: vi.fn().mockRejectedValue(new Error("ENOENT")),
        write: vi.fn().mockResolvedValue(undefined),
      },
    },
  };
  plugin.loadData = vi.fn().mockResolvedValue({});
  plugin.saveData = vi.fn().mockResolvedValue(undefined);
  plugin.settings = { ...DEFAULT_SETTINGS, ...overrides };
  const p = plugin as unknown as {
    syncState: string;
    syncCounts: { pendingPush: number; pendingPull: number };
    diagnosticsListeners: Set<() => void>;
    startupTimer: null;
    ribbonEl: null;
    statusBarEl: null;
    strategy: unknown;
  };
  p.syncState = "idle";
  p.syncCounts = { pendingPush: 0, pendingPull: 0 };
  p.diagnosticsListeners = new Set();
  p.startupTimer = null;
  p.ribbonEl = null;
  p.statusBarEl = null;
  p.strategy = null;
  return plugin;
}

// Helper to call the private createStrategy()
async function callCreateStrategy(plugin: VaultSyncPlugin) {
  return (plugin as unknown as {
    createStrategy(): Promise<unknown>
  }).createStrategy();
}

// ---------------------------------------------------------------------------
// Tests: createStrategy() routing
// ---------------------------------------------------------------------------

describe("VaultSyncPlugin.createStrategy() — routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Platform.isMobile = false;
  });

  afterEach(() => {
    Platform.isMobile = false;
  });

  it("returns CustomFetchSyncStrategy on desktop with override=auto", async () => {
    const plugin = makePlugin({ syncStrategy: "auto" });
    await callCreateStrategy(plugin);
    expect(CustomFetchSyncStrategy).toHaveBeenCalled();
    expect(PouchDbSyncEngine).not.toHaveBeenCalled();
  });

  it("returns CustomFetchSyncStrategy on desktop with override=custom (rollback)", async () => {
    const plugin = makePlugin({ syncStrategy: "custom" });
    await callCreateStrategy(plugin);
    expect(CustomFetchSyncStrategy).toHaveBeenCalled();
    expect(PouchDbSyncEngine).not.toHaveBeenCalled();
  });

  it("returns PouchDbSyncEngine on desktop with override=pouchdb (forced)", async () => {
    const plugin = makePlugin({ syncStrategy: "pouchdb" });
    await callCreateStrategy(plugin);
    expect(PouchDbSyncEngine).toHaveBeenCalled();
    expect(CustomFetchSyncStrategy).not.toHaveBeenCalled();
  });

  it("returns PouchDbSyncEngine on mobile with override=auto (iOS default)", async () => {
    Platform.isMobile = true;
    const plugin = makePlugin({ syncStrategy: "auto" });
    await callCreateStrategy(plugin);
    expect(PouchDbSyncEngine).toHaveBeenCalled();
    expect(CustomFetchSyncStrategy).not.toHaveBeenCalled();
  });

  it("returns CustomFetchSyncStrategy on mobile with override=custom (iOS rollback)", async () => {
    Platform.isMobile = true;
    const plugin = makePlugin({ syncStrategy: "custom" });
    await callCreateStrategy(plugin);
    expect(CustomFetchSyncStrategy).toHaveBeenCalled();
    expect(PouchDbSyncEngine).not.toHaveBeenCalled();
  });

  it("returns PouchDbSyncEngine on mobile with override=pouchdb", async () => {
    Platform.isMobile = true;
    const plugin = makePlugin({ syncStrategy: "pouchdb" });
    await callCreateStrategy(plugin);
    expect(PouchDbSyncEngine).toHaveBeenCalled();
    expect(CustomFetchSyncStrategy).not.toHaveBeenCalled();
  });

  it("defaults to auto (CustomFetch on desktop) when syncStrategy is undefined", async () => {
    const plugin = makePlugin({ syncStrategy: undefined });
    await callCreateStrategy(plugin);
    expect(CustomFetchSyncStrategy).toHaveBeenCalled();
    expect(PouchDbSyncEngine).not.toHaveBeenCalled();
  });

  it("passes settings to PouchDbSyncEngine when selected (as first arg)", async () => {
    Platform.isMobile = true;
    const plugin = makePlugin({ syncStrategy: "auto" });
    await callCreateStrategy(plugin);
    const calls = (PouchDbSyncEngine as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    // First arg should be the settings object
    expect(calls[0][0]).toMatchObject({
      couchDbUrl: expect.any(String),
      couchDbName: expect.any(String),
    });
  });
});
