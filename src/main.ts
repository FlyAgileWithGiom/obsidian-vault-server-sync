import { Notice, Plugin } from "obsidian";
import type { PouchDbSyncEngine } from "./PouchDbSyncEngine";
import { scrubCredentials } from "./PouchDbSyncEngine";
import { ObsidianVaultAdapter } from "./ObsidianVaultAdapter";
import { VaultSyncSettingTab } from "./settings-tab";
import type { VaultSyncSettings, SyncState, SyncCounts, SyncDiagnostics } from "./types";
import { DEFAULT_SETTINGS, VAULT_SYNC_CONFIG_FILE } from "./types";
import { slugify } from "./slugify";
import type { SecretStore } from "./secret-store";
import {
  SecretStorageSecretStore,
  resolveSecret,
  SECRET_ID_COUCH_USER,
  SECRET_ID_COUCH_PASSWORD,
  ENV_COUCH_USER,
  ENV_COUCH_PASSWORD,
} from "./secret-store";

/**
 * Vault Sync - CouchDB replication for Obsidian.
 *
 * Uses PouchDbSyncEngine (PouchDB live replication) on every platform —
 * desktop and mobile — since v2.0 (issue #69).
 */
export default class VaultSyncPlugin extends Plugin {
  settings: VaultSyncSettings = { ...DEFAULT_SETTINGS };
  private strategy!: PouchDbSyncEngine;
  private ribbonEl: HTMLElement | null = null;
  private statusBarEl: HTMLElement | null = null;
  private syncState: SyncState = "idle";
  private syncCounts: SyncCounts = { pendingPush: 0, pendingPull: 0 };
  private diagnosticsListeners: Set<() => void> = new Set();
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Vault name the engine was last initialised for. On iOS Obsidian, switching
   * vault does NOT trigger onunload/onload, so the captured adapter + state keep
   * pointing at the old vault. refreshIfVaultChanged() compares this snapshot
   * to the live vault name and rebuilds the engine when they diverge (issue #56).
   */
  private engineVaultName: string = "";
  /**
   * Out-of-vault credential store (#78). Lazily built from `app.secretStorage`
   * on first use so tests can pre-inject a fake. Defaults to the real
   * SecretStorageSecretStore in production.
   */
  private secretStore: SecretStore | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Auto-derive database name from vault name only when couchDbName is not set.
    // Running unconditionally would overwrite a user-configured DB name on every load.
    if (!this.settings.couchDbName) {
      this.settings.couchDbName = `vault-${slugify(this.app.vault.getName())}`;
      await this.saveSettings();
    }

    this.strategy = await this.createStrategy();
    this.strategy.onStateChange = (state) => this.updateState(state);
    this.strategy.onCountsChange = (counts) => this.updateCounts(counts);
    this.strategy.onError = (msg) => this.handleSyncError(msg);
    this.strategy.onDiagnosticsChange = () => this.notifyDiagnosticsListeners();
    this.strategy.onNotice = (msg) => new Notice(msg);
    // Shape b: strategy registers its own vault event handlers
    this.strategy.register(this);
    this.engineVaultName = this.app.vault.getName();

    // Ribbon icon for sync toggle
    this.ribbonEl = this.addRibbonIcon("refresh-cw", "Vault Sync", () => {
      this.toggleSync();
    });
    this.updateRibbonState();

    // Status bar indicator (bottom bar, non-intrusive)
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("vault-sync-statusbar");
    this.updateStatusBar();

    // Settings tab
    this.addSettingTab(new VaultSyncSettingTab(this.app, this));

    // Commands
    this.addCommand({
      id: "start-sync",
      name: "Start sync",
      callback: () => this.startSync(),
    });

    this.addCommand({
      id: "stop-sync",
      name: "Stop sync",
      callback: () => this.stopSync(),
    });

    this.addCommand({
      id: "resume-sync",
      name: "Resume sync",
      callback: () => this.resumeFullSync(),
    });

    this.addCommand({
      id: "force-full-sync",
      name: "Force full sync",
      callback: () => this.forceFullSync(),
    });

    // "merge-with-server" is the preferred name for force-full-sync (semantically accurate).
    // The old "force-full-sync" id is kept so existing keybindings survive a rename.
    this.addCommand({
      id: "merge-with-server",
      name: "Merge with server",
      callback: () => this.forceFullSync(),
    });

    this.addCommand({
      id: "replace-local-from-server",
      name: "Replace local from server (destructive)",
      callback: () => this.replaceLocalFromServer(),
    });

    // Phase B scrub (#78): operator-gated removal of the legacy in-vault secret
    // once it is confirmed safe in the store. Never runs automatically.
    this.addCommand({
      id: "migrate-secrets",
      name: "Migrate secrets out of vault file (remove legacy credentials)",
      callback: async () => {
        const { scrubbed } = await this.scrubInVaultSecrets();
        new Notice(
          scrubbed
            ? "Vault Sync: legacy credentials removed from .vault-sync.json (now in the secret store)."
            : "Vault Sync: nothing to migrate — credentials not yet in the secret store, or already removed.",
        );
      },
    });

    // Auto-start if configured
    if (this.settings.couchDbUrl && this.settings.couchDbName) {
      // Delay start slightly to let Obsidian finish loading on mobile
      const STARTUP_DELAY_MS = 2000;
      this.startupTimer = setTimeout(() => {
        this.startupTimer = null;
        this.startSync();
      }, STARTUP_DELAY_MS);
    }
  }

  /**
   * Rebuild the strategy if the active vault has changed since onload.
   *
   * Obsidian iOS keeps the plugin instance alive across vault switches —
   * onunload/onload are not called. Without this check, the captured
   * strategy keeps pointing at the old vault. refreshIfVaultChanged() compares
   * this snapshot to the live vault name and rebuilds the strategy when they diverge.
   * See issue #56.
   *
   * Returns true when a rebuild happened, false otherwise.
   */
  async refreshIfVaultChanged(): Promise<boolean> {
    const current = this.app.vault.getName();
    if (current === this.engineVaultName) return false;

    this.strategy?.stop();
    await this.loadSettings();
    // Re-derive DB name for the new vault if user hasn't set one explicitly.
    if (!this.settings.couchDbName) {
      this.settings.couchDbName = `vault-${slugify(current)}`;
      await this.saveSettings();
    }
    this.strategy = await this.createStrategy();
    this.strategy.onStateChange = (state) => this.updateState(state);
    this.strategy.onCountsChange = (counts) => this.updateCounts(counts);
    this.strategy.onError = (msg) => this.handleSyncError(msg);
    this.strategy.onDiagnosticsChange = () => this.notifyDiagnosticsListeners();
    this.strategy.onNotice = (msg) => new Notice(msg);
    this.strategy.register(this);
    this.engineVaultName = current;
    this.notifyDiagnosticsListeners();

    // Auto-restart sync for the new vault if it's configured.
    if (this.settings.couchDbUrl && this.settings.couchDbName) {
      this.startSync().catch((e) => this.handleSyncError(scrubCredentials((e as Error).message ?? String(e))));
    }
    return true;
  }

  onunload(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    this.stopSync();
  }

  // --- Strategy factory ---

  /**
   * Creates the active sync engine. PouchDbSyncEngine is the single engine on
   * every platform (desktop and mobile) since v2.0 (issue #69).
   *
   * Dynamic import keeps pouchdb-browser (~130 KB) out of the main.js bundle.
   * esbuild splitting:true places it in a separate chunk loaded only when needed.
   */
  private async createStrategy(): Promise<PouchDbSyncEngine> {
    const PouchDB = (await import("pouchdb-browser")).default;
    const { PouchDbFsBridge } = await import("./PouchDbFsBridge");
    const { PouchDbSyncEngine } = await import("./PouchDbSyncEngine");
    const vaultAdapter = new ObsidianVaultAdapter(this.app.vault);
    const localDbName = `vault-sync-${this.settings.couchDbName}`;
    const dbFactory = () => new PouchDB(localDbName);
    const db = dbFactory();
    const bridge = new PouchDbFsBridge(vaultAdapter, db);

    return new PouchDbSyncEngine(this.settings, db, bridge, dbFactory);
  }

  // --- Settings persistence ---

  /**
   * Lazily resolve the secret store, defaulting to the runtime-backed
   * SecretStorageSecretStore. Tests inject a fake by pre-setting this.secretStore.
   */
  private getSecretStore(): SecretStore {
    if (!this.secretStore) {
      this.secretStore = new SecretStorageSecretStore(this.app);
    }
    return this.secretStore;
  }

  /**
   * iOS-safe process.env accessor. `process` is undefined on mobile Obsidian,
   * so guard the global before touching it (an unguarded read throws on the
   * exact platform the AC names).
   */
  private getProcessEnv(): Record<string, string | undefined> | undefined {
    return typeof process !== "undefined" ? process.env : undefined;
  }

  async loadSettings(): Promise<void> {
    // Primary: read from .vault-sync.json at vault root
    try {
      const raw = await this.app.vault.adapter.read(VAULT_SYNC_CONFIG_FILE);
      try {
        const parsed = JSON.parse(raw);
        this.settings = Object.assign({}, DEFAULT_SETTINGS, parsed);
        await this.applySecretStore();
        return;
      } catch {
        console.warn("[vault-sync] Failed to parse .vault-sync.json, falling back to data.json");
      }
    } catch {
      // File does not exist — fall through to data.json migration path
    }

    // Fallback: load from Obsidian's data.json
    const data = ((await this.loadData()) as Record<string, unknown> | null) || {};

    // Migrate from v0.1.x settings field names
    if (data.couchdbUrl && !data.couchDbUrl) {
      data.couchDbUrl = data.couchdbUrl;
      data.couchDbName = data.database;
      data.couchDbUser = data.username;
      data.couchDbPassword = data.password;
      delete data.couchdbUrl;
      delete data.database;
      delete data.username;
      delete data.password;
      delete data.debounceMs;
      delete data.maxBinarySize;
    }

    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);

    // Migrate data.json to .vault-sync.json when any meaningful setting is present.
    // Guard is intentionally broad: users who keep the default URL but have credentials
    // or a DB name set must still be migrated so BRAT upgrades don't wipe their settings.
    // Computed from the data.json-merged values, BEFORE applySecretStore() resolves
    // env/store precedence — so the decision to migrate is unaffected by where the
    // credential ultimately came from.
    const hasMeaningfulSettings =
      (this.settings.couchDbName && this.settings.couchDbName !== DEFAULT_SETTINGS.couchDbName) ||
      (this.settings.couchDbUser && this.settings.couchDbUser !== DEFAULT_SETTINGS.couchDbUser) ||
      (this.settings.couchDbPassword && this.settings.couchDbPassword !== DEFAULT_SETTINGS.couchDbPassword);

    // Run Phase A FIRST: durably copy any legacy in-vault secret into the store
    // (write-new) before we write .vault-sync.json. With the store available this
    // guarantees the secret is preserved out-of-vault, so the migration write can
    // safely omit it instead of leaking credentials into the synced file (CWE-312).
    await this.applySecretStore();

    if (hasMeaningfulSettings) {
      // When the secret store is available the secret now lives there, so strip
      // couchDbUser/couchDbPassword from the synced file. When the store is
      // unavailable (Obsidian < 1.11.4 / feature absent), keep the legacy in-vault
      // credential — stripping it would lose it entirely → auth lockout (invariant 7).
      let toWrite: object = this.settings;
      if (this.getSecretStore().isAvailable()) {
        const { couchDbUser: _user, couchDbPassword: _password, ...nonSecret } = this.settings;
        toWrite = nonSecret;
      }
      await this.app.vault.adapter.write(
        VAULT_SYNC_CONFIG_FILE,
        JSON.stringify(toWrite, null, 2)
      );
      await this.saveData({});
    }
  }

  /**
   * Resolve couchDbUser/couchDbPassword by precedence (env > store > legacy
   * in-vault) and assemble them into the in-memory settings, then run the Phase-A
   * additive migration (#78).
   *
   * Phase A is automatic and ADDITIVE ONLY: if the store lacks a secret but the
   * legacy in-vault value is present, copy it into the store (write-new). The
   * in-vault file is NEVER mutated here — the operator-gated Phase B scrub
   * (migrate-secrets) owns deletion. This lets an un-upgraded daemon/device that
   * still reads the in-vault secret keep working while new code reads the store.
   */
  private async applySecretStore(): Promise<void> {
    const store = this.getSecretStore();
    const env = this.getProcessEnv();

    // Legacy values currently sitting in the loaded (in-vault) settings.
    const legacyUser = this.settings.couchDbUser ?? "";
    const legacyPassword = this.settings.couchDbPassword ?? "";

    const resolvedUser = await resolveSecret({
      envName: ENV_COUCH_USER,
      env,
      store,
      id: SECRET_ID_COUCH_USER,
      legacy: legacyUser,
    });
    const resolvedPassword = await resolveSecret({
      envName: ENV_COUCH_PASSWORD,
      env,
      store,
      id: SECRET_ID_COUCH_PASSWORD,
      legacy: legacyPassword,
    });

    this.settings.couchDbUser = resolvedUser;
    this.settings.couchDbPassword = resolvedPassword;

    // Phase A — additive copy of a legacy in-vault secret into the store.
    // Write-new only: never overwrite an existing store secret, never delete
    // from the file.
    if (store.isAvailable()) {
      if (legacyUser && !(await store.get(SECRET_ID_COUCH_USER))) {
        await store.set(SECRET_ID_COUCH_USER, legacyUser);
      }
      if (legacyPassword && !(await store.get(SECRET_ID_COUCH_PASSWORD))) {
        await store.set(SECRET_ID_COUCH_PASSWORD, legacyPassword);
      }
    }
  }

  /**
   * Persist NON-SECRET config to .vault-sync.json (#78).
   *
   * Reads the existing file and overwrites only couchDbUrl/couchDbName/
   * excludePatterns, carrying any on-disk couchDbUser/couchDbPassword through
   * VERBATIM. The secret value is NEVER sourced from in-memory settings here:
   * doing so would either re-introduce the secret onto a scrubbed file or
   * (with the naive "stringify minus secrets") strip an un-upgraded consumer's
   * legacy credential — an accidental Phase B that breaks sync (invariant 1).
   * Secrets are written separately via saveSecrets() → the store.
   */
  async saveSettings(): Promise<void> {
    // Read whatever is currently on disk so we preserve its secret keys verbatim.
    let onDisk: Record<string, unknown> = {};
    try {
      const raw = await this.app.vault.adapter.read(VAULT_SYNC_CONFIG_FILE);
      onDisk = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // No file yet (fresh install) or unparseable — start from an empty object.
      onDisk = {};
    }

    // Overwrite only the non-secret keys from in-memory settings.
    onDisk.couchDbUrl = this.settings.couchDbUrl;
    onDisk.couchDbName = this.settings.couchDbName;
    onDisk.excludePatterns = this.settings.excludePatterns;
    // couchDbUser / couchDbPassword are intentionally left as found on disk —
    // present → preserved verbatim; absent → stay absent.

    await this.app.vault.adapter.write(
      VAULT_SYNC_CONFIG_FILE,
      JSON.stringify(onDisk, null, 2)
    );
    this.strategy?.updateSettings(this.settings);
  }

  /**
   * Persist the SECRET credentials to the out-of-vault store (#78), never to
   * .vault-sync.json. Called from the settings tab when the user edits the
   * username/password fields.
   */
  async saveSecrets(): Promise<void> {
    const store = this.getSecretStore();
    await store.set(SECRET_ID_COUCH_USER, this.settings.couchDbUser ?? "");
    await store.set(SECRET_ID_COUCH_PASSWORD, this.settings.couchDbPassword ?? "");
    // Propagate to the live engine so a credential change takes effect without
    // a restart (settings already hold the new value in memory).
    this.strategy?.updateSettings(this.settings);
  }

  /**
   * Phase B scrub (#78) — operator-gated, NEVER automatic.
   *
   * Strip couchDbUser/couchDbPassword from .vault-sync.json, write-BEFORE-delete:
   * only remove the in-vault secret after confirming BOTH credentials are present
   * in the store, so a device that lost its store value is never left unable to
   * authenticate. The file is otherwise left intact (non-secret keys untouched).
   *
   * Returns { scrubbed } so the command/UI can report the outcome. Extracted as a
   * standalone method (not buried in the command callback) for direct testing.
   */
  async scrubInVaultSecrets(): Promise<{ scrubbed: boolean }> {
    // Read the current file. No file → nothing to scrub.
    let onDisk: Record<string, unknown>;
    try {
      const raw = await this.app.vault.adapter.read(VAULT_SYNC_CONFIG_FILE);
      onDisk = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { scrubbed: false };
    }

    const hasFileSecret =
      onDisk.couchDbUser !== undefined || onDisk.couchDbPassword !== undefined;
    if (!hasFileSecret) {
      return { scrubbed: false };
    }

    // Write-before-delete: confirm the store can serve BOTH credentials first.
    const store = this.getSecretStore();
    const storeUser = await store.get(SECRET_ID_COUCH_USER);
    const storePassword = await store.get(SECRET_ID_COUCH_PASSWORD);
    if (!storeUser || !storePassword) {
      console.warn(
        "[vault-sync] migrate-secrets: store is missing a credential — refusing to scrub the in-vault secret (write-before-delete).",
      );
      return { scrubbed: false };
    }

    delete onDisk.couchDbUser;
    delete onDisk.couchDbPassword;
    await this.app.vault.adapter.write(
      VAULT_SYNC_CONFIG_FILE,
      JSON.stringify(onDisk, null, 2),
    );
    return { scrubbed: true };
  }

  // --- Sync control ---

  private async startSync(): Promise<void> {
    if (this.strategy.isRunning()) return;
    await this.strategy.start();
  }

  private stopSync(): void {
    this.strategy.stop();
  }

  private toggleSync(): void {
    if (this.strategy.isRunning()) {
      this.stopSync();
      new Notice("Vault Sync stopped");
    } else {
      this.startSync();
      new Notice("Vault Sync starting...");
    }
  }

  /** Public: called from settings tab and resume-sync command */
  async resumeFullSync(): Promise<void> {
    await this.strategy.resumeFullSync();
  }

  /** Public: called from settings tab */
  async forceFullSync(): Promise<void> {
    // Delegate end-to-end to the engine — it owns stop/clearState/ensureDb/
    // fullSync({bypassOrphanGuard:true})/poll lifecycle. Routing through a
    // plain start() here drops the bypass flag and leaves revMap empty.
    await this.strategy.forceFullSync();
  }

  /**
   * Public: DESTRUCTIVE — deletes all locally-tracked files then re-downloads from
   * the server. Use when local has artifacts that must not be pushed.
   * Called from the settings tab and from the replace-local-from-server command.
   */
  async replaceLocalFromServer(): Promise<void> {
    await this.strategy.replaceLocalFromServer();
  }

  /** Public: diagnostics for settings tab observability on mobile */
  getDiagnostics(): SyncDiagnostics {
    return this.strategy.getDiagnostics();
  }

  /** Public: real local doc count for Replace confirmation modal. */
  async getLocalDocCount(): Promise<number> {
    return this.strategy.getLocalDocCount();
  }

  subscribeDiagnostics(listener: () => void): void {
    this.diagnosticsListeners.add(listener);
  }

  unsubscribeDiagnostics(listener: () => void): void {
    this.diagnosticsListeners.delete(listener);
  }

  private notifyDiagnosticsListeners(): void {
    for (const listener of this.diagnosticsListeners) {
      listener();
    }
  }

  /** Public: called from settings tab */
  async testConnection(): Promise<boolean> {
    return this.strategy.testConnection();
  }

  // --- UI state ---

  private updateState(state: SyncState): void {
    this.syncState = state;
    this.updateRibbonState();
    this.updateStatusBar();
  }

  private updateRibbonState(): void {
    if (!this.ribbonEl) return;
    this.ribbonEl.dataset.state = this.syncState;
    this.ribbonEl.setAttribute("aria-label", `Vault Sync: ${this.syncState}`);
    // Apply CSS class from styles.css
    this.ribbonEl.className = this.ribbonEl.className
      .replace(/vault-sync-ribbon/g, "")
      .trim();
    this.ribbonEl.addClass("vault-sync-ribbon");
  }

  private static readonly STATUS_LABELS: Record<SyncState, string> = {
    "idle": "\u25CB Sync off",
    "syncing": "\u25D4 Syncing\u2026",
    "ok": "\u25CF Synced",
    "error": "\u25CF Sync error",
    "offline": "\u25CB Offline",
    "not-configured": "\u25CB Not configured",
  };

  private updateCounts(counts: SyncCounts): void {
    this.syncCounts = counts;
    this.updateStatusBar();
  }

  private updateStatusBar(): void {
    if (!this.statusBarEl) return;

    const label = VaultSyncPlugin.STATUS_LABELS[this.syncState];
    const { pendingPush, pendingPull } = this.syncCounts;
    const parts: string[] = [label];

    if (pendingPush > 0 || pendingPull > 0) {
      const counts: string[] = [];
      if (pendingPush > 0) counts.push(`\u2191${pendingPush}`);
      if (pendingPull > 0) counts.push(`\u2193${pendingPull}`);
      parts.push(counts.join(" "));
    }

    this.statusBarEl.setText(parts.join(" "));
    this.statusBarEl.dataset.state = this.syncState;
  }

  private handleSyncError(msg: string): void {
    console.error(`[vault-sync] ${msg}`);
    // Only show notice for non-transient errors to avoid notification spam on mobile
    if (!msg.includes("aborted") && !msg.includes("AbortError")) {
      new Notice(`Sync error: ${msg}`, 5000);
    }
  }
}
