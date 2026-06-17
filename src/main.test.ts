import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Plugin, Vault, TFile, SecretStorage } from "./__mocks__/obsidian";
import * as obsidianMock from "./__mocks__/obsidian";
import { DEFAULT_SETTINGS, VAULT_SYNC_CONFIG_FILE } from "./types";
import { SECRET_ID_COUCH_USER, SECRET_ID_COUCH_PASSWORD } from "./secret-store";
// Since v2.0 (issue #69) the plugin constructs PouchDbSyncEngine on every platform.
// The `SyncEngine` alias keeps the engine-agnostic test bodies below unchanged.
import { PouchDbSyncEngine as SyncEngine } from "./PouchDbSyncEngine";

// Import the plugin class — obsidian is aliased to the mock via vitest.config.ts
import VaultSyncPlugin from "./main";

vi.mock("./settings-tab", () => ({
  VaultSyncSettingTab: vi.fn().mockImplementation(() => ({})),
}));

// Mock pouchdb-browser to avoid loading the real bundle in the node test env
vi.mock("pouchdb-browser", () => ({
  default: vi.fn().mockImplementation(() => ({
    sync: vi.fn().mockReturnValue({ on: vi.fn().mockReturnThis(), cancel: vi.fn() }),
    replicate: { from: vi.fn().mockReturnValue({ on: vi.fn().mockReturnThis(), cancel: vi.fn() }) },
    info: vi.fn().mockResolvedValue({ doc_count: 0, update_seq: 0, db_name: "test" }),
    destroy: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("./PouchDbFsBridge", () => ({
  PouchDbFsBridge: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

// The plugin calls engine.updateSettings/forceFullSync/etc. — mock the engine so
// onload() runs without touching real PouchDB and so the test bodies can assert
// against the constructed instance via vi.mocked(SyncEngine).mock.results.
vi.mock("./PouchDbSyncEngine", () => ({
  PouchDbSyncEngine: vi.fn().mockImplementation(() => ({
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
    onNotice: null,
    getDiagnostics: vi.fn().mockReturnValue({}),
    getLocalDocCount: vi.fn().mockResolvedValue(0),
    replaceLocalFromServer: vi.fn().mockResolvedValue(undefined),
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
  const secretStorage = new SecretStorage();
  const plugin = Object.create(VaultSyncPlugin.prototype) as VaultSyncPlugin;
  // Wire up app the same way the Plugin mock does — incl. secretStorage (#78)
  (plugin as unknown as { app: { vault: Vault; secretStorage: SecretStorage } }).app = {
    vault,
    secretStorage,
  };
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
    // Falls back to default for other fields
    expect(plugin.settings.excludePatterns).toEqual(DEFAULT_SETTINGS.excludePatterns);
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
    // The guard must still fire on credentials alone (default URL kept).
    const legacyData = {
      couchDbUrl: DEFAULT_SETTINGS.couchDbUrl, // default URL kept
      couchDbName: "vault-obsidiannotes",
      couchDbUser: "alice",
      couchDbPassword: "secret",
      excludePatterns: [".trash/"],
    };
    (plugin.loadData as ReturnType<typeof vi.fn>).mockResolvedValue(legacyData);

    await plugin.loadSettings();

    // Migration fired despite the default URL...
    const written = plugin.app.vault.adapter._getStored(VAULT_SYNC_CONFIG_FILE);
    expect(written).toBeDefined();
    const parsed = JSON.parse(written!);
    expect(parsed.couchDbName).toBe("vault-obsidiannotes");
    // ...but with secretStorage AVAILABLE (the makePlugin default), the secret is
    // NOT written into the synced file (CWE-312) — it lives in the store instead.
    expect(parsed.couchDbUser).toBeUndefined();
    expect(parsed.couchDbPassword).toBeUndefined();

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

  it("PERSISTS gatewayUrl so a reload keeps the Clerk path (no silent downgrade to Basic)", async () => {
    // Regression: if gatewayUrl is dropped on save, a reload reads no gatewayUrl,
    // the creds resolver returns null, and the plugin silently falls back to the
    // legacy direct-CouchDB Basic-auth path while the user believes Clerk is active.
    plugin.settings.gatewayUrl = "https://mcp.fly-agile.com";

    await plugin.saveSettings();

    const parsed = JSON.parse(
      plugin.app.vault.adapter._getStored(VAULT_SYNC_CONFIG_FILE)!,
    );
    expect(parsed.gatewayUrl).toBe("https://mcp.fly-agile.com");
  });
});

// ---- Secret store: loadSettings precedence + Phase-A dual-read (#78) ----

describe("VaultSyncPlugin.loadSettings — secret store precedence (#78)", () => {
  let plugin: VaultSyncPlugin;

  beforeEach(() => {
    plugin = makePlugin();
  });

  function secretStorage(plugin: VaultSyncPlugin): SecretStorage {
    return (plugin as unknown as { app: { secretStorage: SecretStorage } }).app.secretStorage;
  }

  it("uses the secret-store secret over the legacy in-vault secret when both present", async () => {
    // In-vault file still carries a legacy secret...
    plugin.app.vault.adapter._setStored(
      VAULT_SYNC_CONFIG_FILE,
      JSON.stringify({
        couchDbUrl: "https://couch.example.com",
        couchDbName: "vault-x",
        couchDbUser: "legacy-user",
        couchDbPassword: "legacy-pass",
        excludePatterns: [],
      }),
    );
    // ...but the store holds the authoritative secret.
    secretStorage(plugin).setSecret(SECRET_ID_COUCH_USER, "store-user");
    secretStorage(plugin).setSecret(SECRET_ID_COUCH_PASSWORD, "store-pass");

    await plugin.loadSettings();

    expect(plugin.settings.couchDbUser).toBe("store-user");
    expect(plugin.settings.couchDbPassword).toBe("store-pass");
  });

  it("Phase A: copies a legacy in-vault secret INTO the store without deleting it from the file", async () => {
    plugin.app.vault.adapter._setStored(
      VAULT_SYNC_CONFIG_FILE,
      JSON.stringify({
        couchDbUrl: "https://couch.example.com",
        couchDbName: "vault-x",
        couchDbUser: "legacy-user",
        couchDbPassword: "legacy-pass",
        excludePatterns: [],
      }),
    );
    // Store starts empty — Phase A should populate it from the file.
    expect(secretStorage(plugin).getSecret(SECRET_ID_COUCH_USER)).toBeNull();

    await plugin.loadSettings();

    // Settings resolve from the legacy value (the only source available).
    expect(plugin.settings.couchDbUser).toBe("legacy-user");
    expect(plugin.settings.couchDbPassword).toBe("legacy-pass");

    // Phase A additive copy: store now has the secret...
    expect(secretStorage(plugin).getSecret(SECRET_ID_COUCH_USER)).toBe("legacy-user");
    expect(secretStorage(plugin).getSecret(SECRET_ID_COUCH_PASSWORD)).toBe("legacy-pass");

    // ...and the in-vault file STILL carries it (never deleted on load — invariant 2).
    const onDisk = JSON.parse(plugin.app.vault.adapter._getStored(VAULT_SYNC_CONFIG_FILE)!);
    expect(onDisk.couchDbUser).toBe("legacy-user");
    expect(onDisk.couchDbPassword).toBe("legacy-pass");
  });

  it("Phase A does NOT overwrite an existing store secret with the legacy in-vault value", async () => {
    plugin.app.vault.adapter._setStored(
      VAULT_SYNC_CONFIG_FILE,
      JSON.stringify({
        couchDbUrl: "https://couch.example.com",
        couchDbName: "vault-x",
        couchDbUser: "legacy-user",
        couchDbPassword: "legacy-pass",
        excludePatterns: [],
      }),
    );
    secretStorage(plugin).setSecret(SECRET_ID_COUCH_USER, "store-user");
    secretStorage(plugin).setSecret(SECRET_ID_COUCH_PASSWORD, "store-pass");

    await plugin.loadSettings();

    // Store value preserved (write-new only).
    expect(secretStorage(plugin).getSecret(SECRET_ID_COUCH_USER)).toBe("store-user");
    expect(secretStorage(plugin).getSecret(SECRET_ID_COUCH_PASSWORD)).toBe("store-pass");
  });
});

// ---- Secret store: data.json → .vault-sync.json migration write must not leak the secret (CWE-312, #78) ----

describe("VaultSyncPlugin.loadSettings — data.json migration write does not leak the secret (#78)", () => {
  let plugin: VaultSyncPlugin;

  beforeEach(() => {
    plugin = makePlugin();
  });

  function secretStorage(plugin: VaultSyncPlugin): SecretStorage {
    return (plugin as unknown as { app: { secretStorage: SecretStorage } }).app.secretStorage;
  }

  const legacyData = {
    couchDbUrl: "https://couch.example.com",
    couchDbName: "vault-mine",
    couchDbUser: "alice",
    couchDbPassword: "hunter2",
    excludePatterns: [".trash/"],
  };

  it("store AVAILABLE: writes a secret-stripped .vault-sync.json and copies the secret into the store", async () => {
    (plugin.loadData as ReturnType<typeof vi.fn>).mockResolvedValue({ ...legacyData });

    await plugin.loadSettings();

    // The synced file carries non-secret config but NOT the credentials (CWE-312).
    const written = plugin.app.vault.adapter._getStored(VAULT_SYNC_CONFIG_FILE);
    expect(written).toBeDefined();
    const parsed = JSON.parse(written!);
    expect(parsed.couchDbUrl).toBe("https://couch.example.com");
    expect(parsed.couchDbName).toBe("vault-mine");
    expect(parsed.couchDbUser).toBeUndefined();
    expect(parsed.couchDbPassword).toBeUndefined();

    // The secret is durably held in the store instead — nothing lost.
    expect(secretStorage(plugin).getSecret(SECRET_ID_COUCH_USER)).toBe("alice");
    expect(secretStorage(plugin).getSecret(SECRET_ID_COUCH_PASSWORD)).toBe("hunter2");

    // The engine boundary is unchanged: in-memory settings still carry the creds.
    expect(plugin.settings.couchDbUser).toBe("alice");
    expect(plugin.settings.couchDbPassword).toBe("hunter2");

    // data.json cleared as part of the migration.
    expect(plugin.saveData).toHaveBeenCalledWith({});
  });

  it("store UNAVAILABLE (feature-absent): keeps the legacy secret in the written file — graceful fallback, nothing lost", async () => {
    // Simulate an Obsidian runtime without secretStorage (pre-1.11.4 / sideload):
    // getSecretStore() feature-detects an absent store and degrades to isAvailable() === false.
    delete (plugin as unknown as { app: { secretStorage?: SecretStorage } }).app.secretStorage;
    (plugin.loadData as ReturnType<typeof vi.fn>).mockResolvedValue({ ...legacyData });

    await plugin.loadSettings();

    // No store to hold the secret → the migration write MUST keep the legacy
    // in-vault credential, otherwise it is lost entirely (auth lockout, invariant 7).
    const written = plugin.app.vault.adapter._getStored(VAULT_SYNC_CONFIG_FILE);
    expect(written).toBeDefined();
    const parsed = JSON.parse(written!);
    expect(parsed.couchDbUser).toBe("alice");
    expect(parsed.couchDbPassword).toBe("hunter2");

    // And the resolved in-memory creds are non-empty — nothing lost.
    expect(plugin.settings.couchDbUser).toBe("alice");
    expect(plugin.settings.couchDbPassword).toBe("hunter2");

    expect(plugin.saveData).toHaveBeenCalledWith({});
  });
});

// ---- Secret store: split saveSettings (non-secret) vs saveSecrets (store) (#78) ----

describe("VaultSyncPlugin.saveSettings — preserves on-disk legacy secret (#78)", () => {
  let plugin: VaultSyncPlugin;

  beforeEach(() => {
    plugin = makePlugin();
  });

  it("overwrites only non-secret keys and preserves the on-disk legacy secret verbatim", async () => {
    // Pre-existing file carries a legacy secret the daemon/old plugin still reads.
    plugin.app.vault.adapter._setStored(
      VAULT_SYNC_CONFIG_FILE,
      JSON.stringify({
        couchDbUrl: "https://old.example.com",
        couchDbName: "vault-old",
        couchDbUser: "ondisk-user",
        couchDbPassword: "ondisk-pass",
        excludePatterns: [".trash/"],
      }),
    );

    // In-memory settings have DIFFERENT (or empty) secret values — these must NOT
    // be written to the file. Only the non-secret keys change.
    plugin.settings = {
      couchDbUrl: "https://new.example.com",
      couchDbName: "vault-new",
      couchDbUser: "in-memory-user",
      couchDbPassword: "in-memory-pass",
      excludePatterns: [".trash/", ".obsidian/"],
    };

    await plugin.saveSettings();

    const onDisk = JSON.parse(plugin.app.vault.adapter._getStored(VAULT_SYNC_CONFIG_FILE)!);
    // Non-secret keys updated from in-memory settings.
    expect(onDisk.couchDbUrl).toBe("https://new.example.com");
    expect(onDisk.couchDbName).toBe("vault-new");
    expect(onDisk.excludePatterns).toEqual([".trash/", ".obsidian/"]);
    // Secret keys preserved verbatim from disk — NOT taken from in-memory settings.
    // This is the single most error-prone invariant: the naive "stringify minus
    // secrets" would have written in-memory values or stripped the on-disk secret.
    expect(onDisk.couchDbUser).toBe("ondisk-user");
    expect(onDisk.couchDbPassword).toBe("ondisk-pass");
  });

  it("does not introduce secret keys when the on-disk file has none (already scrubbed / Phase B done)", async () => {
    plugin.app.vault.adapter._setStored(
      VAULT_SYNC_CONFIG_FILE,
      JSON.stringify({
        couchDbUrl: "https://couch.example.com",
        couchDbName: "vault-x",
        excludePatterns: [],
      }),
    );
    plugin.settings = {
      couchDbUrl: "https://couch.example.com",
      couchDbName: "vault-x",
      couchDbUser: "in-memory-user",
      couchDbPassword: "in-memory-pass",
      excludePatterns: [],
    };

    await plugin.saveSettings();

    const onDisk = JSON.parse(plugin.app.vault.adapter._getStored(VAULT_SYNC_CONFIG_FILE)!);
    // The scrubbed file must stay scrubbed — saveSettings must not re-introduce
    // the in-memory secret onto disk.
    expect(onDisk.couchDbUser).toBeUndefined();
    expect(onDisk.couchDbPassword).toBeUndefined();
  });

  it("writes non-secret keys even when no file exists yet (fresh install)", async () => {
    plugin.settings = {
      couchDbUrl: "https://couch.example.com",
      couchDbName: "vault-fresh",
      couchDbUser: "u",
      couchDbPassword: "p",
      excludePatterns: [".trash/"],
    };

    await plugin.saveSettings();

    const onDisk = JSON.parse(plugin.app.vault.adapter._getStored(VAULT_SYNC_CONFIG_FILE)!);
    expect(onDisk.couchDbUrl).toBe("https://couch.example.com");
    expect(onDisk.couchDbName).toBe("vault-fresh");
    // No on-disk secret existed, so none is written.
    expect(onDisk.couchDbUser).toBeUndefined();
    expect(onDisk.couchDbPassword).toBeUndefined();
  });
});

describe("VaultSyncPlugin.saveSecrets — writes to the store, not the vault file (#78)", () => {
  let plugin: VaultSyncPlugin;

  beforeEach(() => {
    plugin = makePlugin();
  });

  function secretStorage(plugin: VaultSyncPlugin): SecretStorage {
    return (plugin as unknown as { app: { secretStorage: SecretStorage } }).app.secretStorage;
  }

  it("persists couchDbUser/couchDbPassword to the secret store", async () => {
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      couchDbUser: "alice",
      couchDbPassword: "hunter2",
    };

    await plugin.saveSecrets();

    expect(secretStorage(plugin).getSecret(SECRET_ID_COUCH_USER)).toBe("alice");
    expect(secretStorage(plugin).getSecret(SECRET_ID_COUCH_PASSWORD)).toBe("hunter2");
  });

  it("does NOT write the secret into .vault-sync.json", async () => {
    plugin.app.vault.adapter._setStored(
      VAULT_SYNC_CONFIG_FILE,
      JSON.stringify({
        couchDbUrl: "https://couch.example.com",
        couchDbName: "vault-x",
        excludePatterns: [],
      }),
    );
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      couchDbName: "vault-x",
      couchDbUser: "alice",
      couchDbPassword: "hunter2",
    };

    await plugin.saveSecrets();

    const onDisk = JSON.parse(plugin.app.vault.adapter._getStored(VAULT_SYNC_CONFIG_FILE)!);
    expect(onDisk.couchDbUser).toBeUndefined();
    expect(onDisk.couchDbPassword).toBeUndefined();
  });
});

// ---- Phase B scrub: migrate-secrets command (#78) ----

describe("VaultSyncPlugin.scrubInVaultSecrets — Phase B (#78)", () => {
  let plugin: VaultSyncPlugin;

  beforeEach(() => {
    plugin = makePlugin();
  });

  function secretStorage(plugin: VaultSyncPlugin): SecretStorage {
    return (plugin as unknown as { app: { secretStorage: SecretStorage } }).app.secretStorage;
  }

  it("removes couchDbUser/couchDbPassword from the file only after confirming the store has them, leaving the file otherwise intact", async () => {
    plugin.app.vault.adapter._setStored(
      VAULT_SYNC_CONFIG_FILE,
      JSON.stringify({
        couchDbUrl: "https://couch.example.com",
        couchDbName: "vault-x",
        couchDbUser: "alice",
        couchDbPassword: "hunter2",
        excludePatterns: [".trash/"],
      }),
    );
    // Store already holds the secret (write-before-delete precondition satisfied).
    secretStorage(plugin).setSecret(SECRET_ID_COUCH_USER, "alice");
    secretStorage(plugin).setSecret(SECRET_ID_COUCH_PASSWORD, "hunter2");

    const result = await plugin.scrubInVaultSecrets();
    expect(result.scrubbed).toBe(true);

    const onDisk = JSON.parse(plugin.app.vault.adapter._getStored(VAULT_SYNC_CONFIG_FILE)!);
    // Secret keys gone...
    expect(onDisk.couchDbUser).toBeUndefined();
    expect(onDisk.couchDbPassword).toBeUndefined();
    // ...non-secret keys untouched.
    expect(onDisk.couchDbUrl).toBe("https://couch.example.com");
    expect(onDisk.couchDbName).toBe("vault-x");
    expect(onDisk.excludePatterns).toEqual([".trash/"]);
  });

  it("does NOT scrub when the store is missing the secret (write-before-delete guard)", async () => {
    plugin.app.vault.adapter._setStored(
      VAULT_SYNC_CONFIG_FILE,
      JSON.stringify({
        couchDbUrl: "https://couch.example.com",
        couchDbName: "vault-x",
        couchDbUser: "alice",
        couchDbPassword: "hunter2",
        excludePatterns: [],
      }),
    );
    // Store has user but NOT password — incomplete, must not delete from file.
    secretStorage(plugin).setSecret(SECRET_ID_COUCH_USER, "alice");

    const result = await plugin.scrubInVaultSecrets();
    expect(result.scrubbed).toBe(false);

    const onDisk = JSON.parse(plugin.app.vault.adapter._getStored(VAULT_SYNC_CONFIG_FILE)!);
    // File secret preserved — never delete what the store can't yet serve.
    expect(onDisk.couchDbUser).toBe("alice");
    expect(onDisk.couchDbPassword).toBe("hunter2");
  });

  it("is a no-op (scrubbed=false) when the file already has no secret keys", async () => {
    plugin.app.vault.adapter._setStored(
      VAULT_SYNC_CONFIG_FILE,
      JSON.stringify({
        couchDbUrl: "https://couch.example.com",
        couchDbName: "vault-x",
        excludePatterns: [],
      }),
    );
    secretStorage(plugin).setSecret(SECRET_ID_COUCH_USER, "alice");
    secretStorage(plugin).setSecret(SECRET_ID_COUCH_PASSWORD, "hunter2");

    const result = await plugin.scrubInVaultSecrets();
    expect(result.scrubbed).toBe(false);
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

describe("VaultSyncPlugin.refreshIfVaultChanged (issue #56)", () => {
  // Symptom: on Obsidian iOS, switching vault A -> vault B keeps the diagnostics
  // panel showing vault A's values. iOS keeps the plugin instance alive across
  // vault switches (desktop reloads the plugin, masking the bug). The captured
  // syncEngine + adapter still point at vault A.
  //
  // Fix: plugin remembers the vault name it was initialized for. When asked to
  // refresh, it checks the current vault name; if different, it stops the old
  // engine and rebuilds one bound to the new vault.

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("recreates the SyncEngine when app.vault.getName() differs from the loaded name", async () => {
    const plugin = makePlugin();
    let currentVault = "vault-A";
    (plugin.app.vault as unknown as { getName(): string }).getName = () => currentVault;
    (plugin as unknown as { addRibbonIcon: unknown }).addRibbonIcon = vi.fn().mockReturnValue(makeEl());
    (plugin as unknown as { addStatusBarItem: unknown }).addStatusBarItem = vi.fn().mockReturnValue(makeEl());
    plugin.app.vault.on = vi.fn().mockReturnValue({ unload: () => {} }) as unknown as typeof plugin.app.vault.on;

    await plugin.onload();

    const initialEngineCount = vi.mocked(SyncEngine).mock.results.length;
    const initialEngine = vi.mocked(SyncEngine).mock.results.at(-1)!.value;

    // Simulate iOS vault switch: app.vault.getName() now returns vault-B,
    // but the plugin instance is unchanged.
    currentVault = "vault-B";

    const refreshed = await (plugin as unknown as { refreshIfVaultChanged: () => Promise<boolean> })
      .refreshIfVaultChanged();

    expect(refreshed).toBe(true);
    // A new SyncEngine instance was constructed
    expect(vi.mocked(SyncEngine).mock.results.length).toBeGreaterThan(initialEngineCount);
    // Previous engine was stopped
    expect(initialEngine.stop).toHaveBeenCalled();
  });

  it("is a no-op when the vault has not changed", async () => {
    const plugin = makePlugin();
    (plugin.app.vault as unknown as { getName(): string }).getName = () => "stable-vault";
    (plugin as unknown as { addRibbonIcon: unknown }).addRibbonIcon = vi.fn().mockReturnValue(makeEl());
    (plugin as unknown as { addStatusBarItem: unknown }).addStatusBarItem = vi.fn().mockReturnValue(makeEl());
    plugin.app.vault.on = vi.fn().mockReturnValue({ unload: () => {} }) as unknown as typeof plugin.app.vault.on;

    await plugin.onload();

    const engineCount = vi.mocked(SyncEngine).mock.results.length;
    const initialEngine = vi.mocked(SyncEngine).mock.results.at(-1)!.value;

    const refreshed = await (plugin as unknown as { refreshIfVaultChanged: () => Promise<boolean> })
      .refreshIfVaultChanged();

    expect(refreshed).toBe(false);
    // No new SyncEngine constructed
    expect(vi.mocked(SyncEngine).mock.results.length).toBe(engineCount);
    // Existing engine was not stopped
    expect(initialEngine.stop).not.toHaveBeenCalled();
  });

  it("notifies diagnostics listeners after vault switch so settings panel re-renders", async () => {
    const plugin = makePlugin();
    let currentVault = "vault-A";
    (plugin.app.vault as unknown as { getName(): string }).getName = () => currentVault;
    (plugin as unknown as { addRibbonIcon: unknown }).addRibbonIcon = vi.fn().mockReturnValue(makeEl());
    (plugin as unknown as { addStatusBarItem: unknown }).addStatusBarItem = vi.fn().mockReturnValue(makeEl());
    plugin.app.vault.on = vi.fn().mockReturnValue({ unload: () => {} }) as unknown as typeof plugin.app.vault.on;

    await plugin.onload();

    const listener = vi.fn();
    plugin.subscribeDiagnostics(listener);

    currentVault = "vault-B";
    await (plugin as unknown as { refreshIfVaultChanged: () => Promise<boolean> })
      .refreshIfVaultChanged();

    expect(listener).toHaveBeenCalled();
  });
});

describe("VaultSyncPlugin.replaceLocalFromServer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delegates to syncEngine.replaceLocalFromServer", async () => {
    const plugin = makePlugin();
    (plugin.app.vault as unknown as { getName(): string }).getName = () => "test-vault";
    (plugin as unknown as { addRibbonIcon: unknown }).addRibbonIcon = vi.fn().mockReturnValue(makeEl());
    (plugin as unknown as { addStatusBarItem: unknown }).addStatusBarItem = vi.fn().mockReturnValue(makeEl());
    plugin.app.vault.on = vi.fn().mockReturnValue({ unload: () => {} }) as unknown as typeof plugin.app.vault.on;

    await plugin.onload();

    const syncEngineInstance = vi.mocked(SyncEngine).mock.results.at(-1)!.value;

    await plugin.replaceLocalFromServer();

    expect(syncEngineInstance.replaceLocalFromServer).toHaveBeenCalled();
    // Must not fall back to a destructive alternative
    expect(syncEngineInstance.forceFullSync).not.toHaveBeenCalled();
    expect(syncEngineInstance.start).not.toHaveBeenCalled();
  });
});


// ---------------------------------------------------------------------------
// Clerk OAuth wiring (Stage 3): protocol handler, login, gateway resolver
// ---------------------------------------------------------------------------

import {
  SECRET_ID_GATEWAY_CLIENT_ID,
  SECRET_ID_GATEWAY_REFRESH_TOKEN,
} from "./secret-store";
import { OAUTH_PROTOCOL_ACTION } from "./plugin-login";

describe("VaultSyncPlugin — Clerk OAuth protocol handler registration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers the obsidian:// oauth-callback handler synchronously during onload", async () => {
    const plugin = makePlugin();
    (plugin.app.vault as unknown as { getName(): string }).getName = () => "v";
    (plugin as unknown as { addRibbonIcon: unknown }).addRibbonIcon = vi.fn().mockReturnValue(makeEl());
    (plugin as unknown as { addStatusBarItem: unknown }).addStatusBarItem = vi.fn().mockReturnValue(makeEl());
    plugin.app.vault.on = vi.fn().mockReturnValue({ unload: () => {} }) as unknown as typeof plugin.app.vault.on;
    const register = vi.fn();
    (plugin as unknown as { registerObsidianProtocolHandler: unknown }).registerObsidianProtocolHandler = register;

    await plugin.onload();

    expect(register).toHaveBeenCalledWith(OAUTH_PROTOCOL_ACTION, expect.any(Function));
  });
});

describe("VaultSyncPlugin — gateway creds resolver (plugin)", () => {
  function secretStorage(plugin: VaultSyncPlugin): SecretStorage {
    return (plugin as unknown as { app: { secretStorage: SecretStorage } }).app.secretStorage;
  }

  it("returns a fetch when gatewayUrl + client_id + refresh token are all present", async () => {
    const plugin = makePlugin();
    plugin.settings = { ...DEFAULT_SETTINGS, gatewayUrl: "https://mcp.fly-agile.com" };
    secretStorage(plugin).setSecret(SECRET_ID_GATEWAY_CLIENT_ID, "client_x");
    secretStorage(plugin).setSecret(SECRET_ID_GATEWAY_REFRESH_TOKEN, "rt-1");

    const resolver = (plugin as unknown as {
      buildGatewayCredsResolver(): () => Promise<typeof fetch | null>;
    }).buildGatewayCredsResolver();
    const fetchFn = await resolver();

    expect(typeof fetchFn).toBe("function");
  });

  it("returns null (Phase A legacy fallback) when no refresh token is stored", async () => {
    const plugin = makePlugin();
    plugin.settings = { ...DEFAULT_SETTINGS, gatewayUrl: "https://mcp.fly-agile.com" };
    secretStorage(plugin).setSecret(SECRET_ID_GATEWAY_CLIENT_ID, "client_x");
    // No refresh token stored.

    const resolver = (plugin as unknown as {
      buildGatewayCredsResolver(): () => Promise<typeof fetch | null>;
    }).buildGatewayCredsResolver();

    expect(await resolver()).toBeNull();
  });

  it("returns null when no client_id is available", async () => {
    const plugin = makePlugin();
    plugin.settings = { ...DEFAULT_SETTINGS, gatewayUrl: "https://mcp.fly-agile.com" };
    secretStorage(plugin).setSecret(SECRET_ID_GATEWAY_REFRESH_TOKEN, "rt-1");

    const resolver = (plugin as unknown as {
      buildGatewayCredsResolver(): () => Promise<typeof fetch | null>;
    }).buildGatewayCredsResolver();

    expect(await resolver()).toBeNull();
  });
});

describe("VaultSyncPlugin — logoutGateway", () => {
  function secretStorage(plugin: VaultSyncPlugin): SecretStorage {
    return (plugin as unknown as { app: { secretStorage: SecretStorage } }).app.secretStorage;
  }

  it("clears the stored client_id so isLoggedIntoGateway() returns false afterward", async () => {
    const plugin = makePlugin();
    plugin.settings = { ...DEFAULT_SETTINGS, gatewayUrl: "https://mcp.fly-agile.com" };
    secretStorage(plugin).setSecret(SECRET_ID_GATEWAY_CLIENT_ID, "client_x");
    secretStorage(plugin).setSecret(SECRET_ID_GATEWAY_REFRESH_TOKEN, "rt-1");

    // Stub rebuildEngine to avoid real engine construction.
    (plugin as unknown as { rebuildEngine: unknown }).rebuildEngine = vi.fn().mockResolvedValue(undefined);

    expect(await plugin.isLoggedIntoGateway()).toBe(true);

    await (plugin as unknown as { logoutGateway(): Promise<void> }).logoutGateway();

    expect(secretStorage(plugin).getSecret(SECRET_ID_GATEWAY_CLIENT_ID)).toBeNull();
    expect(secretStorage(plugin).getSecret(SECRET_ID_GATEWAY_REFRESH_TOKEN)).toBeNull();
    expect(await plugin.isLoggedIntoGateway()).toBe(false);
  });

  it("clears the transient login state so startClerkLogin re-runs DCR", async () => {
    const plugin = makePlugin();
    (plugin as unknown as { transientLogin: { codeVerifier: string; state: string } | null })
      .transientLogin = { codeVerifier: "v", state: "s" };
    (plugin as unknown as { rebuildEngine: unknown }).rebuildEngine = vi.fn().mockResolvedValue(undefined);

    await (plugin as unknown as { logoutGateway(): Promise<void> }).logoutGateway();

    expect(
      (plugin as unknown as { transientLogin: unknown }).transientLogin,
    ).toBeNull();
  });

  it("calls rebuildEngine so the gateway resolver picks up the cleared state on the next sync", async () => {
    const plugin = makePlugin();
    const rebuildSpy = vi.fn().mockResolvedValue(undefined);
    (plugin as unknown as { rebuildEngine: unknown }).rebuildEngine = rebuildSpy;

    await (plugin as unknown as { logoutGateway(): Promise<void> }).logoutGateway();

    expect(rebuildSpy).toHaveBeenCalledTimes(1);
  });
});

describe("VaultSyncPlugin — handleOAuthCallback completes login", () => {
  function secretStorage(plugin: VaultSyncPlugin): SecretStorage {
    return (plugin as unknown as { app: { secretStorage: SecretStorage } }).app.secretStorage;
  }

  it("validates state, exchanges the code, persists the refresh token, then rebuilds the engine", async () => {
    const plugin = makePlugin();
    plugin.settings = { ...DEFAULT_SETTINGS, gatewayUrl: "https://mcp.fly-agile.com" };
    secretStorage(plugin).setSecret(SECRET_ID_GATEWAY_CLIENT_ID, "client_x");

    // Seed a pending login transient (as startClerkLogin would).
    (plugin as unknown as {
      transientLogin: { codeVerifier: string; state: string } | null;
    }).transientLogin = { codeVerifier: "verifier-1", state: "state-1" };

    // Stub the token exchange network call.
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: "at", refresh_token: "rt-new", token_type: "Bearer", expires_in: 86400 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // Spy on engine rebuild.
    const rebuildSpy = vi.fn().mockResolvedValue(undefined);
    (plugin as unknown as { rebuildEngine: unknown }).rebuildEngine = rebuildSpy;
    (plugin as unknown as { onNoticeShown: unknown }).getDiagnostics = vi.fn();

    try {
      await (plugin as unknown as {
        handleOAuthCallback(params: Record<string, string>): Promise<void>;
      }).handleOAuthCallback({ action: OAUTH_PROTOCOL_ACTION, code: "auth-code", state: "state-1" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(secretStorage(plugin).getSecret(SECRET_ID_GATEWAY_REFRESH_TOKEN)).toBe("rt-new");
    expect(rebuildSpy).toHaveBeenCalled();
  });
});
