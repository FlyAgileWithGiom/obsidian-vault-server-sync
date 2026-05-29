import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import { FilesystemVaultAdapter } from "./VaultAdapter";
import type { VaultSyncSettings } from "../src/types";
import { DEFAULT_SETTINGS, VAULT_SYNC_CONFIG_FILE } from "../src/types";
import type { RemoteDbForPhantomCheck } from "./converter";

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

function loadConfig(vaultRoot: string): VaultSyncSettings {
  const configPath = path.join(vaultRoot, CONFIG_FILENAME);
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const userConfig = JSON.parse(raw);
    const merged = { ...DEFAULT_SETTINGS, ...userConfig };
    // Ensure ALWAYS_EXCLUDED patterns are in excludePatterns even if user
    // didn't list them. Avoids the bug where .git/ was silently synced.
    const userPatterns = merged.excludePatterns ?? [];
    const combined = [...userPatterns];
    for (const p of ALWAYS_EXCLUDED) {
      if (!combined.includes(p)) combined.push(p);
    }
    merged.excludePatterns = combined;
    return merged;
  } catch {
    console.error(`[vault-sync] Config not found at ${configPath}`);
    console.error(`[vault-sync] Create ${CONFIG_FILENAME} in your vault root with:`);
    console.error(JSON.stringify({
      couchDbUrl: "https://your-couch-host.example.com",
      couchDbName: "your-vault-name",
      couchDbUser: "your-username",
      couchDbPassword: "your-password",
    }, null, 2));
    process.exit(1);
  }
}

/**
 * Exported startup sequence for the PouchDB daemon.
 *
 * Extracted for testability: allows unit tests to assert that runConverter
 * completes (on a cold PouchDB) BEFORE bridge.start() arms the changes-feed
 * and FS watcher. This ordering prevents the init-race where a Dropbox/iCloud
 * FS event during boot triggers writeTextToPouch → db.put → doc_count > 0,
 * making the converter believe migration already happened and silently skipping
 * the seed of 14700+ docs (issue #69).
 *
 * @param deps.bridge       Pre-constructed PouchDbFsBridge (not yet started)
 * @param deps.runConverter Async fn that seeds PouchDB from state.json revMap
 * @param deps.fsWatcher    Pre-constructed FsWatcher (not yet started)
 * @param deps.engine       Pre-constructed PouchDbSyncEngine (not yet started)
 * @param deps.statePath    Path to state.json passed to runConverter
 * @param deps.pouchDir     PouchDB data dir passed to runConverter
 * @param deps.db           PouchDB instance passed to runConverter
 */
export async function runDaemonV2Startup(deps: {
  bridge: { start: (watcher: unknown) => void };
  runConverter: (
    statePath: string,
    pouchDir: string,
    db: unknown,
    dryRun: boolean,
    remoteDb: RemoteDbForPhantomCheck,
  ) => Promise<{
    noStateFile?: boolean;
    alreadyMigrated?: boolean;
    migrated?: number;
    tombstonedSkipped?: number;
    orphanSkipped?: number;
    phantomSkipped?: number;
  }>;
  fsWatcher: unknown;
  engine: { start: () => Promise<void> };
  statePath: string;
  pouchDir: string;
  db: unknown;
  remoteDb: RemoteDbForPhantomCheck;
}): Promise<void> {
  const { bridge, runConverter, fsWatcher, engine, statePath, pouchDir, db, remoteDb } = deps;

  // CRITICAL: converter MUST run on a cold PouchDB (no other writer active).
  // Arming the changes-feed or FS watcher before this completes risks a
  // Dropbox/iCloud FS event triggering writeTextToPouch → db.put → doc_count > 0,
  // making the converter skip the seed and causing silent partial sync.
  // remoteDb is required so the phantom filter (C04-bis) actually runs — without
  // it, phantom entries (.DS_Store, .git/*) would be migrated and pushed to CouchDB.
  const convResult = await runConverter(statePath, pouchDir, db, false, remoteDb);
  if (convResult.noStateFile) {
    console.log("[vault-sync] No state.json found — PouchDB will fresh-pull from CouchDB");
  } else if (convResult.alreadyMigrated) {
    console.log("[vault-sync] PouchDB already has docs — skipping migration");
  } else {
    console.log(
      `[vault-sync] Converter: migrated ${convResult.migrated} docs, ` +
      `${convResult.tombstonedSkipped} tombstoned skipped, ` +
      `${convResult.orphanSkipped} orphan skipped, ` +
      `${convResult.phantomSkipped ?? 0} phantom skipped`,
    );
  }

  // Now arm the changes-feed and FS watcher — PouchDB is fully seeded.
  bridge.start(fsWatcher);

  // Engine.start() handles isFirstRun() check: if converter migrated docs,
  // it skips initial pull and goes straight to live sync.
  await engine.start();
}

async function runDaemon(absVaultRoot: string, settings: VaultSyncSettings): Promise<void> {
  // PouchDB (pouchdb-node + LevelDB) + PouchDbSyncEngine — the only engine since v2.0 (issue #69).
  const PouchDB = require("pouchdb-node") as typeof import("pouchdb-node");
  const { PouchDbFsBridge } = await import("../src/PouchDbFsBridge");
  const { PouchDbSyncEngine } = await import("../src/PouchDbSyncEngine");
  const { FsWatcher } = await import("./FsWatcher");
  const { runConverter } = await import("./converter");

  const pouchDir = resolvePouchDir(settings.couchDbName);
  fs.mkdirSync(pouchDir, { recursive: true });
  console.log(`[vault-sync] PouchDB dir: ${pouchDir}`);

  // Construct pouchdb-node database backed by LevelDB at pouchDir
  const db = new PouchDB(pouchDir) as unknown as import("../src/pouchdb-browser").default;

  // Build vault adapter and bridge (bridge not yet started — converter runs first)
  const vaultAdapter = new FilesystemVaultAdapter(absVaultRoot);
  const bridge = new PouchDbFsBridge(vaultAdapter, db);

  const excludePatterns = [STATE_FILENAME, CONFIG_FILENAME, ".git", ...settings.excludePatterns];
  const fsWatcher = new FsWatcher(absVaultRoot, excludePatterns);

  // Build engine with injected db and bridge
  const engine = new PouchDbSyncEngine(settings, db, bridge);

  engine.onStateChange = (state) => console.log(`[vault-sync] State: ${state}`);
  engine.onError = (msg) => console.error(`[vault-sync] Error: ${msg}`);
  engine.onCountsChange = ({ pendingPush, pendingPull }) => {
    if (pendingPush > 0 || pendingPull > 0) {
      console.log(`[vault-sync] Pending: ↑${pendingPush} ↓${pendingPull}`);
    }
  };
  engine.onNotice = (msg) => console.log(`[vault-sync] ${msg}`);

  const statePath = resolveStatePath(absVaultRoot, settings.couchDbName);
  console.log(`[vault-sync] Running converter (state.json -> PouchDB)...`);

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

  // Delegate ordering logic to runDaemonV2Startup (converter first, then bridge.start)
  await runDaemonV2Startup({ bridge, runConverter, fsWatcher, engine, statePath, pouchDir, db, remoteDb });

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
  const vaultRoot = process.argv[2] ?? process.cwd();
  const absVaultRoot = path.resolve(vaultRoot);

  console.log(`[vault-sync] Starting headless daemon for vault: ${absVaultRoot}`);

  const settings = loadConfig(absVaultRoot);

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
