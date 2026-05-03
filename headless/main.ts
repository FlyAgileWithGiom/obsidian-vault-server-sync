import * as path from "node:path";
import * as fs from "node:fs";
import chokidar from "chokidar";
import { SyncEngine } from "../src/sync-engine";
import { FilesystemVaultAdapter } from "./VaultAdapter";
import { JsonStateStore } from "./StateStore";
import { FetchTransport } from "./FetchTransport";
import type { VaultSyncSettings, VaultFile, VaultEntry } from "../src/types";
import { DEFAULT_SETTINGS } from "../src/types";

const STATE_FILENAME = ".vault-sync-state.json";
const CONFIG_FILENAME = ".vault-sync-config.json";

function loadConfig(vaultRoot: string): VaultSyncSettings {
  const configPath = path.join(vaultRoot, CONFIG_FILENAME);
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
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

async function main(): Promise<void> {
  const vaultRoot = process.argv[2] ?? process.cwd();
  const absVaultRoot = path.resolve(vaultRoot);

  console.log(`[vault-sync] Starting headless daemon for vault: ${absVaultRoot}`);

  const settings = loadConfig(absVaultRoot);
  const vaultAdapter = new FilesystemVaultAdapter(absVaultRoot);
  const stateStore = new JsonStateStore(path.join(absVaultRoot, STATE_FILENAME));
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

  const watcher = chokidar.watch(absVaultRoot, {
    ignoreInitial: true,
    persistent: true,
    ignored: (filePath: string) => {
      const rel = path.relative(absVaultRoot, filePath);
      return excludePatterns.some((p) => rel === p || rel.startsWith(p + path.sep));
    },
  });

  function toVaultFile(filePath: string): VaultFile {
    const rel = path.relative(absVaultRoot, filePath);
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(filePath);
    } catch {
      // File deleted or unreadable
    }
    return {
      kind: "file",
      path: rel,
      mtime: stat ? stat.mtimeMs : 0,
      size: stat ? stat.size : 0,
    };
  }

  watcher.on("add", (filePath) => {
    engine.handleLocalChange(toVaultFile(filePath));
  });

  watcher.on("change", (filePath) => {
    engine.handleLocalChange(toVaultFile(filePath));
  });

  watcher.on("unlink", (filePath) => {
    const rel = path.relative(absVaultRoot, filePath);
    const file: VaultEntry = { kind: "file", path: rel, mtime: 0, size: 0 };
    engine.handleLocalDelete(file);
  });

  watcher.on("rename", (oldPath: string, newPath: string) => {
    if (newPath) {
      const newFile = toVaultFile(newPath);
      const oldRel = path.relative(absVaultRoot, oldPath);
      engine.handleLocalRename(newFile, oldRel);
    }
  });

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

main().catch((e) => {
  console.error("[vault-sync] Fatal error:", e);
  process.exit(1);
});
