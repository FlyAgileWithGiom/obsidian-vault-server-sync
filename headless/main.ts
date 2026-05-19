import * as path from "node:path";
import * as fs from "node:fs";
import { SyncEngine } from "../src/sync-engine";
import { FilesystemVaultAdapter } from "./VaultAdapter";
import { JsonStateStore } from "./StateStore";
import { FetchTransport } from "./FetchTransport";
import type { VaultSyncSettings, VaultFile, VaultEntry, SyncState } from "../src/types";
import { DEFAULT_SETTINGS, VAULT_SYNC_CONFIG_FILE } from "../src/types";

const STATE_FILENAME = ".vault-sync-state.json";
const CONFIG_FILENAME = VAULT_SYNC_CONFIG_FILE;

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

/**
 * Starts the engine and calls `exit(1)` if the engine ends in `"error"` state,
 * allowing the launchd supervisor (KeepAlive) to restart the daemon.
 *
 * Wraps `engine.onStateChange` to track the last observed state without
 * clobbering any callback already assigned before this call.
 */
export async function runStartWithExitOnFailure(
  engine: { onStateChange?: (s: SyncState) => void; start(): Promise<void> },
  exit: (code: number) => void,
): Promise<void> {
  const previous = engine.onStateChange;
  let lastState: SyncState | undefined;
  engine.onStateChange = (state) => {
    lastState = state;
    previous?.(state);
  };

  await engine.start();

  if (lastState === "error") {
    exit(1);
  }
}

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
  const stateStore = new JsonStateStore(path.join(absVaultRoot, STATE_FILENAME));
  const transport = new FetchTransport();

  const engine = new SyncEngine(settings, vaultAdapter, stateStore, transport);

  // Assign logging callback before runStartWithExitOnFailure so the wrapper
  // captures it and both the log and the state-tracking run on each transition.
  engine.onStateChange = (state) => console.log(`[vault-sync] State: ${state}`);
  engine.onError = (msg) => console.error(`[vault-sync] Error: ${msg}`);
  engine.onCountsChange = ({ pendingPush, pendingPull }) => {
    if (pendingPush > 0 || pendingPull > 0) {
      console.log(`[vault-sync] Pending: ↑${pendingPush} ↓${pendingPull}`);
    }
  };

  // Start initial sync — exit(1) if engine ends in error so launchd can restart
  await runStartWithExitOnFailure(engine, (code) => process.exit(code));

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
