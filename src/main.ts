import { Notice, Plugin } from "obsidian";
import { CouchClient } from "./couch-client";
import { SyncEngine } from "./sync-engine";
import { ObsidianVaultAdapter } from "./ObsidianVaultAdapter";
import { ObsidianStateStore } from "./ObsidianStateStore";
import { ObsidianTransport } from "./ObsidianTransport";
import { VaultSyncSettingTab } from "./settings-tab";
import type { VaultSyncSettings, SyncState, SyncCounts, SyncDiagnostics, FullSyncPlan } from "./types";
import { DEFAULT_SETTINGS, VAULT_SYNC_CONFIG_FILE } from "./types";
import { slugify } from "./slugify";

/**
 * Vault Sync - Lightweight CouchDB sync for Obsidian.
 *
 * Replaces PouchDB (135KB) with a custom fetch-based CouchDB client (~3KB).
 * Mobile-first design: long-poll instead of continuous replication,
 * debounced writes, minimal memory footprint.
 */
export default class VaultSyncPlugin extends Plugin {
  settings: VaultSyncSettings = { ...DEFAULT_SETTINGS };
  private syncEngine!: SyncEngine;
  private ribbonEl: HTMLElement | null = null;
  private statusBarEl: HTMLElement | null = null;
  private syncState: SyncState = "idle";
  private syncCounts: SyncCounts = { pendingPush: 0, pendingPull: 0 };
  private diagnosticsListeners: Set<() => void> = new Set();
  private startupTimer: ReturnType<typeof setTimeout> | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Auto-derive database name from vault name only when couchDbName is not set.
    // Running unconditionally would overwrite a user-configured DB name on every load.
    if (!this.settings.couchDbName) {
      this.settings.couchDbName = `vault-${slugify(this.app.vault.getName())}`;
      await this.saveSettings();
    }

    const vaultAdapter = new ObsidianVaultAdapter(this.app.vault);
    const stateStore = new ObsidianStateStore();
    const transport = new ObsidianTransport();
    this.syncEngine = new SyncEngine(this.settings, vaultAdapter, stateStore, transport);
    this.syncEngine.onStateChange = (state) => this.updateState(state);
    this.syncEngine.onCountsChange = (counts) => this.updateCounts(counts);
    this.syncEngine.onError = (msg) => this.handleSyncError(msg);
    this.syncEngine.onDiagnosticsChange = () => this.notifyDiagnosticsListeners();

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
      id: "force-full-sync",
      name: "Force full sync",
      callback: () => this.forceFullSync(),
    });

    // Register vault events for local change tracking.
    // Convert raw TAbstractFile → VaultEntry before delegating so syncEngine
    // receives the `kind` discriminator it requires (bug: raw TAbstractFile has
    // no `kind`, causing all local-change handlers to silently return).
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        const entry = vaultAdapter.getEntryByPath(file.path);
        if (entry) this.syncEngine.handleLocalChange(entry);
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        const entry = vaultAdapter.getEntryByPath(file.path);
        if (entry) this.syncEngine.handleLocalChange(entry);
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        const entry = vaultAdapter.getEntryByPath(file.path);
        if (entry) this.syncEngine.handleLocalDelete(entry);
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        const entry = vaultAdapter.getEntryByPath(file.path);
        if (entry) this.syncEngine.handleLocalRename(entry, oldPath);
      })
    );

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

  onunload(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    this.stopSync();
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
      data.syncDebounceMs = (data.debounceMs as number | undefined) ?? DEFAULT_SETTINGS.syncDebounceMs;
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
    this.syncEngine?.updateSettings(this.settings);
  }

  // --- Sync control ---

  private async startSync(): Promise<void> {
    if (this.syncEngine.isRunning()) return;
    await this.syncEngine.start();
  }

  private stopSync(): void {
    this.syncEngine.stop();
  }

  private toggleSync(): void {
    if (this.syncEngine.isRunning()) {
      this.stopSync();
      new Notice("Vault Sync stopped");
    } else {
      this.startSync();
      new Notice("Vault Sync starting...");
    }
  }

  /** Public: called from settings tab */
  async forceFullSync(): Promise<void> {
    // Delegate end-to-end to the engine — it owns stop/clearState/ensureDb/
    // fullSync({bypassOrphanGuard:true})/poll lifecycle. Routing through a
    // plain start() here drops the bypass flag and leaves revMap empty.
    await this.syncEngine.forceFullSync();
  }

  /**
   * Public: dry-run preview of what Force full sync would do.
   * Delegates to the engine with bypassOrphanGuard=true (matching forceFullSync behaviour).
   * Called from the settings tab "Preview Full sync" button.
   */
  async previewFullSync(): Promise<FullSyncPlan> {
    return this.syncEngine.planFullSync({ bypassOrphanGuard: true });
  }

  /** Public: diagnostics for settings tab observability on mobile */
  getDiagnostics(): SyncDiagnostics {
    return this.syncEngine.getDiagnostics();
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
    const client = new CouchClient(this.settings, new ObsidianTransport());
    return client.ping();
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
