import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Plugin, Vault, TFile } from "./__mocks__/obsidian";
import { DEFAULT_SETTINGS, VAULT_SYNC_CONFIG_FILE } from "./types";
import { CustomFetchSyncStrategy as SyncEngine } from "./sync-engine";

// Import the plugin class — obsidian is aliased to the mock via vitest.config.ts
import VaultSyncPlugin from "./main";

// The plugin uses syncEngine?.updateSettings — mock it so saveSettings doesn't throw
// when syncEngine is not initialised.
vi.mock("./sync-engine", () => ({
  CustomFetchSyncStrategy: vi.fn().mockImplementation(() => ({
    isRunning: vi.fn().mockReturnValue(false),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    clearState: vi.fn(),
    forceFullSync: vi.fn().mockResolvedValue(undefined),
    resumeFullSync: vi.fn().mockResolvedValue(undefined),
    updateSettings: vi.fn(),
    register: vi.fn(),
    handleLocalChange: vi.fn(),
    handleLocalDelete: vi.fn(),
    handleLocalRename: vi.fn(),
    onStateChange: null,
    onCountsChange: null,
    onError: null,
    onDiagnosticsChange: null,
    getDiagnostics: vi.fn().mockReturnValue({}),
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

/**
 * Helper: instantiate a bare VaultSyncPlugin without calling onload().
 * The Plugin base class constructor sets up app.vault; we then override
 * app.vault.adapter so each test gets a clean in-memory store.
 */
function makePlugin(): VaultSyncPlugin {
  // VaultSyncPlugin extends Plugin; the mock Plugin constructor is safe to call
  // but TypeScript requires manifest.  We bypass via Object.create + manual init.
  const vault = new Vault();
  const plugin = Object.create(VaultSyncPlugin.prototype) as VaultSyncPlugin;
  // Wire up app the same way the Plugin mock does
  (plugin as unknown as { app: { vault: Vault } }).app = { vault };
  // loadData / saveData come from Plugin base; mock them directly
  plugin.loadData = vi.fn().mockResolvedValue({});
  plugin.saveData = vi.fn().mockResolvedValue(undefined);
  // Initialize all class fields (Object.create skips class field initializers)
  plugin.settings = { ...DEFAULT_SETTINGS };
  const p = plugin as unknown as {
    syncState: string;
    syncCounts: { pendingPush: number; pendingPull: number };
    diagnosticsListeners: Set<() => void>;
    startupTimer: null;
    ribbonEl: null;
    statusBarEl: null;
  };
  p.syncState = "idle";
  p.syncCounts = { pendingPush: 0, pendingPull: 0 };
  p.diagnosticsListeners = new Set();
  p.startupTimer = null;
  p.ribbonEl = null;
  p.statusBarEl = null;
  return plugin;
}

// ---- loadSettings tests ----

describe("VaultSyncPlugin.loadSettings", () => {
  let plugin: VaultSyncPlugin;

  beforeEach(() => {
    plugin = makePlugin();
  });

  it("reads settings from .vault-sync.json when present", async () => {
    const stored = {
      couchDbUrl: "https://couch.example.com",
      couchDbName: "my-vault",
      couchDbUser: "alice",
      couchDbPassword: "secret",
      syncDebounceMs: 300,
      excludePatterns: [".trash/"],
    };
    plugin.app.vault.adapter._setStored(VAULT_SYNC_CONFIG_FILE, JSON.stringify(stored));

    await plugin.loadSettings();

    expect(plugin.settings.couchDbUrl).toBe("https://couch.example.com");
    expect(plugin.settings.couchDbName).toBe("my-vault");
    expect(plugin.settings.couchDbUser).toBe("alice");
    // loadData should NOT have been called — vault file was found
    expect(plugin.loadData).not.toHaveBeenCalled();
  });

  it("merges .vault-sync.json with DEFAULT_SETTINGS for missing fields", async () => {
    const partial = { couchDbUrl: "https://couch.example.com", couchDbName: "x" };
    plugin.app.vault.adapter._setStored(VAULT_SYNC_CONFIG_FILE, JSON.stringify(partial));

    await plugin.loadSettings();

    // Explicitly provided
    expect(plugin.settings.couchDbUrl).toBe("https://couch.example.com");
    // Falls back to default
    expect(plugin.settings.syncDebounceMs).toBe(DEFAULT_SETTINGS.syncDebounceMs);
  });

  it("falls back to data.json when .vault-sync.json is absent and uses DEFAULT_SETTINGS when data.json is empty", async () => {
    // adapter has no file — read will throw ENOENT
    (plugin.loadData as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await plugin.loadSettings();

    expect(plugin.settings).toEqual(DEFAULT_SETTINGS);
    expect(plugin.loadData).toHaveBeenCalledOnce();
  });

  it("falls back to DEFAULT_SETTINGS and logs warning when .vault-sync.json contains invalid JSON", async () => {
    plugin.app.vault.adapter._setStored(VAULT_SYNC_CONFIG_FILE, "{ bad json");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    (plugin.loadData as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await plugin.loadSettings();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(".vault-sync.json"));
    expect(plugin.settings).toEqual(DEFAULT_SETTINGS);
    warnSpy.mockRestore();
  });

  it("migrates data.json to .vault-sync.json when couchDbUrl is non-default and .vault-sync.json absent", async () => {
    const legacyData = {
      couchDbUrl: "https://couch.example.com",
      couchDbName: "vault-mine",
      couchDbUser: "bob",
      couchDbPassword: "pass",
      syncDebounceMs: 500,
      excludePatterns: [".trash/"],
    };
    (plugin.loadData as ReturnType<typeof vi.fn>).mockResolvedValue(legacyData);

    await plugin.loadSettings();

    // Settings correctly loaded
    expect(plugin.settings.couchDbUrl).toBe("https://couch.example.com");

    // .vault-sync.json written
    const written = plugin.app.vault.adapter._getStored(VAULT_SYNC_CONFIG_FILE);
    expect(written).toBeDefined();
    const parsed = JSON.parse(written!);
    expect(parsed.couchDbUrl).toBe("https://couch.example.com");

    // data.json cleared
    expect(plugin.saveData).toHaveBeenCalledWith({});
  });

  it("does NOT migrate when couchDbUrl equals the default placeholder", async () => {
    // data.json has only the default URL (unconfigured install)
    const data = { ...DEFAULT_SETTINGS };
    (plugin.loadData as ReturnType<typeof vi.fn>).mockResolvedValue(data);

    await plugin.loadSettings();

    expect(plugin.saveData).not.toHaveBeenCalled();
    expect(plugin.app.vault.adapter._has(VAULT_SYNC_CONFIG_FILE)).toBe(false);
  });

  it("migrates data.json to .vault-sync.json when user has credentials even if couchDbUrl is default", async () => {
    // Bug: previous migration guard was `couchDbUrl !== DEFAULT_SETTINGS.couchDbUrl`.
    // A user keeping the default URL but with credentials set would never migrate → settings lost on BRAT upgrade.
    const legacyData = {
      couchDbUrl: DEFAULT_SETTINGS.couchDbUrl, // default URL kept
      couchDbName: "vault-obsidiannotes",
      couchDbUser: "alice",
      couchDbPassword: "secret",
      syncDebounceMs: 500,
      excludePatterns: [".trash/"],
    };
    (plugin.loadData as ReturnType<typeof vi.fn>).mockResolvedValue(legacyData);

    await plugin.loadSettings();

    // Should have written to .vault-sync.json despite default URL
    const written = plugin.app.vault.adapter._getStored(VAULT_SYNC_CONFIG_FILE);
    expect(written).toBeDefined();
    const parsed = JSON.parse(written!);
    expect(parsed.couchDbUser).toBe("alice");

    // data.json cleared
    expect(plugin.saveData).toHaveBeenCalledWith({});
  });

  it("does NOT migrate when data.json has no meaningful settings (truly unconfigured)", async () => {
    // data.json has only defaults — no credentials, no DB name → no migration
    const data = { ...DEFAULT_SETTINGS, couchDbName: "", couchDbUser: "", couchDbPassword: "" };
    (plugin.loadData as ReturnType<typeof vi.fn>).mockResolvedValue(data);

    await plugin.loadSettings();

    expect(plugin.saveData).not.toHaveBeenCalled();
    expect(plugin.app.vault.adapter._has(VAULT_SYNC_CONFIG_FILE)).toBe(false);
  });
});

// ---- saveSettings tests ----

describe("VaultSyncPlugin.saveSettings", () => {
  let plugin: VaultSyncPlugin;

  beforeEach(() => {
    plugin = makePlugin();
    plugin.settings = {
      couchDbUrl: "https://couch.example.com",
      couchDbName: "vault-test",
      couchDbUser: "user",
      couchDbPassword: "pass",
      syncDebounceMs: 500,
      excludePatterns: [".trash/"],
    };
  });

  it("writes settings to .vault-sync.json", async () => {
    await plugin.saveSettings();

    const written = plugin.app.vault.adapter._getStored(VAULT_SYNC_CONFIG_FILE);
    expect(written).toBeDefined();
    const parsed = JSON.parse(written!);
    expect(parsed.couchDbUrl).toBe("https://couch.example.com");
    expect(parsed.couchDbName).toBe("vault-test");
  });

  it("does NOT call saveData (data.json is no longer the source of truth)", async () => {
    await plugin.saveSettings();

    expect(plugin.saveData).not.toHaveBeenCalled();
  });

  it("writes pretty-printed JSON", async () => {
    await plugin.saveSettings();

    const written = plugin.app.vault.adapter._getStored(VAULT_SYNC_CONFIG_FILE)!;
    // Pretty-printed JSON contains newlines
    expect(written).toContain("\n");
  });
});

// ---- onload DB name auto-derive tests ----

/** Helper DOM element stub used in onload tests */
function makeOnloadEl() {
  return {
    dataset: {} as Record<string, string>,
    setAttribute: vi.fn(),
    className: "",
    addClass: vi.fn(),
    setText: vi.fn(),
  };
}

describe("VaultSyncPlugin.onload — auto-derive couchDbName", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("derives couchDbName from vault name when couchDbName is empty (first install)", async () => {
    const plugin = makePlugin();
    plugin.app.vault.adapter._setStored(
      VAULT_SYNC_CONFIG_FILE,
      JSON.stringify({ ...DEFAULT_SETTINGS, couchDbName: "" })
    );
    (plugin.app.vault as unknown as { getName(): string }).getName = () => "MyNotes";
    (plugin as unknown as { addRibbonIcon: unknown }).addRibbonIcon = vi.fn().mockReturnValue(makeOnloadEl());
    (plugin as unknown as { addStatusBarItem: unknown }).addStatusBarItem = vi.fn().mockReturnValue(makeOnloadEl());
    plugin.app.vault.on = vi.fn().mockReturnValue({ unload: () => {} }) as unknown as typeof plugin.app.vault.on;

    await plugin.onload();

    expect(plugin.settings.couchDbName).toBe("vault-mynotes");
  });

  it("does NOT overwrite a user-configured couchDbName that differs from the derived value", async () => {
    // Bug: previous code overwrote couchDbName unconditionally on every onload.
    // A user who set couchDbName to a custom value would lose it on every plugin reload.
    const customDbName = "my-custom-db-name";
    const plugin = makePlugin();
    plugin.app.vault.adapter._setStored(
      VAULT_SYNC_CONFIG_FILE,
      JSON.stringify({
        couchDbUrl: "https://sync.fly-agile.com",
        couchDbName: customDbName,
        couchDbUser: "alice",
        couchDbPassword: "secret",
        syncDebounceMs: 500,
        excludePatterns: [".trash/"],
      })
    );
    (plugin.app.vault as unknown as { getName(): string }).getName = () => "MyNotes";
    (plugin as unknown as { addRibbonIcon: unknown }).addRibbonIcon = vi.fn().mockReturnValue(makeOnloadEl());
    (plugin as unknown as { addStatusBarItem: unknown }).addStatusBarItem = vi.fn().mockReturnValue(makeOnloadEl());
    plugin.app.vault.on = vi.fn().mockReturnValue({ unload: () => {} }) as unknown as typeof plugin.app.vault.on;

    await plugin.onload();

    // User's custom DB name must be preserved
    expect(plugin.settings.couchDbName).toBe(customDbName);
  });

  it("derives couchDbName when missing from loaded settings (fallback from old data.json)", async () => {
    const plugin = makePlugin();
    // .vault-sync.json absent; data.json has no couchDbName
    (plugin.loadData as ReturnType<typeof vi.fn>).mockResolvedValue({
      couchDbUrl: DEFAULT_SETTINGS.couchDbUrl,
      couchDbUser: "",
      couchDbPassword: "",
      syncDebounceMs: 500,
      excludePatterns: [],
    });
    (plugin.app.vault as unknown as { getName(): string }).getName = () => "VaultA";
    (plugin as unknown as { addRibbonIcon: unknown }).addRibbonIcon = vi.fn().mockReturnValue(makeOnloadEl());
    (plugin as unknown as { addStatusBarItem: unknown }).addStatusBarItem = vi.fn().mockReturnValue(makeOnloadEl());
    plugin.app.vault.on = vi.fn().mockReturnValue({ unload: () => {} }) as unknown as typeof plugin.app.vault.on;

    await plugin.onload();

    expect(plugin.settings.couchDbName).toBe("vault-vaulta");
  });
});

// ---- excludePatterns tests ----

describe("DEFAULT_SETTINGS.excludePatterns", () => {
  it("includes .vault-sync.json", () => {
    expect(DEFAULT_SETTINGS.excludePatterns).toContain(VAULT_SYNC_CONFIG_FILE);
  });

  it("includes .vault-sync-state.json", () => {
    expect(DEFAULT_SETTINGS.excludePatterns).toContain(".vault-sync-state.json");
  });
});

// ---- vault event handler tests ----

/** Minimal DOM element stub — avoids jsdom dependency in node test env */
function makeEl() {
  return {
    dataset: {} as Record<string, string>,
    setAttribute: vi.fn(),
    className: "",
    addClass: vi.fn(),
    setText: vi.fn(),
  };
}

describe("VaultSyncPlugin.forceFullSync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delegates to syncEngine.forceFullSync so the orphan guard is bypassed (revMap repopulates from remote)", async () => {
    // Bug: the previous flow (stop + clearState + startSync) called engine.start(),
    // which runs fullSync() without bypassOrphanGuard. With revMap freshly cleared,
    // Trou B (sync-engine.ts:683) skips every remote doc and revMap stays at 0
    // tracked while lastSeq still advances — matching the diagnostics the user
    // reported after pressing "Full sync" on a fresh vault.
    const plugin = makePlugin();
    (plugin.app.vault as unknown as { getName(): string }).getName = () => "test-vault";
    (plugin as unknown as { addRibbonIcon: unknown }).addRibbonIcon = vi.fn().mockReturnValue(makeEl());
    (plugin as unknown as { addStatusBarItem: unknown }).addStatusBarItem = vi.fn().mockReturnValue(makeEl());
    plugin.app.vault.on = vi.fn().mockReturnValue({ unload: () => {} }) as unknown as typeof plugin.app.vault.on;

    await plugin.onload();

    const syncEngineInstance = vi.mocked(SyncEngine).mock.results.at(-1)!.value;

    await plugin.forceFullSync();

    expect(syncEngineInstance.forceFullSync).toHaveBeenCalled();
    // Must NOT silently fall back to a plain start() — that path skips remote pulls on empty revMap.
    expect(syncEngineInstance.start).not.toHaveBeenCalled();
  });
});

describe("VaultSyncPlugin.resumeFullSync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delegates to syncEngine.resumeFullSync (non-destructive, preserves revMap)", async () => {
    const plugin = makePlugin();
    (plugin.app.vault as unknown as { getName(): string }).getName = () => "test-vault";
    (plugin as unknown as { addRibbonIcon: unknown }).addRibbonIcon = vi.fn().mockReturnValue(makeEl());
    (plugin as unknown as { addStatusBarItem: unknown }).addStatusBarItem = vi.fn().mockReturnValue(makeEl());
    plugin.app.vault.on = vi.fn().mockReturnValue({ unload: () => {} }) as unknown as typeof plugin.app.vault.on;

    await plugin.onload();

    const syncEngineInstance = vi.mocked(SyncEngine).mock.results.at(-1)!.value;

    await plugin.resumeFullSync();

    expect(syncEngineInstance.resumeFullSync).toHaveBeenCalled();
    // Must NOT call forceFullSync (which would clear revMap)
    expect(syncEngineInstance.forceFullSync).not.toHaveBeenCalled();
  });
});

describe("vault event handlers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delegates vault event registration to strategy.register() (Shape b)", async () => {
    const plugin = makePlugin();
    // vault.getName() is called in onload() to derive the DB name
    (plugin.app.vault as unknown as { getName(): string }).getName = () => "test-vault";

    // Stub DOM methods that onload() calls (node env has no document)
    (plugin as unknown as { addRibbonIcon: unknown }).addRibbonIcon = vi.fn().mockReturnValue(makeEl());
    (plugin as unknown as { addStatusBarItem: unknown }).addStatusBarItem = vi.fn().mockReturnValue(makeEl());

    await plugin.onload();

    // Get the SyncEngine instance created inside onload()
    const syncEngineInstance = vi.mocked(SyncEngine).mock.results.at(-1)!.value;

    // Shape b: strategy.register(plugin) is called so the strategy owns vault event subscriptions.
    // main.ts must NOT register vault events directly — that responsibility is in the strategy.
    expect(syncEngineInstance.register).toHaveBeenCalledWith(plugin);
  });
});

describe("VaultSyncPlugin.previewFullSync", () => {
  it("delegates to syncEngine.planFullSync with bypassOrphanGuard=true", async () => {
    const plugin = makePlugin();
    const mockPlan = {
      wouldPushNew: { count: 2, sample: ["a.md", "b.md"] },
      wouldPushChanged: { count: 0, sample: [] },
      wouldPullRevMismatch: { count: 1, sample: ["c.md"] },
      wouldSkipOrphanGuard: { count: 0, sample: [] },
      wouldTombstoneLocal: { count: 0, sample: [] },
      wouldPullDelete: { count: 0, sample: [] },
      wouldDeleteLocalTombstoned: { count: 0, sample: [] },
      alreadyTombstoned: 0,
      alreadyOrphan: 0,
      oversizeSkipped: 0,
      excludedCount: 1,
    };

    const planFullSync = vi.fn().mockResolvedValue(mockPlan);
    // Inject a mock syncEngine with planFullSync
    (plugin as unknown as { syncEngine: unknown }).syncEngine = {
      planFullSync,
    };

    const result = await plugin.previewFullSync();

    expect(planFullSync).toHaveBeenCalledWith({ bypassOrphanGuard: true });
    expect(result).toBe(mockPlan);
  });
});
