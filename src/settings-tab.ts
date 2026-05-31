import { App, Modal, PluginSettingTab, Setting } from "obsidian";
import type VaultSyncPlugin from "./main";
import type { SyncDiagnostics } from "./types";

/**
 * Settings tab for Vault Sync plugin.
 * Provides CouchDB connection configuration and sync behavior options.
 */
export class VaultSyncSettingTab extends PluginSettingTab {
  private diagnosticsEl: HTMLElement | null = null;
  // Cached <pre> element — reused across renders to avoid DOM teardown on mobile.
  private diagnosticsPre: HTMLElement | null = null;
  private unsubDiagnostics: (() => void) | null = null;

  constructor(app: App, private plugin: VaultSyncPlugin) {
    super(app, plugin);
  }

  hide(): void {
    // Clean up live update subscription when settings tab is closed.
    if (this.unsubDiagnostics) {
      this.unsubDiagnostics();
      this.unsubDiagnostics = null;
    }
  }

  display(): void {
    // On iOS Obsidian, vault switches don't reload the plugin (#56). Opening
    // the settings panel is the natural moment to detect and recover from
    // engine-vault drift. Fire-and-forget — UI builds immediately and the
    // engine rebuild notifies diagnostics listeners on its own.
    this.plugin.refreshIfVaultChanged?.().catch(() => { /* logged in handleSyncError */ });

    const { containerEl } = this;
    containerEl.empty();
    // containerEl.empty() destroys the previous <pre>; reset so renderDiagnostics
    // rebuilds the full DOM structure on next call.
    this.diagnosticsPre = null;

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
      .setName("Resume sync")
      .setDesc("Continue an interrupted sync without losing progress (recommended after network errors)")
      .addButton((btn) =>
        btn.setButtonText("Resume sync").onClick(async () => {
          btn.setButtonText("Syncing...");
          btn.setDisabled(true);
          try {
            await this.plugin.resumeFullSync();
            btn.setButtonText("Done");
          } catch {
            btn.setButtonText("Error");
          }
          setTimeout(() => {
            btn.setButtonText("Resume sync");
            btn.setDisabled(false);
          }, 2000);
        })
      );

    new Setting(containerEl)
      .setName("Merge with server")
      .setDesc("Push all local content + pull all server content. Conflicts resolved by last-modified. Local artifacts WILL be pushed to the server. Use when re-evaluating orphans or after DB swap.")
      .addButton((btn) =>
        btn.setButtonText("Merge").onClick(async () => {
          btn.setButtonText("Syncing...");
          btn.setDisabled(true);
          try {
            await this.plugin.forceFullSync();
            btn.setButtonText("Done");
          } catch {
            btn.setButtonText("Error");
          }
          setTimeout(() => {
            btn.setButtonText("Merge");
            btn.setDisabled(false);
          }, 2000);
        })
      );

    new Setting(containerEl)
      .setName("Replace local from server")
      .setDesc("Delete local files tracked by sync, then re-download from the server. Local files not yet synced will be LOST. Server is source of truth.")
      .addButton((btn) =>
        btn.setButtonText("Replace").onClick(async () => {
          let localCount: number | null = null;
          try {
            localCount = await this.plugin.getLocalDocCount();
          } catch {
            // Non-fatal: show modal without a count
          }
          new ReplaceConfirmModal(this.app, localCount, () => {
            this.plugin.replaceLocalFromServer();
          }).open();
        })
      );

    // --- Diagnostics section (provides observability on mobile) ---
    containerEl.createEl("h3", { text: "Diagnostics" });
    this.diagnosticsEl = containerEl.createEl("div", { cls: "vault-sync-diagnostics" });
    this.renderDiagnostics();

    // Subscribe to live updates while settings tab is open.
    // Render synchronously on every event — rAF coalescing was removed in #42
    // because rAF callbacks don't fire during sync on iOS Obsidian either.
    // The cached <pre> (diagnosticsPre) makes each render a cheap textContent
    // assignment, so synchronous rendering per event is affordable.
    if (this.unsubDiagnostics) this.unsubDiagnostics();
    const handler = () => this.renderDiagnostics();
    this.plugin.subscribeDiagnostics(handler);
    this.unsubDiagnostics = () => this.plugin.unsubscribeDiagnostics(handler);
  }

  private formatDiagnostics(d: SyncDiagnostics): string {
    const lines = [
      `Version: ${this.plugin.manifest.version}`,
      `Status: ${d.state}`,
      `Running: ${d.running ? "yes" : "no"}`,
    ];
    // Two-phase pull observability (#72). The phase is distinct from Status: at
    // text-ready/binary-backfill the vault is usable but Status honestly stays "syncing"
    // (binaries still pending), so this line carries the "notes ready" win without ever
    // letting Status read "Synced" while attachments are missing.
    lines.push(`Sync phase: ${d.syncPhase}`);
    if (d.syncPhase === "text-ready" || d.syncPhase === "binary-backfill") {
      lines.push("Notes ready — attachments syncing in background");
    }
    // Only render the count when an honest figure exists. Pattern B's live db.sync exposes
    // a combined text+binary `pending`, not an attachments-specific N/total, so binaryProgress
    // is null there — guard against it rather than fabricating a count (or emitting NaN).
    if (d.binaryProgress) {
      lines.push(`Attachments: ${d.binaryProgress.fetched} / ${d.binaryProgress.total}`);
    }
    if (d.pullProgress) {
      lines.push(`Pull progress: ${d.pullProgress.fetched} / ${d.pullProgress.total}`);
      lines.push(`Pull applied: ${d.pullApplied}`);
    }
    if (d.lastError) {
      lines.push(`Last error: ${d.lastError}`);
    }
    // Render timestamp -- empirical proof that renders are firing on the device.
    // If this value doesn't update during sync, the render path is broken upstream.
    lines.push(`Last render: ${new Date().toLocaleTimeString()}`);
    return lines.join("\n");
  }

  private renderDiagnostics(): void {
    if (!this.diagnosticsEl) return;
    const d = this.plugin.getDiagnostics();
    const text = this.formatDiagnostics(d);

    if (this.diagnosticsPre && this.diagnosticsPre.parentElement === this.diagnosticsEl) {
      // Fast path: element exists and is still attached -- just update the text.
      this.diagnosticsPre.textContent = text;
      return;
    }
    // Pre was detached (Obsidian DOM rebuild outside our control, or first render).
    // Clear the stale reference and fall through to the slow path which rebuilds it.
    this.diagnosticsPre = null;

    // First render after display(): build the full DOM structure and cache the <pre>.
    const pre = this.diagnosticsEl.createEl("pre", {
      cls: "vault-sync-diag-pre",
      text,
    });
    pre.style.userSelect = "text";
    pre.style.webkitUserSelect = "text";
    this.diagnosticsPre = pre;

    new Setting(this.diagnosticsEl)
      .addButton((btn) =>
        btn.setButtonText("Copy").onClick(() => {
          const copyText = this.formatDiagnostics(this.plugin.getDiagnostics());
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
            navigator.clipboard.writeText(copyText).then(
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

/**
 * Confirmation modal shown before the destructive "Replace local from server" action.
 * Requires explicit user confirmation before wiping local tracked files.
 * localCount is the real db.info() doc_count, or null if unavailable.
 */
class ReplaceConfirmModal extends Modal {
  constructor(app: App, private localCount: number | null, private onConfirm: () => void) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.createEl("h3", { text: "Replace local from server" });
    const countDesc = this.localCount !== null
      ? `This will delete ${this.localCount} local documents and re-download them from the server.`
      : "This will delete all locally synced documents and re-download them from the server.";
    this.contentEl.createEl("p", {
      text: `${countDesc} Local files not yet synced will be lost. Continue?`,
    });
    const btnRow = this.contentEl.createDiv({ cls: "modal-button-container" });
    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    cancelBtn.onclick = () => this.close();
    const confirmBtn = btnRow.createEl("button", { text: "Yes, replace local", cls: "mod-warning" });
    confirmBtn.onclick = () => {
      this.close();
      this.onConfirm();
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
