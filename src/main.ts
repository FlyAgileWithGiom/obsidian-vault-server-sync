import { Notice, Plugin, requestUrl } from "obsidian";
import type { PouchDbSyncEngine } from "./PouchDbSyncEngine";
import { ObsidianVaultAdapter } from "./ObsidianVaultAdapter";
import { VaultSyncSettingTab } from "./settings-tab";
import type { VaultSyncSettings, SyncState, SyncCounts, SyncDiagnostics } from "./types";
import { DEFAULT_SETTINGS, VAULT_SYNC_CONFIG_FILE } from "./types";
import { slugify } from "./slugify";

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
      this.startSync().catch((e) => this.handleSyncError((e as Error).message));
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

    // Build fetchServerDocIds for replaceLocalFromServer() orphan pruning (BUG-77).
    // Uses Obsidian's requestUrl API (not raw fetch) to call the remote CouchDB.
    // requestUrl bypasses CORS restrictions and works identically on desktop and
    // iOS without throwing on credential-in-URL requests (Fetch spec rejects those).
    // Credentials are passed as an Authorization header, never embedded in the URL.
    const { couchDbUrl, couchDbName, couchDbUser, couchDbPassword } = this.settings;
    const base = couchDbUrl.replace(/\/$/, "");
    const allDocsUrl = `${base}/${couchDbName}/_all_docs?include_docs=false`;
    const authHeader = (couchDbUser && couchDbPassword)
      ? `Basic ${btoa(`${couchDbUser}:${couchDbPassword}`)}`
      : undefined;
    const fetchServerDocIds = async (): Promise<string[]> => {
      const res = await requestUrl({
        url: allDocsUrl,
        method: "GET",
        headers: authHeader ? { Authorization: authHeader } : undefined,
      });
      if (res.status !== 200) throw new Error(`_all_docs fetch failed: ${res.status}`);
      const json = res.json as { rows: { id: string }[] };
      return json.rows.map((r) => r.id);
    };

    return new PouchDbSyncEngine(this.settings, db, bridge, dbFactory, fetchServerDocIds);
  }

  // --- Settings persistence ---

  async loadSettings(): Promise<void> {
    // Primary: read from .vault-sync.json at vault root
    try {
      const raw = await this.app.vault.adapter.read(VAULT_SYNC_CONFIG_FILE);
      try {
        const parsed = JSON.parse(raw);
        this.settings = Object.assign({}, DEFAULT_SETTINGS, parsed);
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
    const hasMeaningfulSettings =
      (this.settings.couchDbName && this.settings.couchDbName !== DEFAULT_SETTINGS.couchDbName) ||
      (this.settings.couchDbUser && this.settings.couchDbUser !== DEFAULT_SETTINGS.couchDbUser) ||
      (this.settings.couchDbPassword && this.settings.couchDbPassword !== DEFAULT_SETTINGS.couchDbPassword);
    if (hasMeaningfulSettings) {
      await this.app.vault.adapter.write(
        VAULT_SYNC_CONFIG_FILE,
        JSON.stringify(this.settings, null, 2)
      );
      await this.saveData({});
    }
  }

  async saveSettings(): Promise<void> {
    await this.app.vault.adapter.write(
      VAULT_SYNC_CONFIG_FILE,
      JSON.stringify(this.settings, null, 2)
    );
    this.strategy?.updateSettings(this.settings);
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
