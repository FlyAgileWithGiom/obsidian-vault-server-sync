import { App, PluginSettingTab, Setting } from "obsidian";
import { VaultSyncSettings } from "./types";

interface VaultSyncPlugin {
  settings: VaultSyncSettings;
  saveSettings(): Promise<void>;
}

export class VaultSyncSettingTab extends PluginSettingTab {
  plugin: VaultSyncPlugin;

  constructor(app: App, plugin: VaultSyncPlugin & { manifest: any }) {
    super(app, plugin as any);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Vault Sync Settings" });

    new Setting(containerEl)
      .setName("CouchDB URL")
      .setDesc("Base URL of your CouchDB instance.")
      .addText((text) =>
        text
          .setPlaceholder("https://host:5984")
          .setValue(this.plugin.settings.couchdbUrl)
          .onChange(async (value) => {
            this.plugin.settings.couchdbUrl = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Database")
      .setDesc("CouchDB database name.")
      .addText((text) =>
        text
          .setPlaceholder("vault-v2-prod")
          .setValue(this.plugin.settings.database)
          .onChange(async (value) => {
            this.plugin.settings.database = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Username")
      .setDesc("CouchDB username.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.username)
          .onChange(async (value) => {
            this.plugin.settings.username = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Password")
      .setDesc("CouchDB password.")
      .addText((text) => {
        text
          .setValue(this.plugin.settings.password)
          .onChange(async (value) => {
            this.plugin.settings.password = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });

    new Setting(containerEl)
      .setName("Debounce (ms)")
      .setDesc("Delay before syncing after a file change. Must be >= 0.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.debounceMs))
          .onChange(async (value) => {
            const parsed = parseInt(value, 10);
            if (!isNaN(parsed) && parsed >= 0) {
              this.plugin.settings.debounceMs = parsed;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Poll Interval (seconds)")
      .setDesc("How often to poll for remote changes. Must be >= 5.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.pollIntervalSec))
          .onChange(async (value) => {
            const parsed = parseInt(value, 10);
            if (!isNaN(parsed) && parsed >= 5) {
              this.plugin.settings.pollIntervalSec = parsed;
              await this.plugin.saveSettings();
            }
          })
      );
  }
}
