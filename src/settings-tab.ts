import { App, PluginSettingTab, Setting } from "obsidian";
import type VaultSyncPlugin from "./main";
import type { SyncDiagnostics } from "./types";

/**
 * Settings tab for Vault Sync plugin.
 * Provides CouchDB connection configuration and sync behavior options.
 */
export class VaultSyncSettingTab extends PluginSettingTab {
  private diagnosticsEl: HTMLElement | null = null;
  private unsubDiagnostics: (() => void) | null = null;

  constructor(app: App, private plugin: VaultSyncPlugin) {
    super(app, plugin);
  }

  hide(): void {
    // Clean up live update subscription when settings tab is closed
    if (this.unsubDiagnostics) {
      this.unsubDiagnostics();
      this.unsubDiagnostics = null;
    }
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Vault Sync Settings" });

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("Vault Sync server address")
      .addText((text) =>
        text
          .setPlaceholder("https://sync.fly-agile.com")
          .setValue(this.plugin.settings.couchDbUrl)
          .onChange(async (value) => {
            this.plugin.settings.couchDbUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Database name")
      .setDesc("Name of the database for this vault")
      .addText((text) =>
        text
          .setPlaceholder("vault-v2-prod")
          .setValue(this.plugin.settings.couchDbName)
          .onChange(async (value) => {
            this.plugin.settings.couchDbName = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Username")
      .setDesc("Vault Sync username")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.couchDbUser)
          .onChange(async (value) => {
            this.plugin.settings.couchDbUser = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Password")
      .setDesc("Vault Sync password")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setValue(this.plugin.settings.couchDbPassword)
          .onChange(async (value) => {
            this.plugin.settings.couchDbPassword = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Sync debounce (ms)")
      .setDesc("Wait this long after a local change before syncing (reduces writes during typing)")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.syncDebounceMs))
          .onChange(async (value) => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num >= 0) {
              this.plugin.settings.syncDebounceMs = num;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Exclude patterns")
      .setDesc("Path prefixes to exclude from sync (one per line)")
      .addTextArea((text) =>
        text
          .setValue(this.plugin.settings.excludePatterns.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.excludePatterns = value
              .split("\n")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "Actions" });

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Verify the sync server is reachable")
      .addButton((btn) =>
        btn.setButtonText("Test").onClick(async () => {
          btn.setButtonText("Testing...");
          btn.setDisabled(true);
          try {
            const ok = await this.plugin.testConnection();
            btn.setButtonText(ok ? "Connected" : "Failed");
          } catch {
            btn.setButtonText("Error");
          }
          setTimeout(() => {
            btn.setButtonText("Test");
            btn.setDisabled(false);
          }, 2000);
        })
      );

    new Setting(containerEl)
      .setName("Force full sync")
      .setDesc("Re-sync all files (push local, pull remote)")
      .addButton((btn) =>
        btn.setButtonText("Full sync").onClick(async () => {
          btn.setButtonText("Syncing...");
          btn.setDisabled(true);
          try {
            await this.plugin.forceFullSync();
            btn.setButtonText("Done");
          } catch {
            btn.setButtonText("Error");
          }
          setTimeout(() => {
            btn.setButtonText("Full sync");
            btn.setDisabled(false);
          }, 2000);
        })
      );

    // --- Diagnostics section (provides observability on mobile) ---
    containerEl.createEl("h3", { text: "Diagnostics" });
    this.diagnosticsEl = containerEl.createEl("div", { cls: "vault-sync-diagnostics" });
    this.renderDiagnostics();

    // Subscribe to live updates while settings tab is open
    if (this.unsubDiagnostics) this.unsubDiagnostics();
    const handler = () => this.renderDiagnostics();
    this.plugin.subscribeDiagnostics(handler);
    this.unsubDiagnostics = () => this.plugin.unsubscribeDiagnostics(handler);
  }

  private formatDiagnostics(d: SyncDiagnostics): string {
    const lines = [
      `Status: ${d.state}`,
      `Running: ${d.running ? "yes" : "no"}`,
      `Tracked docs (revMap): ${d.revMapSize}`,
      `Last sequence: ${d.lastSeq}`,
      `Pending push: ${d.pendingPushCount}`,
    ];
    if (d.pullProgress) {
      lines.push(`Pull progress: ${d.pullProgress.fetched} / ${d.pullProgress.total}`);
      lines.push(`Pull applied: ${d.pullApplied}, skipped: ${d.pullSkipped}`);
    }
    if (d.lastError) {
      lines.push(`Last error: ${d.lastError}`);
    }
    return lines.join("\n");
  }

  private renderDiagnostics(): void {
    if (!this.diagnosticsEl) return;
    const d = this.plugin.getDiagnostics();
    this.diagnosticsEl.empty();

    const pre = this.diagnosticsEl.createEl("pre", {
      cls: "vault-sync-diag-pre",
      text: this.formatDiagnostics(d),
    });
    pre.style.userSelect = "text";
    pre.style.webkitUserSelect = "text";

    new Setting(this.diagnosticsEl)
      .addButton((btn) =>
        btn.setButtonText("Copy").onClick(() => {
          const text = this.formatDiagnostics(this.plugin.getDiagnostics());
          // Select text in pre element (works on mobile)
          const range = document.createRange();
          range.selectNodeContents(pre);
          const sel = window.getSelection();
          if (sel) {
            sel.removeAllRanges();
            sel.addRange(range);
          }
          // Try clipboard API, fallback to execCommand
          try {
            navigator.clipboard.writeText(text).then(
              () => { btn.setButtonText("Copied!"); },
              () => {
                document.execCommand("copy");
                btn.setButtonText("Copied!");
              }
            );
          } catch {
            document.execCommand("copy");
            btn.setButtonText("Copied!");
          }
          setTimeout(() => btn.setButtonText("Copy"), 1500);
        })
      );
  }
}
