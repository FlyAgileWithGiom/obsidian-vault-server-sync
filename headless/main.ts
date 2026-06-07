import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import { FilesystemVaultAdapter } from "./VaultAdapter";
import type { VaultSyncSettings, VaultFile } from "../src/types";
import { DEFAULT_SETTINGS, VAULT_SYNC_CONFIG_FILE } from "../src/types";
import type { RemoteDbForPhantomCheck } from "./converter";
import { fetchRemoteRevs } from "./remote-revs";
import { reconcile } from "./reconcile";
import { pathToDocId } from "../src/doc-id";
import { isBinaryPath } from "../src/binary-ext";
import { isPathExcluded } from "./exclude";
import type { SecretStore } from "../src/secret-store";
import {
  resolveSecret,
  SECRET_ID_COUCH_USER,
  SECRET_ID_COUCH_PASSWORD,
  ENV_COUCH_USER,
  ENV_COUCH_PASSWORD,
} from "../src/secret-store";
import { KeychainSecretStore } from "./keychain-secret-store";

/**
 * Build a RemoteDbForPhantomCheck that uses node:http or node:https directly.
 *
 * pouchdb-node's HTTP adapter hangs on large _all_docs?keys=... POST requests
 * (keep-alive issues with Fly.io / CouchDB). node:http(s) with explicit
 * Connection:close avoids the hang. Supports both http:// (localhost, smoke
 * tests) and https:// (production Fly.io) by selecting the module based on
 * the URL scheme.
 *
 * The rawUrl must include credentials if authentication is required, e.g.:
 *   http://user:pass@localhost:5986/vault-name
 *   https://user:pass@couchdb.fly.dev/vault-name
 */
export function makeHttpRemoteDb(rawUrl: string): RemoteDbForPhantomCheck {
  const parsed = new URL(rawUrl);
  const isHttps = parsed.protocol === "https:";
  const auth = parsed.username
    ? `Basic ${Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString("base64")}`
    : undefined;

  // Strip credentials from the URL used for the request path
  const reqUrl = new URL(rawUrl);
  reqUrl.username = "";
  reqUrl.password = "";
  const baseUrl = reqUrl.toString().replace(/\/$/, "");

  return {
    async allDocs(opts: { keys: string[]; include_docs: false }) {
      const endpoint = `${baseUrl}/_all_docs?include_docs=false`;
      const body = JSON.stringify({ keys: opts.keys });
      const endpointParsed = new URL(endpoint);

      return new Promise((resolve, reject) => {
        const reqOptions = {
          hostname: endpointParsed.hostname,
          port: endpointParsed.port || (isHttps ? 443 : 80),
          path: endpointParsed.pathname + endpointParsed.search,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            ...(auth ? { "Authorization": auth } : {}),
            // Disable keep-alive to avoid socket hang-up on Fly.io CouchDB
            "Connection": "close",
          },
        };

        const transport = isHttps ? https : http;
        const req = transport.request(reqOptions, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            try {
              const json = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
              resolve(json);
            } catch (e) {
              reject(new Error(`Failed to parse _all_docs response: ${e}`));
            }
          });
          res.on("error", reject);
        });

        req.on("error", reject);
        req.write(body);
        req.end();
      });
    },
  };
}


const STATE_FILENAME = "state.json";
const STATE_APP_DIR = "vault-sync-daemon";
const CONFIG_FILENAME = VAULT_SYNC_CONFIG_FILE;

/**
 * Resolve where the daemon stores its state file.
 *
 * Issue #54: writing state inside the vault triggers Dropbox/iCloud "conflicted
 * copy" loops on every fast write burst. The state file must live OUTSIDE the
 * vault and outside cloud-sync scope, disambiguated per-vault by CouchDB
 * database name (already a slug).
 *
 * Defaults follow XDG / OS conventions:
 *   macOS  : ~/Library/Application Support/vault-sync-daemon/<dbName>/state.json
 *   Linux  : ~/.config/vault-sync-daemon/<dbName>/state.json
 *   Windows: %APPDATA%/vault-sync-daemon/<dbName>/state.json
 *
 * The `env` parameter is injected for tests; production callers omit it and we
 * resolve from process.env / os.homedir() / process.platform.
 */
export function resolveStatePath(
  _vaultRoot: string,
  dbName: string,
  env: { platform?: NodeJS.Platform; home?: string; appData?: string } = {},
): string {
  const platform = env.platform ?? process.platform;
  const home = env.home ?? os.homedir();
  const slug = dbName || "default";

  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", STATE_APP_DIR, slug, STATE_FILENAME);
  }
  if (platform === "win32") {
    const appData = env.appData ?? process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return path.join(appData, STATE_APP_DIR, slug, STATE_FILENAME);
  }
  // Linux and any other POSIX
  return path.join(home, ".config", STATE_APP_DIR, slug, STATE_FILENAME);
}

/**
 * Resolve the PouchDB LevelDB directory for the daemon.
 *
 * Mirrors resolveStatePath() but points to the pouch/ subdirectory.
 *   macOS  : ~/Library/Application Support/vault-sync-daemon/<dbName>/pouch/
 *   Linux  : ~/.config/vault-sync-daemon/<dbName>/pouch/
 *   Windows: %APPDATA%/vault-sync-daemon/<dbName>/pouch/
 */
export function resolvePouchDir(
  dbName: string,
  env: { platform?: NodeJS.Platform; home?: string; appData?: string } = {},
): string {
  const platform = env.platform ?? process.platform;
  const home = env.home ?? os.homedir();
  const slug = dbName || "default";

  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", STATE_APP_DIR, slug, "pouch");
  }
  if (platform === "win32") {
    const appData = env.appData ?? process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return path.join(appData, STATE_APP_DIR, slug, "pouch");
  }
  return path.join(home, ".config", STATE_APP_DIR, slug, "pouch");
}

/**
 * Patterns that must ALWAYS be excluded from sync regardless of user config.
 * Critical: `.git/` and `.DS_Store` were leaking into CouchDB before because
 * they weren't in the user's `excludePatterns`. The watcher excludes them
 * separately (in headless/main.ts watcher setup) but pushAllLocal/pullAllRemote
 * use settings.excludePatterns, so they have to be there too.
 */
const ALWAYS_EXCLUDED = [
  ".git/",
  ".DS_Store",
  ".vault-sync.json",
  ".vault-sync-state.json",
  ".obsidian/",
  ".trash/",
];

/**
 * Load the daemon config, resolving credentials by precedence (#78):
 *   env (VAULT_SYNC_COUCH_USER/PASSWORD) > secret store (Keychain) > legacy in-vault.
 *
 * The .vault-sync.json FILE remains the only source of couchDbUrl/couchDbName, so
 * a missing/unparseable file is still a hard error (process.exit(1)) — UNCHANGED.
 * Secret resolution happens AFTER a successful parse and NEVER exits/throws on a
 * missing secret: with no credential anywhere, couchDbUser/couchDbPassword stay
 * empty, the remote-URL builder produces a credential-less URL, and CouchDB
 * returns a plain 401 → the existing skip-on-fetch-fail path skips reconcile.
 * It must never escalate to a destructive tombstone-everything resync (invariant 8).
 *
 * Phase A (additive, automatic): if the store lacks a credential the legacy
 * in-vault value is present for, copy it into the store (write-new). The file is
 * never mutated here — Phase B (--scrub-secrets) owns deletion.
 *
 * store and env are injected for testing; production defaults to the macOS
 * Keychain store and process.env.
 */
export async function loadConfig(
  vaultRoot: string,
  opts: { store?: SecretStore; env?: Record<string, string | undefined> } = {},
): Promise<VaultSyncSettings> {
  const store = opts.store ?? new KeychainSecretStore();
  const env = opts.env ?? process.env;

  const configPath = path.join(vaultRoot, CONFIG_FILENAME);

  // The file is the only source of couchDbUrl/couchDbName — missing/unparseable
  // is a hard error. Keep this exit path strictly separate from secret resolution.
  let merged: VaultSyncSettings;
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const userConfig = JSON.parse(raw);
    merged = { ...DEFAULT_SETTINGS, ...userConfig };
  } catch {
    console.error(`[vault-sync] Config not found at ${configPath}`);
    console.error(`[vault-sync] Create ${CONFIG_FILENAME} in your vault root with:`);
    console.error(JSON.stringify({
      couchDbUrl: "https://your-couch-host.example.com",
      couchDbName: "your-vault-name",
    }, null, 2));
    console.error(`[vault-sync] Credentials come from the macOS Keychain, env vars`);
    console.error(`[vault-sync] (${ENV_COUCH_USER}/${ENV_COUCH_PASSWORD}), or — transitionally — this file.`);
    process.exit(1);
  }

  // Ensure ALWAYS_EXCLUDED patterns are present even if the user didn't list them.
  const userPatterns = merged.excludePatterns ?? [];
  const combined = [...userPatterns];
  for (const p of ALWAYS_EXCLUDED) {
    if (!combined.includes(p)) combined.push(p);
  }
  merged.excludePatterns = combined;

  // --- Credential resolution (outside the exit path; never destructive) ---
  const legacyUser = merged.couchDbUser ?? "";
  const legacyPassword = merged.couchDbPassword ?? "";

  merged.couchDbUser = await resolveSecret({
    envName: ENV_COUCH_USER,
    env,
    store,
    id: SECRET_ID_COUCH_USER,
    legacy: legacyUser,
  });
  merged.couchDbPassword = await resolveSecret({
    envName: ENV_COUCH_PASSWORD,
    env,
    store,
    id: SECRET_ID_COUCH_PASSWORD,
    legacy: legacyPassword,
  });

  // Phase A — additive copy of a legacy in-vault secret into the store.
  // Write-new only; never overwrite a store secret, never delete from the file.
  // Best-effort: KeychainSecretStore.set swallows failures (locked keychain →
  // retry next boot on the legacy value).
  if (store.isAvailable()) {
    if (legacyUser && !(await store.get(SECRET_ID_COUCH_USER))) {
      await store.set(SECRET_ID_COUCH_USER, legacyUser);
    }
    if (legacyPassword && !(await store.get(SECRET_ID_COUCH_PASSWORD))) {
      await store.set(SECRET_ID_COUCH_PASSWORD, legacyPassword);
    }
  }

  return merged;
}

/**
 * Phase B scrub for the daemon (#78) — operator-gated via --scrub-secrets.
 *
 * Strip couchDbUser/couchDbPassword from .vault-sync.json, write-BEFORE-delete:
 * only remove them after confirming BOTH are present in the store, leaving the
 * file otherwise intact. Mirrors the plugin's scrubInVaultSecrets().
 */
export async function scrubInVaultConfig(
  configPath: string,
  store: SecretStore,
): Promise<{ scrubbed: boolean }> {
  let onDisk: Record<string, unknown>;
  try {
    onDisk = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  } catch {
    console.error(`[vault-sync] migrate-secrets: cannot read ${configPath} — nothing to scrub.`);
    return { scrubbed: false };
  }

  const hasFileSecret =
    onDisk.couchDbUser !== undefined || onDisk.couchDbPassword !== undefined;
  if (!hasFileSecret) {
    console.log(`[vault-sync] migrate-secrets: no in-vault credentials to remove.`);
    return { scrubbed: false };
  }

  const storeUser = await store.get(SECRET_ID_COUCH_USER);
  const storePassword = await store.get(SECRET_ID_COUCH_PASSWORD);
  if (!storeUser || !storePassword) {
    console.warn(
      `[vault-sync] migrate-secrets: store is missing a credential — refusing to scrub ` +
      `the in-vault secret (write-before-delete).`,
    );
    return { scrubbed: false };
  }

  delete onDisk.couchDbUser;
  delete onDisk.couchDbPassword;
  fs.writeFileSync(configPath, JSON.stringify(onDisk, null, 2));
  console.log(`[vault-sync] migrate-secrets: removed in-vault credentials from ${configPath}.`);
  return { scrubbed: true };
}

/**
 * Minimal PouchDB interface needed by runReconcileOnStartup.
 * Only the fields the reconcile wiring reads from the real db.
 */
interface PouchDbForReconcile {
  info(): Promise<{ doc_count: number }>;
  allDocs(opts: { include_docs: false }): Promise<{ rows: Array<{ id: string }> }>;
  get(id: string): Promise<unknown>;
}

/**
 * Bridge reconcile interface — public methods used during startup reconciliation.
 */
interface BridgeReconcile {
  reconcilePush(path: string): Promise<void>;
  reconcilePull(docId: string, path: string): Promise<void>;
  reconcileTombstone(docId: string): Promise<void>;
  /**
   * Register an echo-suppression sentinel for an original file in a conflict-copy
   * scenario without writing to PouchDB. Prevents macOS FSEvents stale events from
   * pushing the divergent disk content into the original doc's local PouchDB entry.
   */
  reconcileSuppressEcho(docId: string, currentLocalRev: string): void;
}

/**
 * Run the startup reconciliation pass (non-first-run only).
 *
 * Exported for direct unit-testing of the skip-on-fetch-fail and gate logic
 * without needing the full runDaemonV2Startup harness.
 *
 * Returns a summary of applied action counts for the boot log.
 */
export async function runReconcileOnStartup(opts: {
  db: PouchDbForReconcile;
  bridge: BridgeReconcile;
  vaultAdapter: {
    getFiles(): VaultFile[];
    readText(file: VaultFile): Promise<string>;
    readBinary(file: VaultFile): Promise<ArrayBuffer>;
    createText(path: string, content: string): Promise<VaultFile>;
    createBinary(path: string, data: ArrayBuffer): Promise<VaultFile>;
    getEntryByPath(path: string): import("../src/types").VaultEntry | null;
  };
  remoteDb: RemoteDbForPhantomCheck;
  excludePatterns: string[];
}): Promise<{
  push: number;
  pull: number;
  tombstone: number;
  conflictCopy: number;
  skip: number;
} | null> {
  const { db, bridge, vaultAdapter, remoteDb, excludePatterns } = opts;

  // Non-first-run gate (AC2.6): skip reconcile entirely on first run.
  // First run = PouchDB is empty. The two-phase pull (#72) owns first-run population.
  const info = await db.info();
  if (info.doc_count === 0) {
    console.log("[vault-sync] reconcile: first-run detected (doc_count=0) — skipping reconcile");
    return null;
  }

  // Build the candidate doc-id sets.
  // UNION(local, disk) is required (AC2.0): a stranded disk file has no local doc,
  // so querying only local ids would treat every such file as "remote-absent" → blind push.
  const allDocsResult = await db.allDocs({ include_docs: false });
  const localDocIds = allDocsResult.rows.map((r) => r.id);

  const vaultFiles = vaultAdapter.getFiles();
  const vaultFileDocIds = vaultFiles.map((f) => pathToDocId(f.path));

  // Union key set: start from localDocIds, add any disk-only ids not in DB.
  const unionIds = [...new Set([...localDocIds, ...vaultFileDocIds])];

  // Skip-on-fetch-fail (critical safety): if remote is unreachable, SKIP reconcile
  // this boot and proceed to bridge.start + live sync. A later restart reconciles.
  // Never push/tombstone blind without remote knowledge (plan §3 lines ~352-354).
  let remoteRevs: Map<string, import("./remote-revs").RemoteRevEntry>;
  try {
    remoteRevs = await fetchRemoteRevs(remoteDb, unionIds);
  } catch (e) {
    console.warn(
      `[vault-sync] reconcile: remote fetch failed — skipping reconcile this boot. ` +
      `A later restart will reconcile. Error: ${e}`,
    );
    return null;
  }

  // Shared exclusion predicate: normalises trailing slashes in patterns so that
  // ".trash/" excludes ".trash/foo.md" correctly (without this, pat + "/" = ".trash//").
  // Identical predicate used by FsWatcher.isExcluded — the two code-paths cannot diverge.
  const isExcluded = (p: string): boolean => isPathExcluded(p, excludePatterns);

  // localGet: wrap db.get, returning undefined for 404.
  const localGet = async (docId: string): Promise<import("./reconcile").LocalDoc | undefined> => {
    try {
      return await db.get(docId) as import("./reconcile").LocalDoc;
    } catch {
      return undefined;
    }
  };

  const readDiskText = (file: VaultFile): Promise<string> => vaultAdapter.readText(file);

  const actions = await reconcile({
    vaultFiles,
    localDocIds,
    localGet,
    readDiskText,
    remoteRevs,
    isExcluded,
  });

  // Apply actions
  const counts = { push: 0, pull: 0, tombstone: 0, conflictCopy: 0, skip: 0 };
  for (const action of actions) {
    switch (action.kind) {
      case "push":
        await bridge.reconcilePush(action.path);
        counts.push++;
        break;
      case "pull":
        await bridge.reconcilePull(pathToDocId(action.path), action.path);
        counts.pull++;
        break;
      case "tombstone":
        await bridge.reconcileTombstone(action.docId);
        counts.tombstone++;
        break;
      case "conflict-copy": {
        // AC2.4 — non-destructive conflict handling.
        // Both sides diverged (local content ≠ DB content AND local rev ≠ remote rev).
        // Strategy:
        //   1. Derive a safe conflict-copy path (insert " (reconcile-conflict <ts>)" before ext).
        //   2. Read the LOCAL disk content (the divergent copy the user cares about).
        //   3. Write it to the conflict-copy path (createText / createBinary).
        //   4. Push the new conflict-copy doc to PouchDB via bridge.reconcilePush.
        //      The ORIGINAL doc at action.path is NOT touched — live sync will pull
        //      the remote winning rev into it, preserving the remote lineage.
        //
        // No echo risk: reconcile runs before bridge.start, so no FS watcher is armed
        // and the `since:"now"` changes feed does not exist yet (ordering guarantee).
        const ts = new Date().toISOString().replace(/:/g, "-");
        const ext = path.extname(action.path);
        const base = action.path.slice(0, action.path.length - ext.length);
        const conflictPath = `${base} (reconcile-conflict ${ts})${ext}`;

        try {
          if (isBinaryPath(action.path)) {
            const entry = vaultAdapter.getEntryByPath(action.path);
            if (entry && entry.kind === "file") {
              const data = await vaultAdapter.readBinary(entry);
              await vaultAdapter.createBinary(conflictPath, data);
            }
          } else {
            const entry = vaultAdapter.getEntryByPath(action.path);
            if (entry && entry.kind === "file") {
              const content = await vaultAdapter.readText(entry);
              await vaultAdapter.createText(conflictPath, content);
            }
          }
          await bridge.reconcilePush(conflictPath);

          // Suppress stale FSEvents for the ORIGINAL file.
          //
          // The original file stays on disk with divergent content (not pushed, not
          // deleted — live sync will overwrite it with the remote winning rev). macOS
          // FSEvents can deliver a stale event for the original path after bridge.start()
          // arms the FS watcher; without a sentinel, onVaultEvent pushes the divergent
          // disk content into the original doc, clobbering the outage-surviving rev.
          //
          // Fix: register the original doc's current local rev as the echo-suppression
          // sentinel. suppressIfEcho sees _rev === sentinel → treats the stale FSEvent
          // as an echo and silently discards it.
          const origDocId = pathToDocId(action.path);
          try {
            const origDoc = await db.get(origDocId);
            const origRev = (origDoc as { _rev?: string })._rev;
            if (origRev) bridge.reconcileSuppressEcho(origDocId, origRev);
          } catch {
            // Original doc not in DB (edge case) — sentinel not critical, skip
          }

          console.warn(
            `[vault-sync] reconcile: conflict-copy created — original=${action.path} copy=${conflictPath}`,
          );
        } catch (e) {
          console.error(`[vault-sync] reconcile: conflict-copy FAILED for ${action.path}: ${e}`);
        }
        counts.conflictCopy++;
        break;
      }
      case "skip":
        counts.skip++;
        break;
    }
  }

  console.log(
    `[vault-sync] reconcile: ↑push=${counts.push} ↓pull=${counts.pull} ` +
    `✗tombstone=${counts.tombstone} ⚡conflict-copy=${counts.conflictCopy} ` +
    `–skip=${counts.skip}`,
  );
  return counts;
}

/**
 * Exported startup sequence for the PouchDB daemon.
 *
 * Extracted for testability: allows unit tests to assert that reconcile
 * completes BEFORE bridge.start() arms the changes-feed and FS watcher. This
 * ordering protects the init-race (issue #69): the FS watcher / changes feed
 * must not arm before the local PouchDB has been reconciled against disk,
 * otherwise a Dropbox/iCloud FS event during boot races the reconcile pass.
 *
 * @param deps.bridge       Pre-constructed PouchDbFsBridge (not yet started)
 * @param deps.runReconcile Async fn that reconciles FS vs PouchDB (non-first-run)
 * @param deps.fsWatcher    Pre-constructed FsWatcher (not yet started)
 * @param deps.engine       Pre-constructed PouchDbSyncEngine (not yet started)
 */
export async function runDaemonV2Startup(deps: {
  bridge: { start: (watcher: unknown) => void };
  runReconcile: () => Promise<unknown>;
  fsWatcher: unknown;
  engine: { start: () => Promise<void> };
}): Promise<void> {
  const { bridge, runReconcile, fsWatcher, engine } = deps;

  // Reconciliation: runs BEFORE bridge.start (AC2.6/#69).
  // Writes only to local PouchDB — live db.sync replicates afterward.
  await runReconcile();

  // Now arm the changes-feed and FS watcher — PouchDB is reconciled.
  bridge.start(fsWatcher);

  // Engine.start() handles isFirstRun() check; on an existing PouchDB it skips
  // the initial pull and goes straight to live sync.
  await engine.start();
}

async function runDaemon(absVaultRoot: string, settings: VaultSyncSettings): Promise<void> {
  // PouchDB (pouchdb-node + LevelDB) + PouchDbSyncEngine — the only engine since v2.0 (issue #69).
  const PouchDB = require("pouchdb-node") as typeof import("pouchdb-node");
  const { PouchDbFsBridge } = await import("../src/PouchDbFsBridge");
  const { PouchDbSyncEngine } = await import("../src/PouchDbSyncEngine");
  const { FsWatcher } = await import("./FsWatcher");

  const pouchDir = resolvePouchDir(settings.couchDbName);
  fs.mkdirSync(pouchDir, { recursive: true });
  console.log(`[vault-sync] PouchDB dir: ${pouchDir}`);

  // Construct pouchdb-node database backed by LevelDB at pouchDir.
  // dbFactory is passed to the engine so replaceLocalFromServer() can recreate
  // the db after destroy() without knowing the platform-specific PouchDB variant.
  const dbFactory = () => new PouchDB(pouchDir) as unknown as import("../src/pouchdb-browser").default;
  const db = dbFactory();

  // Build vault adapter and bridge (bridge not yet started — reconcile runs first)
  const vaultAdapter = new FilesystemVaultAdapter(absVaultRoot);
  const bridge = new PouchDbFsBridge(vaultAdapter, db);

  const excludePatterns = [STATE_FILENAME, CONFIG_FILENAME, ".git", ...settings.excludePatterns];
  const fsWatcher = new FsWatcher(absVaultRoot, excludePatterns);

  // Build the remoteDb adapter for the phantom check (C04-bis).
  // Uses node:http(s) directly instead of pouchdb-node's HTTP adapter, which
  // hangs on _all_docs POST requests under Fly.io CouchDB (keep-alive issue).
  // This covers localhost:5986 (smoke/http) and production Fly.io (https).
  const { couchDbUrl, couchDbName, couchDbUser, couchDbPassword } = settings;
  const base = couchDbUrl.replace(/\/$/, "");
  const proto = base.startsWith("https://") ? "https://" : "http://";
  const host = base.slice(proto.length);
  const authPart = (couchDbUser && couchDbPassword)
    ? `${encodeURIComponent(couchDbUser)}:${encodeURIComponent(couchDbPassword)}@`
    : "";
  const remoteDbUrl = `${proto}${authPart}${host}/${couchDbName}`;
  const remoteDb = makeHttpRemoteDb(remoteDbUrl);
  console.log(`[vault-sync] Phantom check remote: ${proto}${host}/${couchDbName}`);

  // Build engine with injected db and bridge.
  const engine = new PouchDbSyncEngine(settings, db, bridge, dbFactory);

  engine.onStateChange = (state) => console.log(`[vault-sync] State: ${state}`);
  engine.onError = (msg) => console.error(`[vault-sync] Error: ${msg}`);
  engine.onCountsChange = ({ pendingPush, pendingPull }) => {
    if (pendingPush > 0 || pendingPull > 0) {
      console.log(`[vault-sync] Pending: ↑${pendingPush} ↓${pendingPull}`);
    }
  };
  engine.onNotice = (msg) => console.log(`[vault-sync] ${msg}`);

  // Build the exclusion list passed to reconcile (same as live watcher — AC2.5).
  const reconcileExcludePatterns = [STATE_FILENAME, CONFIG_FILENAME, ".git", ...settings.excludePatterns];

  // runReconcile closure: captures db, bridge, vaultAdapter, remoteDb, excludePatterns.
  // Injected into runDaemonV2Startup so ordering tests can substitute a spy.
  // After reconcile completes, records the conflict-copy count on the engine (AC2.4).
  const runReconcile = async () => {
    const counts = await runReconcileOnStartup({
      db: db as PouchDbForReconcile,
      bridge,
      vaultAdapter,
      remoteDb,
      excludePatterns: reconcileExcludePatterns,
    });
    if (counts !== null) {
      engine.recordReconcileConflicts(counts.conflictCopy);
    }
    return counts;
  };

  // Delegate ordering logic to runDaemonV2Startup (reconcile first, then bridge.start, then engine.start).
  // Cast bridge to the narrow interface used by runDaemonV2Startup — the real type
  // is compatible at runtime; the cast avoids needlessly widening the public dep
  // interface (which is kept simple for testability).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await runDaemonV2Startup({ bridge: bridge as any, runReconcile, fsWatcher, engine });

  // Graceful shutdown
  function shutdown(signal: string): void {
    console.log(`\n[vault-sync] Received ${signal}, shutting down...`);
    engine.stop();
    fsWatcher.stop();
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  console.log("[vault-sync] Daemon (PouchDB) running. Press Ctrl+C to stop.");
}

async function main(): Promise<void> {
  // Parse argv robustly: flags may precede the vault root
  // (e.g. `daemon --scrub-secrets /path`). First non-flag arg is the vault root.
  const args = process.argv.slice(2);
  const scrubSecrets = args.includes("--scrub-secrets");
  const positional = args.filter((a) => !a.startsWith("--"));
  const vaultRoot = positional[0] ?? process.cwd();
  const absVaultRoot = path.resolve(vaultRoot);

  // Phase B (#78): operator-gated scrub. One-shot — never starts the daemon.
  if (scrubSecrets) {
    const configPath = path.join(absVaultRoot, CONFIG_FILENAME);
    const { scrubbed } = await scrubInVaultConfig(configPath, new KeychainSecretStore());
    console.log(
      scrubbed
        ? `[vault-sync] migrate-secrets: done — in-vault credentials removed.`
        : `[vault-sync] migrate-secrets: nothing removed (see message above).`,
    );
    process.exit(0);
  }

  console.log(`[vault-sync] Starting headless daemon for vault: ${absVaultRoot}`);

  const settings = await loadConfig(absVaultRoot);

  // PouchDB is the only sync engine since v2.0 (issue #69). The former DAEMON_V2
  // env flag is now a no-op — kept harmless for operators who still set it.
  await runDaemon(absVaultRoot, settings);
}

// Only auto-run when executed as the entry point (dist/headless.js or headless/main.ts),
// not when imported by the test runner.
const isEntryPoint =
  process.argv[1] != null &&
  (process.argv[1].endsWith("headless.js") || process.argv[1].endsWith("headless/main.ts"));

if (isEntryPoint) {
  main().catch((e) => {
    console.error("[vault-sync] Fatal error:", e);
    process.exit(1);
  });
}
