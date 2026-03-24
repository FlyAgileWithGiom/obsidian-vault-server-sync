import { Notice, Plugin } from "obsidian";
import { CouchClient } from "./couch-client";
import { SyncEngine } from "./sync-engine";
import { VaultSyncSettingTab } from "./settings-tab";
import type { VaultSyncSettings, SyncState, SyncCounts } from "./types";
import { DEFAULT_SETTINGS } from "./types";

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

  async onload(): Promise<void> {
    await this.loadSettings();

    this.syncEngine = new SyncEngine(this.settings, this.app.vault);
    this.syncEngine.onStateChange = (state) => this.updateState(state);
    this.syncEngine.onCountsChange = (counts) => this.updateCounts(counts);
    this.syncEngine.onError = (msg) => this.handleSyncError(msg);

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

    // Register vault events for local change tracking
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        this.syncEngine.handleLocalChange(file);
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        this.syncEngine.handleLocalChange(file);
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.syncEngine.handleLocalDelete(file);
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.syncEngine.handleLocalRename(file, oldPath);
      })
    );

    // Auto-start if configured
    if (this.settings.couchDbUrl && this.settings.couchDbName) {
      // Delay start slightly to let Obsidian finish loading on mobile
      const STARTUP_DELAY_MS = 2000;
      setTimeout(() => this.startSync(), STARTUP_DELAY_MS);
    }
  }

  onunload(): void {
    this.stopSync();
  }

  // --- Settings persistence ---

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) || {};
    // Migrate from v0.1.x settings field names
    if (data.couchdbUrl && !data.couchDbUrl) {
      data.couchDbUrl = data.couchdbUrl;
      data.couchDbName = data.database;
      data.couchDbUser = data.username;
      data.couchDbPassword = data.password;
      data.syncDebounceMs = data.debounceMs ?? DEFAULT_SETTINGS.syncDebounceMs;
      delete data.couchdbUrl;
      delete data.database;
      delete data.username;
      delete data.password;
      delete data.debounceMs;
      delete data.maxBinarySize;
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.syncEngine.updateSettings(this.settings);
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
    if (!this.syncEngine.isRunning()) {
      await this.startSync();
    } else {
      await this.syncEngine.fullSync();
    }
  }

  /** Public: called from settings tab */
  async testConnection(): Promise<boolean> {
    const client = new CouchClient(this.settings);
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
