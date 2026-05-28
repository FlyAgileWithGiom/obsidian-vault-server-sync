import type { VaultSyncSettings, SyncState, SyncCounts, SyncDiagnostics, FullSyncPlan } from "./types";
import type { Plugin } from "obsidian";

/**
 * SyncStrategy — top-level lifecycle port, one instance per plugin run.
 *
 * Sits above the transport and vault layers. CustomFetchSyncStrategy wraps the
 * existing SyncEngine; PouchDbSyncStrategy wraps pouchdb-browser + bridge layer.
 * Both expose this interface so main.ts is strategy-agnostic.
 *
 * Shape (b): the strategy owns its own vault event subscriptions.
 * main.ts does NOT register vault events — it calls strategy.register(this) instead.
 */
export interface SyncStrategy {
  // --- Callbacks (set by main.ts before register()) ---
  onStateChange: (state: SyncState) => void;
  onCountsChange: (counts: SyncCounts) => void;
  onError: (msg: string) => void;
  onDiagnosticsChange: () => void;

  // --- Lifecycle ---

  /**
   * Register vault event handlers and any DOM event handlers.
   * Called once after construction, before start().
   * CustomFetch: registers modify/create/delete/rename handlers.
   * PouchDB: delegates to PouchDbFsBridge.register().
   */
  register(plugin: Plugin): void;

  /** Start sync (initial full sync then polling/live replication). */
  start(): Promise<void>;

  /** Stop sync and clean up all timers, handles, and event refs. */
  stop(): void;

  /** Resume from last known checkpoint without clearing state. */
  resumeFullSync(): Promise<void>;

  /** Force full sync from scratch (clears revMap/seq/IndexedDB cursor). */
  forceFullSync(): Promise<void>;

  /** Returns true when sync loop is active. */
  isRunning(): boolean;

  // --- Settings ---

  /** Hot-reload settings without restarting. */
  updateSettings(settings: VaultSyncSettings): void;

  // --- Diagnostics & UI ---

  /** Snapshot of current sync state for settings tab. */
  getDiagnostics(): SyncDiagnostics;

  /**
   * Dry-run: returns what a forceFullSync would do without executing it.
   * CustomFetch: calls SyncEngine.planFullSync().
   * PouchDB: returns a simplified plan (PouchDB replication is managed internally;
   *          doc counts are approximated from local PouchDB allDocs).
   */
  planFullSync(opts?: { bypassOrphanGuard?: boolean }): Promise<FullSyncPlan>;

  /**
   * Test connectivity to CouchDB and return success/failure.
   * Used by settings tab "Test connection" button.
   */
  testConnection(): Promise<boolean>;
}
