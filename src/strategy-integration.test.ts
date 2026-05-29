/**
 * Smoke test for createStrategy().
 *
 * Since v2.0 (issue #69) the plugin constructs PouchDbSyncEngine on every
 * platform — the Platform.isMobile / syncStrategy branching is gone. This test
 * pins that single-path behaviour: createStrategy() always builds a
 * PouchDbSyncEngine, on desktop and mobile alike.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Platform } from "./__mocks__/obsidian";
import { DEFAULT_SETTINGS } from "./types";

// ---------------------------------------------------------------------------
// Mock heavy modules so createStrategy() can run without real Obsidian/PouchDB
// ---------------------------------------------------------------------------

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
      onNotice: null,
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
// Tests: createStrategy() builds PouchDbSyncEngine on every platform
// ---------------------------------------------------------------------------

describe("VaultSyncPlugin.createStrategy() — single PouchDB engine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Platform.isMobile = false;
  });

  afterEach(() => {
    Platform.isMobile = false;
  });

  it("constructs PouchDbSyncEngine on desktop", async () => {
    const plugin = makePlugin();
    await callCreateStrategy(plugin);
    expect(PouchDbSyncEngine).toHaveBeenCalled();
  });

  it("constructs PouchDbSyncEngine on mobile", async () => {
    Platform.isMobile = true;
    const plugin = makePlugin();
    await callCreateStrategy(plugin);
    expect(PouchDbSyncEngine).toHaveBeenCalled();
  });

  it("passes settings to PouchDbSyncEngine as the first constructor arg", async () => {
    const plugin = makePlugin();
    await callCreateStrategy(plugin);
    const calls = (PouchDbSyncEngine as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][0]).toMatchObject({
      couchDbUrl: expect.any(String),
      couchDbName: expect.any(String),
    });
  });
});
