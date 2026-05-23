import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { SyncEngine } from "../src/sync-engine";
import { FilesystemVaultAdapter } from "./VaultAdapter";
import { JsonStateStore } from "./StateStore";
import { FetchTransport } from "./FetchTransport";
import type { VaultSyncSettings, VaultFile, VaultEntry } from "../src/types";
import { DEFAULT_SETTINGS, VAULT_SYNC_CONFIG_FILE } from "../src/types";

/**
 * Legacy state filename, written at vault root before #54.
 * Kept as a constant so the migration path stays unambiguous.
 */
const LEGACY_STATE_FILENAME = ".vault-sync-state.json";
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
 * One-shot migration of the legacy `.vault-sync-state.json` (at vault root) to
 * the new out-of-vault location. Idempotent and safe:
 *  - If no legacy file exists: no-op.
 *  - If only legacy exists: move it to the new location.
 *  - If both exist: KEEP the new file (presumed newer), DELETE the legacy file
 *    so the cloud-sync conflict loop stops generating phantom copies.
 *
 * Never throws on routine I/O errors — best-effort cleanup. The daemon falls
 * back to fresh state if the new location is empty.
 */
export function migrateStateFile(vaultRoot: string, newStatePath: string): void {
  const legacy = path.join(vaultRoot, LEGACY_STATE_FILENAME);
  let legacyExists = false;
  try { legacyExists = fs.statSync(legacy).isFile(); } catch { /* no legacy */ }
  if (!legacyExists) return;

  let newExists = false;
  try { newExists = fs.statSync(newStatePath).isFile(); } catch { /* no new */ }

  try {
    if (newExists) {
      // New location wins. Unlink legacy so it stops being walked & re-conflicted.
      fs.unlinkSync(legacy);
      return;
    }
    fs.mkdirSync(path.dirname(newStatePath), { recursive: true });
    fs.renameSync(legacy, newStatePath);
  } catch (e) {
    // Cross-device rename (EXDEV) or transient I/O — fall back to copy+unlink.
    try {
      fs.mkdirSync(path.dirname(newStatePath), { recursive: true });
      fs.copyFileSync(legacy, newStatePath);
      fs.unlinkSync(legacy);
    } catch (inner) {
      console.warn(`[vault-sync] State migration failed: ${(e as Error).message} / ${(inner as Error).message}`);
    }
  }
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

const DEBOUNCE_MS = 100;

export function createWatcher(
  absVaultRoot: string,
  excludePatterns: string[],
  engine: Pick<SyncEngine, "handleLocalChange" | "handleLocalDelete">,
): fs.FSWatcher {
  const debounce = new Map<string, ReturnType<typeof setTimeout>>();
  // macOS FSEvents emits a spurious event with rawFilename === basename(vaultRoot)
  const vaultRootBasename = path.basename(absVaultRoot);

  const watcher = fs.watch(absVaultRoot, { recursive: true, persistent: true });

  watcher.on("change", (eventType: string, rawFilename: string | Buffer | null) => {
    if (!rawFilename) return;
    const rel = typeof rawFilename === "string" ? rawFilename : rawFilename.toString("utf-8");

    // Skip spurious self-referential events for the vault root directory itself
    if (rel === vaultRootBasename) return;

    const filePath = path.join(absVaultRoot, rel);

    if (excludePatterns.some((p) => rel === p || rel.startsWith(p + path.sep))) return;

    const existing = debounce.get(rel);
    if (existing) clearTimeout(existing);
    debounce.set(rel, setTimeout(() => {
      debounce.delete(rel);
      handleFsEvent(filePath, rel, engine);
    }, DEBOUNCE_MS));
  });

  watcher.on("error", (error: Error) => {
    console.error("[vault-sync] Watcher error:", error);
  });

  return watcher;
}

function handleFsEvent(
  filePath: string,
  rel: string,
  engine: Pick<SyncEngine, "handleLocalChange" | "handleLocalDelete">,
): void {
  let stat: ReturnType<typeof fs.statSync> | null = null;
  try {
    stat = fs.statSync(filePath);
  } catch {
    // Path no longer exists → delete event
  }

  if (!stat) {
    const file: VaultEntry = { kind: "file", path: rel, mtime: 0, size: 0 };
    engine.handleLocalDelete(file);
    return;
  }

  if (stat.isDirectory()) return;

  const vaultFile: VaultFile = {
    kind: "file",
    path: rel,
    mtime: stat.mtimeMs,
    size: stat.size,
  };
  engine.handleLocalChange(vaultFile);
}

async function main(): Promise<void> {
  const vaultRoot = process.argv[2] ?? process.cwd();
  const absVaultRoot = path.resolve(vaultRoot);

  console.log(`[vault-sync] Starting headless daemon for vault: ${absVaultRoot}`);

  const settings = loadConfig(absVaultRoot);
  const vaultAdapter = new FilesystemVaultAdapter(absVaultRoot);

  // State now lives outside the vault to avoid Dropbox/iCloud conflict-copy
  // loops (issue #54). Migrate any legacy in-vault file on first run.
  const statePath = resolveStatePath(absVaultRoot, settings.couchDbName);
  migrateStateFile(absVaultRoot, statePath);
  console.log(`[vault-sync] State file: ${statePath}`);
  const stateStore = new JsonStateStore(statePath);

  const transport = new FetchTransport();

  const engine = new SyncEngine(settings, vaultAdapter, stateStore, transport);

  engine.onStateChange = (state) => console.log(`[vault-sync] State: ${state}`);
  engine.onError = (msg) => console.error(`[vault-sync] Error: ${msg}`);
  engine.onCountsChange = ({ pendingPush, pendingPull }) => {
    if (pendingPush > 0 || pendingPull > 0) {
      console.log(`[vault-sync] Pending: ↑${pendingPush} ↓${pendingPull}`);
    }
  };

  // Start initial sync
  await engine.start();

  // Watch filesystem for local changes
  // Exclude state file and config file from watching to prevent echo loops
  const excludePatterns = [
    STATE_FILENAME,
    CONFIG_FILENAME,
    ".git",
    ...settings.excludePatterns,
  ];

  const watcher = createWatcher(absVaultRoot, excludePatterns, engine);

  // Graceful shutdown
  function shutdown(signal: string): void {
    console.log(`\n[vault-sync] Received ${signal}, shutting down...`);
    engine.stop();
    watcher.close();
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  console.log("[vault-sync] Daemon running. Press Ctrl+C to stop.");
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
