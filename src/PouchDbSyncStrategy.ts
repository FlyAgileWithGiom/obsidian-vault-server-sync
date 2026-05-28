/**
 * PouchDbSyncStrategy — SyncStrategy implementation using pouchdb-browser.
 *
 * Designed for iOS (Capacitor) where custom fetch and CouchDB HTTPS aren't
 * available. Uses PouchDB's built-in replication protocol over IndexedDB.
 *
 * Lifecycle:
 *   1. constructor(settings, app): instantiates PouchDB + PouchDbFsBridge
 *   2. register(plugin): wires vault events via bridge + visibilitychange DOM handler
 *   3. start(): begins db.sync(remoteUrl, {live, retry}); stores cancel handle
 *   4. stop(): cancels sync handle (bridge events cleaned up by registerEvent at unload)
 *
 * Not wired into main.ts until commit 10.
 */

import type { App } from "obsidian";
import PouchDB from "pouchdb-browser";
import type { Plugin } from "obsidian";
import { ObsidianVaultAdapter } from "./ObsidianVaultAdapter";
import { PouchDbFsBridge } from "./PouchDbFsBridge";
import type { SyncStrategy } from "./sync-strategy";
import type {
  VaultSyncSettings,
  SyncState,
  SyncCounts,
  SyncDiagnostics,
  FullSyncPlan,
} from "./types";

export class PouchDbSyncStrategy implements SyncStrategy {
  // --- Callbacks (set by main.ts before register()) ---
  onStateChange: (state: SyncState) => void = () => {};
  onCountsChange: (counts: SyncCounts) => void = () => {};
  onError: (msg: string) => void = () => {};
  onDiagnosticsChange: () => void = () => {};

  private readonly db: PouchDB;
  private readonly bridge: PouchDbFsBridge;
  private syncHandle: { cancel(): void } | null = null;
  private started = false;

  constructor(
    private settings: VaultSyncSettings,
    private readonly app: App,
  ) {
    const vaultAdapter = new ObsidianVaultAdapter(app.vault);
    const localDbName = `vault-sync-${settings.couchDbName}`;
    this.db = new PouchDB(localDbName);
    this.bridge = new PouchDbFsBridge(vaultAdapter, this.db);
  }

  // --- Lifecycle ---

  register(plugin: Plugin): void {
    // Wire vault events (modify/create/delete/rename) and PouchDB changes listener
    this.bridge.register(plugin);

    // Restart sync on tab/app becoming visible again (iOS app resume)
    plugin.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") {
        this.handleVisibilityVisible();
      }
    });
  }

  async start(): Promise<void> {
    this.started = true;
    this.onStateChange("syncing");
    this.startSync();
  }

  stop(): void {
    this.started = false;
    this.cancelSync();
    // Unregister bridge explicitly to cancel the PouchDB changes listener.
    // Vault EventRef handles are cleaned by plugin.registerEvent lifecycle at
    // plugin unload, but the PouchDB changes feed handle is not an Obsidian
    // EventRef — it must be cancelled explicitly.
    this.bridge.unregister();
  }

  async resumeFullSync(): Promise<void> {
    // PouchDB live sync with retry=true handles resume automatically.
    // For a manual resume, restart the sync handle.
    if (!this.started) return;
    this.cancelSync();
    this.startSync();
  }

  async forceFullSync(): Promise<void> {
    // Deferred to commit 10: full migration flow (isFirstRun detection, initial pull)
    throw new Error("PouchDbSyncStrategy.forceFullSync: deferred to commit 10");
  }

  isRunning(): boolean {
    return this.started;
  }

  updateSettings(settings: VaultSyncSettings): void {
    this.settings = settings;
    // Restart sync with updated remote URL if already running
    if (this.started) {
      this.cancelSync();
      this.startSync();
    }
  }

  getDiagnostics(): SyncDiagnostics {
    return {
      running: this.started,
      state: this.started ? "syncing" : "idle",
      revMapSize: 0,
      knownRevMapSize: 0,
      lastSeq: 0,
      pullProgress: null,
      pullSkipped: 0,
      pullApplied: 0,
      pendingPushCount: 0,
      lastError: null,
      unsyncableCount: 0,
      unsyncableSample: [],
    };
  }

  async planFullSync(_opts?: { bypassOrphanGuard?: boolean }): Promise<FullSyncPlan> {
    // Deferred to commit 10: doc counts approximated from local PouchDB allDocs
    throw new Error("PouchDbSyncStrategy.planFullSync: deferred to commit 10");
  }

  async testConnection(): Promise<boolean> {
    try {
      const remoteUrl = this.buildRemoteUrl();
      // Attempt a lightweight replication probe: replicate a minimal batch from remote
      await new Promise<void>((resolve, reject) => {
        const handle = this.db.replicate.from(remoteUrl, { live: false });
        const done = (handle as unknown as {
          on(event: string, handler: (...args: unknown[]) => void): void;
        }).on;
        const emitter = handle as unknown as {
          on(event: "complete", h: () => void): void;
          on(event: "error", h: (e: unknown) => void): void;
        };
        emitter.on("complete", () => resolve());
        emitter.on("error", (e) => reject(e));
        // Cancel after 5 seconds to avoid hanging
        setTimeout(() => { handle.cancel(); resolve(); }, 5000);
      });
      return true;
    } catch {
      return false;
    }
  }

  // --- Private helpers ---

  private buildRemoteUrl(): string {
    const { couchDbUrl, couchDbName, couchDbUser, couchDbPassword } = this.settings;
    if (couchDbUser && couchDbPassword) {
      const base = couchDbUrl.replace(/\/$/, "");
      const proto = base.startsWith("https://") ? "https://" : "http://";
      const host = base.slice(proto.length);
      return `${proto}${encodeURIComponent(couchDbUser)}:${encodeURIComponent(couchDbPassword)}@${host}/${couchDbName}`;
    }
    return `${couchDbUrl.replace(/\/$/, "")}/${couchDbName}`;
  }

  private startSync(): void {
    const remoteUrl = this.buildRemoteUrl();
    this.syncHandle = this.db.sync(remoteUrl, { live: true, retry: true });

    const emitter = this.syncHandle as unknown as {
      on(event: string, handler: (...args: unknown[]) => void): void;
    };

    emitter.on("change", () => {
      this.onStateChange("syncing");
    });

    emitter.on("complete", () => {
      this.onStateChange("ok");
    });

    emitter.on("error", (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.onError(`PouchDB sync error: ${msg}`);
      this.onStateChange("error");
    });
  }

  private cancelSync(): void {
    if (this.syncHandle) {
      this.syncHandle.cancel();
      this.syncHandle = null;
    }
  }

  private handleVisibilityVisible(): void {
    // Guard: only act if strategy is started
    if (!this.started) return;
    this.cancelSync();
    this.startSync();
  }
}
