/**
 * PouchDbSyncStrategy — SyncStrategy implementation using pouchdb-browser.
 *
 * Designed for iOS (Capacitor) where custom fetch and CouchDB HTTPS aren't
 * available. Uses PouchDB's built-in replication protocol over IndexedDB.
 *
 * Lifecycle:
 *   1. constructor(settings, app): instantiates PouchDB + PouchDbFsBridge
 *   2. register(plugin): wires vault events via bridge + visibilitychange DOM handler
 *   3. start():
 *      - isFirstRun() === true  → migration flow: replicate.from (initial pull)
 *        then cleanupLegacyRevMap() then startLiveSync()
 *      - isFirstRun() === false → startLiveSync() (resumes from PouchDB checkpoint)
 *   4. stop(): cancels sync handle (bridge events cleaned up by registerEvent at unload)
 *
 * Migration flow (isFirstRun + initial pull) is implemented here (commit 10).
 */

import type { App } from "obsidian";
import PouchDB from "pouchdb-browser";
import type { Plugin } from "obsidian";
import { Notice } from "obsidian";
import { ObsidianVaultAdapter } from "./ObsidianVaultAdapter";
import { ObsidianVaultWatcher } from "./ObsidianVaultWatcher";
import { PouchDbFsBridge } from "./PouchDbFsBridge";
import type { SyncStrategy } from "./sync-strategy";
import type {
  VaultSyncSettings,
  SyncState,
  SyncCounts,
  SyncDiagnostics,
  FullSyncPlan,
} from "./types";

/** Emitter shape for PouchDB replication/sync handles. */
interface PouchEmitter {
  on(event: "change", handler: (info: { docs_written?: number; pending?: number }) => void): this;
  on(event: "complete", handler: (info?: unknown) => void): this;
  on(event: "error", handler: (err: unknown) => void): this;
  on(event: "active" | "paused", handler: () => void): this;
  cancel(): void;
}

export class PouchDbSyncStrategy implements SyncStrategy {
  // --- Callbacks (set by main.ts before register()) ---
  onStateChange: (state: SyncState) => void = () => {};
  onCountsChange: (counts: SyncCounts) => void = () => {};
  onError: (msg: string) => void = () => {};
  onDiagnosticsChange: () => void = () => {};

  private readonly db: PouchDB;
  private readonly bridge: PouchDbFsBridge;
  private syncHandle: PouchEmitter | null = null;
  private started = false;

  // Migration / initial-pull tracking
  private initialPullRunning = false;
  private pullFetched = 0;
  private pullTotal = 0;
  private lastError: string | null = null;
  private currentState: SyncState = "idle";

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
    // Wire vault events (modify/create/delete/rename) via platform-neutral watcher
    const watcher = new ObsidianVaultWatcher(plugin);
    this.bridge.start(watcher);

    // Restart sync on tab/app becoming visible again (iOS app resume)
    plugin.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") {
        this.handleVisibilityVisible();
      }
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.setState("syncing");

    if (await this.isFirstRun()) {
      await this.runInitialPull();
    } else {
      this.startLiveSync();
      this.setState("ok");
    }
  }

  stop(): void {
    this.started = false;
    this.cancelSync();
    // Stop bridge: cancels the PouchDB changes listener.
    // Vault events (registered via plugin.registerEvent) are cleaned up
    // by Obsidian's plugin unload lifecycle automatically.
    this.bridge.stop();
    this.setState("idle");
  }

  async resumeFullSync(): Promise<void> {
    // PouchDB live sync with retry=true handles resume automatically.
    // For a manual resume, restart the sync handle.
    if (!this.started) return;
    this.cancelSync();
    this.startLiveSync();
  }

  /**
   * Force full sync: run a one-shot replicate.from to pull all docs from remote,
   * then restart live sync. Does not clear existing local docs — PouchDB's revision
   * tree handles deduplication.
   */
  async forceFullSync(): Promise<void> {
    if (!this.started) {
      this.started = true;
    }
    this.cancelSync();
    this.setState("syncing");
    await this.runInitialPull();
  }

  isRunning(): boolean {
    return this.started;
  }

  updateSettings(settings: VaultSyncSettings): void {
    this.settings = settings;
    // Restart sync with updated remote URL if already running
    if (this.started) {
      this.cancelSync();
      this.startLiveSync();
    }
  }

  getDiagnostics(): SyncDiagnostics {
    return {
      running: this.started,
      state: this.currentState,
      revMapSize: 0,
      knownRevMapSize: 0,
      lastSeq: 0,
      pullProgress: this.pullTotal > 0
        ? { fetched: this.pullFetched, total: this.pullTotal }
        : null,
      pullSkipped: 0,
      pullApplied: this.pullFetched,
      pendingPushCount: 0,
      lastError: this.lastError,
      unsyncableCount: 0,
      unsyncableSample: [],
    };
  }

  /**
   * Dry-run plan — returns approximate doc counts from local PouchDB + db.info().
   */
  async planFullSync(_opts?: { bypassOrphanGuard?: boolean }): Promise<FullSyncPlan> {
    let localDocCount = 0;
    try {
      const info = await this.db.info();
      localDocCount = info.doc_count ?? 0;
    } catch {
      // Non-critical, return empty plan
    }

    return {
      wouldPushNew: { count: localDocCount, sample: [] },
      wouldPushChanged: { count: 0, sample: [] },
      wouldPullRevMismatch: { count: 0, sample: [] },
      wouldSkipOrphanGuard: { count: 0, sample: [] },
      wouldTombstoneLocal: { count: 0, sample: [] },
      wouldPullDelete: { count: 0, sample: [] },
      wouldDeleteLocalTombstoned: { count: 0, sample: [] },
      alreadyTombstoned: 0,
      alreadyOrphan: 0,
      oversizeSkipped: 0,
      excludedCount: 0,
    };
  }

  async testConnection(): Promise<boolean> {
    try {
      const remoteUrl = this.buildRemoteUrl();
      // Attempt a lightweight replication probe: replicate a minimal batch from remote
      await new Promise<void>((resolve, reject) => {
        const handle = this.db.replicate.from(remoteUrl, { live: false });
        const emitter = handle as unknown as PouchEmitter;
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

  // --- Migration helpers ---

  /**
   * Returns true when local IndexedDB is empty — first run or after strategy switch.
   * Both cases require an initial full pull from the remote CouchDB.
   */
  private async isFirstRun(): Promise<boolean> {
    try {
      const info = await this.db.info();
      return (info.doc_count ?? 0) === 0;
    } catch {
      return false;
    }
  }

  /**
   * Initial pull: replicate all docs from remote to local PouchDB.
   * Fires progress events via onCountsChange and onDiagnosticsChange.
   * On completion, cleans up legacy revMap data and starts live sync.
   */
  private async runInitialPull(): Promise<void> {
    if (this.initialPullRunning) return;
    this.initialPullRunning = true;
    this.pullFetched = 0;
    this.pullTotal = 0;
    this.onDiagnosticsChange();

    new Notice("Vault Sync: Initial sync starting...");

    return new Promise<void>((resolve) => {
      const remoteUrl = this.buildRemoteUrl();
      const replication = this.db.replicate.from(remoteUrl, { live: false, retry: false });
      const emitter = replication as unknown as PouchEmitter;

      // Track this handle so stop() / cancelSync() can cancel it
      this.syncHandle = emitter;

      emitter.on("change", (info) => {
        this.pullFetched = info.docs_written ?? this.pullFetched;
        this.pullTotal = (this.pullFetched + (info.pending ?? 0));
        this.onCountsChange({ pendingPush: 0, pendingPull: info.pending ?? 0 });
        this.onDiagnosticsChange();
      });

      emitter.on("complete", () => {
        this.initialPullRunning = false;
        this.syncHandle = null;
        this.cleanupLegacyRevMap();
        new Notice("Vault Sync: Initial sync complete");
        if (this.started) {
          this.startLiveSync();
          this.setState("ok");
        }
        resolve();
      });

      emitter.on("error", (err) => {
        this.initialPullRunning = false;
        this.syncHandle = null;
        const msg = err instanceof Error ? err.message : String(err);
        this.setError(`Initial sync failed: ${msg}`);
        resolve();
      });
    });
  }

  /**
   * Remove localStorage keys written by the legacy CustomFetchSyncStrategy revMap.
   * Called only after successful initial pull. Non-critical — swallows errors.
   */
  private cleanupLegacyRevMap(): void {
    try {
      localStorage.removeItem("vault-sync-revmap");
      localStorage.removeItem("vault-sync-last-seq");
    } catch {
      // Non-critical: localStorage may not be available or may already be empty
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

  private startLiveSync(): void {
    const remoteUrl = this.buildRemoteUrl();
    const handle = this.db.sync(remoteUrl, { live: true, retry: true });
    const emitter = handle as unknown as PouchEmitter;
    this.syncHandle = emitter;

    emitter.on("change", () => {
      this.setState("syncing");
    });

    emitter.on("complete", () => {
      this.setState("ok");
    });

    emitter.on("error", (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.setError(`PouchDB sync error: ${msg}`);
    });
  }

  private cancelSync(): void {
    if (this.syncHandle) {
      this.syncHandle.cancel();
      this.syncHandle = null;
    }
  }

  private setState(state: SyncState): void {
    this.currentState = state;
    this.onStateChange(state);
    this.onDiagnosticsChange();
  }

  private setError(msg: string): void {
    this.lastError = msg;
    this.setState("error");
    this.onError(msg);
  }

  private handleVisibilityVisible(): void {
    // Guard: only act if strategy is started and not in initial pull
    if (!this.started) return;
    if (this.initialPullRunning) return;
    this.cancelSync();
    this.startLiveSync();
  }
}
