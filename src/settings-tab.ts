import { App, PluginSettingTab, Setting } from "obsidian";
import type VaultSyncPlugin from "./main";
import type { SyncDiagnostics, FullSyncPlan } from "./types";

/**
 * Settings tab for Vault Sync plugin.
 * Provides CouchDB connection configuration and sync behavior options.
 */
export class VaultSyncSettingTab extends PluginSettingTab {
  private diagnosticsEl: HTMLElement | null = null;
  // Cached <pre> element — reused across renders to avoid DOM teardown on mobile.
  private diagnosticsPre: HTMLElement | null = null;
  private unsubDiagnostics: (() => void) | null = null;
  // rAF-based coalescing flag: true while a requestAnimationFrame render is queued.
  // Paint-driven coalescing aligns with the browser render cycle and fires reliably
  // on iOS WKWebView where setTimeout can stall during engine bursts.
  private renderRafPending = false;
  private previewEl: HTMLElement | null = null;

  constructor(app: App, private plugin: VaultSyncPlugin) {
    super(app, plugin);
  }

  hide(): void {
    // Discard any queued rAF render so it doesn't fire after tab close.
    // The rAF callback captures renderRafPending by closure; resetting the flag
    // causes the callback to exit early even if the browser fires it late.
    this.renderRafPending = false;
    // Clean up live update subscription when settings tab is closed.
    if (this.unsubDiagnostics) {
      this.unsubDiagnostics();
      this.unsubDiagnostics = null;
    }
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    // containerEl.empty() destroys the previous <pre>; reset so renderDiagnostics
    // rebuilds the full DOM structure on next call.
    this.diagnosticsPre = null;
    // Defensive reset: if iOS resume-from-background skipped hide(), a stale
    // renderRafPending=true would permanently gate the next handler invocation.
    this.renderRafPending = false;

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
      .setName("Force full sync")
      .setDesc("Reset all sync state and re-fetch everything (destructive — use only after DB swap or to re-evaluate orphans/tombstones)")
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

    new Setting(containerEl)
      .setName("Preview Full sync (dry-run)")
      .setDesc("Show what Force full sync would do, without changing anything")
      .addButton((btn) =>
        btn.setButtonText("Preview").onClick(async () => {
          btn.setButtonText("Running...");
          btn.setDisabled(true);
          try {
            const plan = await this.plugin.previewFullSync();
            this.renderPreview(plan);
          } catch (e) {
            this.renderPreviewError((e as Error).message);
          }
          setTimeout(() => {
            btn.setButtonText("Preview");
            btn.setDisabled(false);
          }, 1000);
        })
      );

    this.previewEl = containerEl.createEl("div", { cls: "vault-sync-preview" });

    // --- Diagnostics section (provides observability on mobile) ---
    containerEl.createEl("h3", { text: "Diagnostics" });
    this.diagnosticsEl = containerEl.createEl("div", { cls: "vault-sync-diagnostics" });
    this.renderDiagnostics();

    // Subscribe to live updates while settings tab is open.
    // The engine fires onDiagnosticsChange per-doc during pulls (~20 events/batch).
    // Coalesce bursts with requestAnimationFrame so at most one render executes per
    // paint frame. rAF is more reliable than setTimeout on iOS WKWebView, where
    // timers can stall during heavy engine activity.
    if (this.unsubDiagnostics) this.unsubDiagnostics();
    const handler = () => {
      if (this.renderRafPending) return;
      this.renderRafPending = true;
      requestAnimationFrame(() => {
        this.renderRafPending = false;
        this.renderDiagnostics();
      });
    };
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
    // Render timestamp — empirical proof that renders are firing on the device.
    // If this value doesn't update during sync, the render path is broken upstream.
    lines.push(`Last render: ${new Date().toLocaleTimeString()}`);
    return lines.join("\n");
  }

  private formatPlan(plan: FullSyncPlan): string {
    function fmtBucket(bucket: { count: number; sample: string[] }): string {
      if (bucket.count === 0) return "0";
      const samples = bucket.sample.join(", ");
      return `${bucket.count} — ${samples}`;
    }

    return [
      "Dry-run Full sync preview",
      "=========================",
      `Would push (new):              ${fmtBucket(plan.wouldPushNew)}`,
      `Would push (changed):          ${fmtBucket(plan.wouldPushChanged)}`,
      `Would pull (rev diff):         ${fmtBucket(plan.wouldPullRevMismatch)}`,
      `Would skip (orphan guard):     ${fmtBucket(plan.wouldSkipOrphanGuard)}`,
      `Would tombstone local:         ${fmtBucket(plan.wouldTombstoneLocal)}`,
      `Would pull-delete:             ${fmtBucket(plan.wouldPullDelete)}`,
      `Would delete (server tombst.): ${fmtBucket(plan.wouldDeleteLocalTombstoned)}`,
      `Already tombstoned:            ${plan.alreadyTombstoned}`,
      `Already orphan:                ${plan.alreadyOrphan}`,
      `Oversize skipped:              ${plan.oversizeSkipped}`,
      `Excluded:                      ${plan.excludedCount}`,
      "",
      "Note: plan computed with bypassOrphanGuard=true (matches Force full sync).",
    ].join("\n");
  }

  private renderPreview(plan: FullSyncPlan): void {
    if (!this.previewEl) return;
    this.previewEl.empty();

    const text = this.formatPlan(plan);
    const pre = this.previewEl.createEl("pre", {
      cls: "vault-sync-diag-pre",
      text,
    });
    pre.style.userSelect = "text";
    pre.style.webkitUserSelect = "text";

    new Setting(this.previewEl)
      .addButton((btn) =>
        btn.setButtonText("Copy").onClick(() => {
          const range = document.createRange();
          range.selectNodeContents(pre);
          const sel = window.getSelection();
          if (sel) {
            sel.removeAllRanges();
            sel.addRange(range);
          }
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

  private renderPreviewError(message: string): void {
    if (!this.previewEl) return;
    this.previewEl.empty();
    this.previewEl.createEl("pre", {
      cls: "vault-sync-diag-pre",
      text: `Preview failed: ${message}`,
    });
  }

  private renderDiagnostics(): void {
    if (!this.diagnosticsEl) return;
    const d = this.plugin.getDiagnostics();
    const text = this.formatDiagnostics(d);

    if (this.diagnosticsPre && this.diagnosticsPre.parentElement === this.diagnosticsEl) {
      // Fast path: element exists and is still attached — just update the text.
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
