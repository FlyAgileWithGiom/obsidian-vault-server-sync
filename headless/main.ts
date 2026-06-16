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
import * as readline from "node:readline";
import { spawn } from "node:child_process";
import type { SecretStore } from "../src/secret-store";
import {
  resolveSecret,
  SECRET_ID_COUCH_USER,
  SECRET_ID_COUCH_PASSWORD,
  ENV_COUCH_USER,
  ENV_COUCH_PASSWORD,
  SECRET_ID_GATEWAY_REFRESH_TOKEN,
} from "../src/secret-store";
import { KeychainSecretStore, KEYCHAIN_SERVICE } from "./keychain-secret-store";
import { makeTokenManager } from "../src/gateway-fetch";
import {
  buildGatewayCredsResolver,
  resolveGatewayClientId,
} from "./gateway-resolver";
import { runLogin, parseLoopbackCallback } from "./daemon-login";

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
 *
 * Gateway (Clerk OAuth) mode: the CouchDB proxy authenticates with a Bearer JWT,
 * not embedded Basic credentials. Pass opts.authHeader (e.g. "Bearer <jwt>") to
 * send that header instead; it takes precedence over any URL-embedded Basic auth.
 */
export function makeHttpRemoteDb(
  rawUrl: string,
  opts: { authHeader?: string } = {},
): RemoteDbForPhantomCheck {
  const parsed = new URL(rawUrl);
  const isHttps = parsed.protocol === "https:";
  // An explicit authHeader (gateway Bearer) overrides URL-embedded Basic auth.
  const auth = opts.authHeader
    ? opts.authHeader
    : parsed.username
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
            // Reject on HTTP error status codes (401/403/5xx) so callers receive a
            // proper rejection rather than silently resolving with a CouchDB error body.
            // Without this guard, a 401 would resolve with {"error":"unauthorized",...}
            // and reconcile would silently skip with no user-visible signal.
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`CouchDB _all_docs failed: HTTP ${res.statusCode}`));
              return;
            }
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

/**
 * Build the startup phantom-check remote, choosing auth mode the same way the
 * engine does so the two never disagree about how to reach CouchDB:
 *
 *   - Gateway (Clerk OAuth) mode — gatewayUrl is set AND the daemon has logged in
 *     (client_id + refresh token present): derive a fresh access JWT via the token
 *     manager and target {gatewayUrl}/couchdb/{couchDbName} with a Bearer header.
 *   - Legacy mode — anything else: target the direct-CouchDB URL with embedded
 *     Basic credentials, exactly as before.
 *
 * The access token is acquired once at startup (the phantom check is a one-shot),
 * so a static Bearer header is correct here; live replication uses the rotating
 * gatewayCredsResolver instead.
 *
 * `env` is injected for tests; production resolves from process.env.
 */
export async function buildPhantomCheckRemote(
  settings: VaultSyncSettings,
  store: SecretStore,
  opts: { env?: Record<string, string | undefined> } = {},
): Promise<RemoteDbForPhantomCheck> {
  const env = opts.env ?? process.env;
  const { couchDbUrl, couchDbName, couchDbUser, couchDbPassword, gatewayUrl } = settings;

  // Gateway mode requires a gatewayUrl, a resolvable client_id, and a refresh token.
  if (gatewayUrl) {
    const clientId = await resolveGatewayClientId({ store, env });
    const refreshToken = await store.get(SECRET_ID_GATEWAY_REFRESH_TOKEN);
    if (clientId && refreshToken) {
      const tokenManager = makeTokenManager({ gatewayUrl, clientId, store });
      const accessToken = await tokenManager.getValidToken();
      const proxyUrl = `${gatewayUrl.replace(/\/$/, "")}/couchdb/${couchDbName}`;
      console.log(`[vault-sync] Phantom check remote (gateway): ${proxyUrl}`);
      return makeHttpRemoteDb(proxyUrl, { authHeader: `Bearer ${accessToken}` });
    }
  }

  // Legacy direct-CouchDB URL with embedded Basic-auth credentials.
  const base = couchDbUrl.replace(/\/$/, "");
  const proto = base.startsWith("https://") ? "https://" : "http://";
  const host = base.slice(proto.length);
  const authPart = (couchDbUser && couchDbPassword)
    ? `${encodeURIComponent(couchDbUser)}:${encodeURIComponent(couchDbPassword)}@`
    : "";
  const remoteDbUrl = `${proto}${authPart}${host}/${couchDbName}`;
  console.log(`[vault-sync] Phantom check remote: ${proto}${host}/${couchDbName}`);
  return makeHttpRemoteDb(remoteDbUrl);
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
  // allowAnyApp so token-rotation writes preserve the no-prompt ACL set at login.
  const store = opts.store ?? new KeychainSecretStore({ allowAnyApp: true });
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
  /**
   * Optional crash-safe replace marker check. When present and returning true,
   * reconcile is skipped entirely regardless of doc_count, because the absence
   * of FS files is intentional (a replace was interrupted). The caller is
   * responsible for resuming the replace (running a fresh full pull) and
   * clearing the marker only after the pull completes successfully.
   *
   * Without this guard, a crash during replaceLocalFromServer() after FS wipe
   * but before/during re-pull would cause reconcile to tombstone all 319 docs
   * (AC2.3a: local rev === remote rev, FS absent → tombstone).
   */
  hasReplaceMarker?: () => boolean;
}): Promise<{
  push: number;
  pull: number;
  tombstone: number;
  conflictCopy: number;
  skip: number;
  /** Per-action failures caught by the resilient apply-loop (#79 crash-loop class). */
  failed: number;
} | null> {
  const { db, bridge, vaultAdapter, remoteDb, excludePatterns } = opts;

  // Crash-safe replace marker gate: a replace was interrupted — skip reconcile
  // entirely. FS absence is intentional. The caller resumes with a fresh pull.
  if (opts.hasReplaceMarker?.()) {
    console.log("[vault-sync] reconcile: replace-in-progress marker found — skipping reconcile (FS-absent files are intentional)");
    return null;
  }

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

  // Apply actions.
  //
  // Resilient apply-loop (#79 crash-loop class): one failed action must NOT abort
  // daemon startup. After FIX #1 (markDeletedInPouch rethrows non-404 errors),
  // reconcileTombstone can throw on a catastrophic non-404 (DB closed / IO error /
  // one bad doc). Without this guard, that propagates out of the loop → out of
  // runReconcile → aborts runDaemonV2Startup → the LaunchAgent restarts → crash-loop
  // on a persistent error. We log-and-continue (NOT silently swallow — that is the
  // anti-pattern FIX #1 removed): each failure is logged + counted, the loop applies
  // the remaining actions. A systemic failure (every action fails) still surfaces
  // downstream at bridge.start / live-sync; this guard only stops one bad apple from
  // taking the daemon down.
  const counts = { push: 0, pull: 0, tombstone: 0, conflictCopy: 0, skip: 0, failed: 0 };
  for (const action of actions) {
    try {
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
    } catch (e) {
      // Log-and-continue: a single failed action (e.g. a tombstone hitting a
      // non-404 from markDeletedInPouch) must not abort the loop → daemon startup.
      // conflict-copy never reaches here (its own inner try/catch above never
      // rethrows), so this counter reflects push/pull/tombstone failures.
      const ref = "path" in action ? action.path : action.docId;
      console.error(
        `[vault-sync] reconcile: action FAILED (${action.kind} ${ref}) — continuing: ${e}`,
      );
      counts.failed++;
    }
  }

  console.log(
    `[vault-sync] reconcile: ↑push=${counts.push} ↓pull=${counts.pull} ` +
    `✗tombstone=${counts.tombstone} ⚡conflict-copy=${counts.conflictCopy} ` +
    `–skip=${counts.skip} ⚠failed=${counts.failed}`,
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

  // Decide auth mode for replication and the phantom check.
  //
  // Gateway (Clerk OAuth) mode is active when a gatewayUrl is configured AND the
  // daemon has logged in (client_id + refresh token present). In that mode the
  // engine routes through the proxy with a Bearer fetch, and the phantom check
  // must use the same Bearer JWT against {gatewayUrl}/couchdb/{couchDbName}.
  // Otherwise both fall back to the legacy direct-CouchDB Basic-auth URL.
  // allowAnyApp so the daemon's silent reads + token-rotation writes never block
  // on a GUI keychain prompt (the daemon is headless under launchd).
  const store = new KeychainSecretStore({ allowAnyApp: true });
  const gatewayCredsResolver = settings.gatewayUrl
    ? buildGatewayCredsResolver({ gatewayUrl: settings.gatewayUrl, store })
    : undefined;

  const remoteDb = await buildPhantomCheckRemote(settings, store);

  // pouchdb-node remoteFactory: builds a remote PouchDB handle from a URL + fetch.
  // The injected fetch (gateway Bearer) is what carries auth in gateway mode.
  const remoteFactory = (url: string, opts: { fetch?: typeof fetch }) =>
    new PouchDB(url, opts) as unknown as import("../src/pouchdb-browser").default;

  // Build engine with injected db and bridge.
  // The remoteFactory + gatewayCredsResolver enable gateway mode; both are no-ops
  // (legacy URL) when gatewayCredsResolver is undefined or resolves to null.
  const engine = new PouchDbSyncEngine(
    settings,
    db,
    bridge,
    dbFactory,
    remoteFactory,
    gatewayCredsResolver,
  );

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

// Loopback redirect: bind 127.0.0.1 on an OS-assigned free port and serve a single
// /callback. RFC 8252 §7.3 mandates the loopback IP literal (not "localhost").
const LOOPBACK_HOST = "127.0.0.1";
// How long the daemon waits for the user to complete the browser login before the
// loopback server gives up. Generous: the user may need to sign in to Clerk first.
const LOOPBACK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Open a URL in the system default browser (macOS `open`, Linux `xdg-open`,
 * Windows `start`). Thin, fire-and-forget side-effect — failures are non-fatal
 * (the user can copy the URL from the printed line or use --paste-code).
 */
async function openSystemBrowser(url: string): Promise<void> {
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
      ? "start"
      : "xdg-open";
  try {
    const child = spawn(opener, [url], { detached: true, stdio: "ignore", shell: process.platform === "win32" });
    child.unref();
  } catch {
    // Non-fatal: the authorize URL is also printed so the user can open it manually.
  }
}

/**
 * Run a one-shot loopback HTTP server on `redirectUri`'s port, resolve with the
 * captured authorization code once the OAuth provider redirects back. Validates
 * the OAuth `state` (via parseLoopbackCallback) before resolving; an invalid
 * state, an OAuth error param, or a timeout rejects.
 *
 * The server is bound to the exact port encoded in `redirectUri` so it matches the
 * redirect the gateway/Clerk will hit. The caller (runLogin) supplies that URI.
 */
function waitForLoopbackCode(redirectUri: string, expectedState: string): Promise<string> {
  const port = Number(new URL(redirectUri).port);
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const { code } = parseLoopbackCallback(req.url ?? "/", expectedState);
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Login complete. You can close this tab and return to the terminal.");
        cleanup();
        resolve(code);
      } catch (e) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Login failed. Check the terminal for details.");
        cleanup();
        reject(e);
      }
    });

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Loopback login timed out after ${LOOPBACK_TIMEOUT_MS / 1000}s.`));
    }, LOOPBACK_TIMEOUT_MS);

    function cleanup(): void {
      clearTimeout(timer);
      server.close();
    }

    server.on("error", (e) => {
      cleanup();
      reject(e);
    });
    server.listen(port, LOOPBACK_HOST);
  });
}

/**
 * Manual fallback for headless boxes with no browser: print the authorize URL and
 * read the pasted authorization code from stdin. The state is still validated —
 * the user pastes only the `code` value, so we trust the manual channel for state
 * (the redirect never reaches a server) but keep the parameter for symmetry.
 */
function readPastedCode(_redirectUri: string, _expectedState: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(
      `\n[vault-sync] After authorizing in your browser, paste the "code" value here and press Enter:\n> `,
      (answer) => {
        rl.close();
        resolve(answer.trim());
      },
    );
  });
}

/**
 * Resolve a free loopback redirect URI by briefly binding a server on port 0 to
 * learn the OS-assigned port, then closing it. There is a small TOCTOU window
 * before waitForLoopbackCode re-binds the same port, but on a single-user box the
 * race is negligible and the alternative (passing a live server handle through
 * runLogin) would couple the orchestration to Node's http server.
 */
function reserveLoopbackRedirect(): Promise<string> {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.on("error", reject);
    probe.listen(0, LOOPBACK_HOST, () => {
      const addr = probe.address() as { port: number };
      const port = addr.port;
      probe.close(() => resolve(`http://${LOOPBACK_HOST}:${port}/callback`));
    });
  });
}

/**
 * The `--login` one-shot: run the interactive Clerk OAuth login and persist the
 * refresh token (+ client_id) into the Keychain. Mirrors --scrub-secrets in that
 * it never starts the daemon. `--login --paste-code` uses the manual stdin flow
 * for headless boxes; otherwise the system browser + loopback server are used.
 */
async function runLoginOneShot(
  absVaultRoot: string,
  opts: { pasteCode: boolean },
): Promise<void> {
  const settings = await loadConfig(absVaultRoot);
  if (!settings.gatewayUrl) {
    console.error(
      `[vault-sync] --login requires "gatewayUrl" in ${CONFIG_FILENAME} ` +
      `(the Obsidian connector URL, e.g. https://mcp.fly-agile.com).`,
    );
    process.exit(1);
  }

  // Interactive login store: a long timeout so the one-time macOS "Always Allow"
  // authorization prompt can be answered before `security` is killed (the daemon's
  // default 5s timeout is far too short for a human), and allowAnyApp so the
  // headless daemon can later read the stored token without its own GUI prompt.
  const store = new KeychainSecretStore({ timeoutMs: 120_000, allowAnyApp: true });
  const redirectUri = await reserveLoopbackRedirect();

  if (opts.pasteCode) {
    // Manual flow: print the authorize URL, read the pasted code from stdin.
    console.log(
      `\n[vault-sync] Manual login (--paste-code). Open this URL in any browser:`,
    );
    await runLogin({
      gatewayUrl: settings.gatewayUrl,
      store,
      redirectUri,
      openBrowser: async (url) => console.log(`\n${url}\n`),
      waitForCode: readPastedCode,
    });
  } else {
    console.log(`[vault-sync] Opening your browser to sign in...`);
    await runLogin({
      gatewayUrl: settings.gatewayUrl,
      store,
      redirectUri,
      openBrowser: async (url) => {
        console.log(`[vault-sync] If the browser did not open, visit:\n${url}\n`);
        await openSystemBrowser(url);
      },
      waitForCode: waitForLoopbackCode,
    });
  }

  // Verify the token actually persisted. The Keychain write silently degrades to a
  // no-op on failure (locked keychain, dismissed/timed-out authorization prompt), so
  // without this check we would falsely report success while the daemon stays on the
  // legacy path. Fail loudly with an actionable message instead.
  const persisted = await store.get(SECRET_ID_GATEWAY_REFRESH_TOKEN);
  if (!persisted) {
    console.error(
      `\n[vault-sync] ERROR: login completed but the refresh token did NOT persist to the Keychain.\n` +
      `  This almost always means the macOS keychain authorization prompt was dismissed\n` +
      `  or timed out. Re-run --login and click "Always Allow" when macOS asks for access\n` +
      `  to "${KEYCHAIN_SERVICE}". (Requires a GUI session — a pure SSH session cannot answer it.)`,
    );
    process.exit(1);
  }

  console.log(`[vault-sync] Login complete — gateway credentials stored in the Keychain.`);
}

async function main(): Promise<void> {
  // Parse argv robustly: flags may precede the vault root
  // (e.g. `daemon --scrub-secrets /path`). First non-flag arg is the vault root.
  const args = process.argv.slice(2);
  const scrubSecrets = args.includes("--scrub-secrets");
  const login = args.includes("--login");
  const pasteCode = args.includes("--paste-code");
  const positional = args.filter((a) => !a.startsWith("--"));
  const vaultRoot = positional[0] ?? process.cwd();
  const absVaultRoot = path.resolve(vaultRoot);

  // --login one-shot (Clerk OAuth): obtain + store gateway credentials, never
  // starts the daemon. Mirrors --scrub-secrets.
  if (login) {
    await runLoginOneShot(absVaultRoot, { pasteCode });
    process.exit(0);
  }

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
