/**
 * PouchDbSyncEngine — concrete sync implementation using PouchDB.
 *
 * Replaces PouchDbSyncStrategy (renamed in C05). Platform-neutral: accepts an
 * injected PouchDB instance and PouchDbFsBridge, so the same class works for
 * both the Obsidian plugin (pouchdb-browser) and the headless daemon (pouchdb-node).
 *
 * Construction:
 *   Plugin: src/main.ts creates pouchdb-browser db + ObsidianVaultAdapter + bridge,
 *           then calls register(plugin) to wire vault events + DOM visibilitychange.
 *   Daemon: headless/main.ts creates pouchdb-node db + FilesystemVaultAdapter + bridge,
 *           calls bridge.start(fsWatcher), then engine.start().
 *           register() is a no-op when not called (Obsidian APIs unavailable).
 *
 * Lifecycle:
 *   1. constructor(settings, db, bridge): stores injected deps
 *   2. register(plugin) [plugin path only]: wires vault events + visibilitychange
 *   3. start():
 *      - isFirstRun() === true  → migration flow: replicate.from (initial pull)
 *        then cleanupLegacyRevMap() then startLiveSync()
 *      - isFirstRun() === false → startLiveSync() (resumes from PouchDB checkpoint)
 *   4. stop(): cancels sync handle + stops bridge
 *
 * replaceLocalFromServer(): destroy local DB → re-create → runInitialPull().
 */

import type { Plugin } from "obsidian";
import type PouchDB from "pouchdb-browser";
import { ObsidianVaultWatcher } from "./ObsidianVaultWatcher";
import { PouchDbFsBridge } from "./PouchDbFsBridge";
import type {
  VaultSyncSettings,
  SyncState,
  SyncPhase,
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

/**
 * Two-phase initial pull (Refs #72). Server-side Mango selectors on `_attachments`,
 * validated against prod by spikes/mobile-text-first (phase-1 = 64 MB on the wire, not
 * 8 GB; zero `_attachments` docs locally after phase-1).
 *
 * Phase 1 pulls text docs only so the vault becomes usable in tens of MB. Phase 2 — the
 * binary backfill — is handled by the ordinary live `db.sync` (Pattern B): push stays
 * live from the first moment, and revs_diff skips the already-present text revs (measured:
 * 0 `_bulk_get` calls on a re-pull against a text-seeded DB), so binaries trickle in
 * without re-downloading text.
 */
// Exported so the unit test pins the exact server-side selector shape by reference identity:
// a typo (e.g. `$exist`) would silently fall back to a client-side filter, erasing the
// bandwidth win with no test signal unless this constant is the one thing both sides share.
// Pattern B pulls only text; the binary inverse ({_attachments:{$exists:true}}) is the
// unfiltered live db.sync's natural backlog, so the engine needs no BINARY_SELECTOR const.
export const TEXT_SELECTOR = { _attachments: { $exists: false } } as const;

// SyncPhase (distinct from SyncState) is declared in ./types so the diagnostics consumer
// and the engine share one definition. State must NOT read "ok" while binaries backfill.

export class PouchDbSyncEngine {
  // --- Callbacks (set by main.ts before register()) ---
  onStateChange: (state: SyncState) => void = () => {};
  onCountsChange: (counts: SyncCounts) => void = () => {};
  onError: (msg: string) => void = () => {};
  onDiagnosticsChange: () => void = () => {};
  onNotice: ((msg: string) => void) | undefined = undefined;

  private syncHandle: PouchEmitter | null = null;
  private started = false;

  // Migration / initial-pull tracking
  private initialPullRunning = false;
  private pullFetched = 0;
  private pullTotal = 0;
  private lastError: string | null = null;
  private currentState: SyncState = "idle";

  // Two-phase sync tracking (Refs #72)
  private syncPhase: SyncPhase = "idle";
  /**
   * Last `pending` count seen on a live-sync `change` event. The combined `db.sync`
   * handle emits a no-arg `paused` BOTH when caught up AND on error-backoff (push is
   * idle during the backfill, so any pull hiccup coalesces to a no-arg pause). The
   * server-reported `pending` is the only reliable discriminator: a genuine caught-up
   * pause follows the feed draining to 0; an error-backoff pause leaves pending > 0.
   */
  private liveSyncPending = 0;

  constructor(
    private settings: VaultSyncSettings,
    private db: PouchDB,
    private readonly bridge: PouchDbFsBridge,
    private readonly dbFactory?: () => PouchDB,
  ) {}

  // --- Lifecycle ---

  /**
   * Register vault event handlers and visibilitychange DOM handler (plugin path).
   * Creates ObsidianVaultWatcher and calls bridge.start(watcher).
   *
   * In daemon mode, the caller manages the watcher externally:
   *   bridge.start(fsWatcher) is called before engine.start().
   */
  register(plugin: Plugin): void {
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

  /**
   * DESTRUCTIVE: destroy local PouchDB, create a fresh instance, then re-pull all
   * docs from the remote. Matches the "Replace local from server" Obsidian command.
   * Decision D5 in v2-unify-pouchdb-plan.md.
   *
   * Requires dbFactory to be provided at construction time. Without it the engine
   * cannot create a fresh PouchDB instance and will throw rather than silently
   * operating on the destroyed database.
   */
  async replaceLocalFromServer(): Promise<void> {
    // Guard before touching the db — if factory is absent, fail loudly early.
    if (!this.dbFactory) {
      throw new Error(
        "[vault-sync] replaceLocalFromServer: dbFactory is required but was not provided. " +
        "Pass a dbFactory (() => PouchDB) to the PouchDbSyncEngine constructor.",
      );
    }
    this.cancelSync();
    // Reset in-flight pull flag so runInitialPull is not a no-op on a fresh db.
    this.initialPullRunning = false;
    this.setState("syncing");
    try {
      await (this.db as unknown as { destroy(): Promise<void> }).destroy();
    } catch (e) {
      // Non-fatal: log and continue — we are creating a fresh instance regardless.
      console.warn("[vault-sync] replaceLocalFromServer: db.destroy() failed:", e);
    }
    // Recreate the db and propagate the new instance to the bridge so its
    // changes listener and all subsequent db.put/db.get calls use the fresh db.
    this.db = this.dbFactory();
    this.bridge.setDb(this.db);
    this.started = true;
    await this.runInitialPull();
    // runInitialPull's complete handler calls startLiveSync() + setState("ok").
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
      // avg*/...SampleCount belonged to the retired per-doc-timing PouchDbSyncStrategy; the
      // engine has no such instrumentation. Report null/0 (not NaN) so the UI renders cleanly.
      avgFetchMs: null,
      fetchSampleCount: 0,
      avgApplyMs: null,
      applySampleCount: 0,
      // Two-phase initial-pull observability (Refs #72).
      syncPhase: this.syncPhase,
      // Pattern B has no binary-specific counter (live db.sync `pending` is combined
      // text+binary), so no honest N/total is available — null, not a fabricated count.
      binaryProgress: null,
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
   * Returns true when local DB is empty — first run or after strategy switch.
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
   * Initial pull, two-phase (Refs #72, Pattern B).
   *
   * Phase 1 (blocking, fast): pull TEXT docs only via a server-side `selector` filter, so
   * the vault is usable in tens of MB rather than waiting on the full ~8 GB. On completion
   * the phase becomes "text-ready" and live sync starts — state deliberately stays
   * "syncing", never "ok", because the binaries are not here yet.
   *
   * Phase 2 (background, non-blocking, resumable): the binary backfill is just the natural
   * pull backlog of the live `db.sync` started here. Push is live from this moment, and
   * revs_diff skips the already-present text revs, so no text is re-downloaded.
   *
   * Routes through all three callers (start / forceFullSync / replaceLocalFromServer):
   * one split, three beneficiaries.
   */
  private async runInitialPull(): Promise<void> {
    if (this.initialPullRunning) return;
    this.initialPullRunning = true;
    this.pullFetched = 0;
    this.pullTotal = 0;
    this.setPhase("text-pull");

    this.onNotice?.("Vault Sync: Downloading notes...");

    return new Promise<void>((resolve) => {
      const remoteUrl = this.buildRemoteUrl();
      // checkpoint:'target' keeps the replication checkpoint on the local DB (resumable
      // phase, simplest correct choice). selector is the server-side text filter.
      const replication = this.db.replicate.from(remoteUrl, {
        live: false,
        retry: false,
        selector: TEXT_SELECTOR,
        checkpoint: "target",
      });
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
        // Phase-1 done: notes are usable. State stays "syncing" (binaries pending) — the
        // phase, not the state, carries the "ready" signal so the UI never lies "Synced".
        this.setPhase("text-ready");
        this.onNotice?.("Vault Sync: Notes ready, attachments downloading in background");
        if (this.started) {
          // Live db.sync backfills the binaries (Pattern B) while push is live throughout.
          this.startLiveSync();
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
      // Non-critical: localStorage may not be available (daemon mode) or empty
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

  /**
   * Live bidirectional sync — the steady state, and (Pattern B) the binary backfill.
   *
   * State is driven by the live handle's events, with a deliberate discriminator:
   * - `change`  : work flowing → "syncing"; remember `pending` for the paused gate.
   * - `paused`  : the combined db.sync handle emits a no-arg pause on caught-up AND on
   *               error-backoff. Only treat it as caught-up ("ok"/"complete") when the
   *               last `pending` was 0; otherwise it is a backoff pause → stay "syncing".
   * - `active`  : work resuming → "syncing" / "binary-backfill".
   * - `complete`: only fires when a live handle is cancelled; kept for parity.
   *
   * Why not just set "ok" eagerly: doing so renders "Synced" while binaries are still
   * pending, which is the lie this feature removes.
   */
  private startLiveSync(): void {
    const remoteUrl = this.buildRemoteUrl();
    const handle = this.db.sync(remoteUrl, { live: true, retry: true });
    const emitter = handle as unknown as PouchEmitter;
    this.syncHandle = emitter;
    this.liveSyncPending = 0;
    // Entering live sync means there may be backlog (binaries, or steady-state catch-up).
    // Do not rely on `active` to enter this phase: the combined db.sync `active` only fires
    // once one direction is already paused, so it may not fire at startup.
    if (this.syncPhase !== "complete") {
      this.setPhase("binary-backfill");
    }
    this.setState("syncing");

    emitter.on("change", (info) => {
      this.liveSyncPending = info.pending ?? 0;
      this.setState("syncing");
    });

    emitter.on("active", () => {
      if (this.syncPhase !== "complete") {
        this.setPhase("binary-backfill");
      }
      this.setState("syncing");
    });

    emitter.on("paused", () => {
      // Caught up only when the changes feed drained (pending === 0). A no-arg pause with
      // pending still > 0 is an error-backoff pause — stay syncing.
      if (this.liveSyncPending === 0) {
        this.setPhase("complete");
        this.setState("ok");
      }
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

  private setPhase(phase: SyncPhase): void {
    this.syncPhase = phase;
    this.onDiagnosticsChange();
  }

  private setError(msg: string): void {
    this.lastError = msg;
    this.setState("error");
    this.onError(msg);
  }

  private handleVisibilityVisible(): void {
    // Guard: only act if engine is started and not in initial pull
    if (!this.started) return;
    if (this.initialPullRunning) return;
    this.cancelSync();
    this.startLiveSync();
  }
}
