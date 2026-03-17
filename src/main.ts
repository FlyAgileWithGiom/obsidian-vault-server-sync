import { Plugin, TFile, TAbstractFile, setIcon, Notice } from "obsidian";
import { VaultSyncSettings, DEFAULT_SETTINGS } from "./types";
import { SyncEngine } from "./sync-engine";
import { ChangeQueue } from "./change-queue";
import { VaultSyncSettingTab } from "./settings";

interface PluginData {
  settings: VaultSyncSettings;
  queue: string; // serialized ChangeQueue
  lastSeq: string; // CouchDB sequence for polling
}

export default class VaultSyncPlugin extends Plugin {
  settings!: VaultSyncSettings;
  private syncEngine!: SyncEngine;
  private queue!: ChangeQueue;
  private ribbonEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    // 1. Load persisted data
    await this.loadSettings();

    // 2. Create ChangeQueue, restore from persisted data
    this.queue = new ChangeQueue();
    const data = await this.loadData() as PluginData | null;
    if (data?.queue) {
      try {
        const restored = ChangeQueue.deserialize(data.queue);
        // Copy items from restored queue
        for (const item of restored.peek()) {
          await this.queue.enqueue(item);
        }
      } catch (e) {
        console.error("Vault sync: failed to restore queue", e);
      }
    }

    // 3. Set persistence callback on queue
    this.queue.setOnChanged(async () => {
      await this.persistState();
    });

    // 4. Create SyncEngine
    this.syncEngine = new SyncEngine(this.app, this.settings, this.queue);
    this.syncEngine.setStatusCallback((status) => {
      this.updateRibbonState(status);
    });

    // Restore lastSeq
    if (data?.lastSeq) {
      this.syncEngine.setLastSeq(data.lastSeq);
    }

    // 5. Register vault events
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile) this.syncEngine.onLocalCreate(file);
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) this.syncEngine.onLocalModify(file);
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) this.syncEngine.onLocalDelete(file.path);
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) this.syncEngine.onLocalRename(file, oldPath);
      })
    );

    // 6. Settings tab
    this.addSettingTab(new VaultSyncSettingTab(this.app, this));

    // 7. Ribbon icon
    this.ribbonEl = this.addRibbonIcon("refresh-cw", "Vault Sync", async () => {
      // On click: force sync now
      await this.syncEngine.processQueue();
      new Notice("Vault Sync: manual sync triggered");
    });
    this.ribbonEl.addClass("vault-sync-ribbon");

    // 8. Commands
    this.addCommand({
      id: "vault-sync-bootstrap",
      name: "Bootstrap: push all local files to CouchDB",
      callback: () => this.syncEngine.bootstrapPush(),
    });

    this.addCommand({
      id: "vault-sync-force",
      name: "Force sync now",
      callback: async () => {
        await this.syncEngine.processQueue();
      },
    });

    // 9. Start sync engine
    if (this.settings.couchdbUrl) {
      await this.syncEngine.start();
    } else {
      this.updateRibbonState("not configured");
    }

    console.log("Vault Sync: loaded (v2.0.0)");
  }

  async onunload(): Promise<void> {
    this.syncEngine.stop();
    await this.persistState();
    console.log("Vault Sync: unloaded");
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData() as PluginData | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings);
  }

  async saveSettings(): Promise<void> {
    await this.persistState();
  }

  private async persistState(): Promise<void> {
    const data: PluginData = {
      settings: this.settings,
      queue: this.queue.serialize(),
      lastSeq: this.syncEngine?.getLastSeq() || "0",
    };
    await this.saveData(data);
  }

  private updateRibbonState(status: string): void {
    if (!this.ribbonEl) return;
    const s = status.toLowerCase();
    let state: string;
    let icon: string;

    if (s.includes("active") || s.includes("↑") || s.includes("↓") || s.includes("pushing") || s.includes("pulling")) {
      state = "syncing";
      icon = "refresh-cw";
    } else if (s.includes("in sync") || s.includes("idle") || s.includes("connected")) {
      state = "ok";
      icon = "check-circle";
    } else if (s.includes("error")) {
      state = "error";
      icon = "alert-circle";
    } else if (s.includes("not configured") || s.includes("stopped")) {
      state = "offline";
      icon = "wifi-off";
    } else {
      state = "ok";
      icon = "refresh-cw";
    }

    setIcon(this.ribbonEl, icon);
    this.ribbonEl.dataset.state = state;
    this.ribbonEl.ariaLabel = "Vault Sync: " + status;
  }
}
