import { describe, it, expect, vi, beforeEach } from "vitest";
import { Plugin, Vault } from "./__mocks__/obsidian";
import { DEFAULT_SETTINGS, VAULT_SYNC_CONFIG_FILE } from "./types";

// Import the plugin class — obsidian is aliased to the mock via vitest.config.ts
import VaultSyncPlugin from "./main";

// The plugin uses syncEngine?.updateSettings — mock it so saveSettings doesn't throw
// when syncEngine is not initialised.
vi.mock("./sync-engine", () => ({
  SyncEngine: vi.fn().mockImplementation(() => ({
    isRunning: vi.fn().mockReturnValue(false),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    clearState: vi.fn(),
    updateSettings: vi.fn(),
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
  // Initialize settings field (mirrors class field declaration)
  plugin.settings = { ...DEFAULT_SETTINGS };
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

// ---- excludePatterns tests ----

describe("DEFAULT_SETTINGS.excludePatterns", () => {
  it("includes .vault-sync.json", () => {
    expect(DEFAULT_SETTINGS.excludePatterns).toContain(VAULT_SYNC_CONFIG_FILE);
  });

  it("includes .vault-sync-state.json", () => {
    expect(DEFAULT_SETTINGS.excludePatterns).toContain(".vault-sync-state.json");
  });
});
