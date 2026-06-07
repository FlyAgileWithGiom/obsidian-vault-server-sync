import type { App } from "obsidian";

/**
 * Out-of-vault credential storage seam (issue #78).
 *
 * `.vault-sync.json` lives inside the synced vault, so any secret written there
 * replicates to Dropbox/iCloud, every linked device, and cloud version history
 * (CWE-312). This seam keeps the secret OUT of the synced file: the plugin uses
 * Obsidian's per-device `app.secretStorage` and the daemon uses the macOS
 * Keychain (see headless/keychain-secret-store.ts).
 *
 * The interface is async (Promise-returning) so the same contract fits both the
 * synchronous Obsidian `secretStorage` API and the inherently-async macOS
 * `security` CLI.
 */
export interface SecretStore {
  /** Returns the stored secret for `id`, or null if absent / store unavailable. */
  get(id: string): Promise<string | null>;
  /** Stores `value` under `id`. No-op if the store is unavailable. */
  set(id: string, value: string): Promise<void>;
  /** Whether the underlying backend is usable on this runtime. */
  isAvailable(): boolean;
}

/**
 * Logical credential → Obsidian secret id.
 *
 * Obsidian `SecretStorage` ids must be lowercase alphanumeric with optional
 * dashes (@since 1.11.4), so `couchDbUser` / `couchDbPassword` cannot be used
 * verbatim. These constants are the single source of truth for both the plugin
 * store and the daemon Keychain account names.
 */
export const SECRET_ID_COUCH_USER = "vault-sync-couch-user";
export const SECRET_ID_COUCH_PASSWORD = "vault-sync-couch-password";

/** Environment-variable names that take precedence over any stored secret. */
export const ENV_COUCH_USER = "VAULT_SYNC_COUCH_USER";
export const ENV_COUCH_PASSWORD = "VAULT_SYNC_COUCH_PASSWORD";

/**
 * Minimal shape of Obsidian's synchronous SecretStorage API (>= 1.11.4).
 * Declared locally so feature-detection works even when the installed typings
 * predate the API.
 */
interface SecretStorageApi {
  setSecret(id: string, secret: string): void;
  getSecret(id: string): string | null;
  listSecrets(): string[];
}

/**
 * SecretStore backed by Obsidian's `app.secretStorage` (per-device, never synced).
 *
 * Feature-detects `secretStorage` at runtime: the manifest bump to minAppVersion
 * 1.11.4 does not guarantee the API is present on every install (BRAT, sideloads),
 * so an absent store degrades to `isAvailable() === false` and null reads, letting
 * the caller fall back to the legacy in-vault credential rather than crash.
 */
export class SecretStorageSecretStore implements SecretStore {
  private readonly api: SecretStorageApi | null;

  constructor(app: App) {
    const candidate = (app as unknown as { secretStorage?: SecretStorageApi }).secretStorage;
    this.api =
      candidate &&
      typeof candidate.getSecret === "function" &&
      typeof candidate.setSecret === "function"
        ? candidate
        : null;
  }

  isAvailable(): boolean {
    return this.api !== null;
  }

  async get(id: string): Promise<string | null> {
    if (!this.api) return null;
    try {
      return this.api.getSecret(id);
    } catch {
      // Never let a backend hiccup escalate into a sync failure.
      return null;
    }
  }

  async set(id: string, value: string): Promise<void> {
    if (!this.api) return;
    try {
      this.api.setSecret(id, value);
    } catch {
      // Best-effort: a failed write leaves the legacy in-vault value in place.
    }
  }
}

/**
 * iOS-safe environment-variable reader.
 *
 * `process` (and therefore `process.env`) is undefined on iOS Obsidian, so the
 * env source is passed in and treated as optional. Returns null for an
 * absent/empty value rather than throwing on the exact platform the AC names.
 */
export function readEnvSecret(
  name: string,
  env: Record<string, string | undefined> | undefined,
): string | null {
  if (!env) return null;
  const v = env[name];
  return v ? v : null;
}

/**
 * Resolve a single secret by the locked precedence: env > store > legacy in-vault.
 *
 * Fail-safe (invariant 8): when nothing is found anywhere, returns the legacy
 * value as-is (typically ""), so the caller builds a credential-less URL that
 * yields a plain auth failure — never a tombstone-everything / destructive
 * re-pull.
 */
export async function resolveSecret(opts: {
  envName: string;
  env: Record<string, string | undefined> | undefined;
  store: SecretStore;
  id: string;
  legacy: string;
}): Promise<string> {
  const fromEnv = readEnvSecret(opts.envName, opts.env);
  if (fromEnv !== null) return fromEnv;

  if (opts.store.isAvailable()) {
    const fromStore = await opts.store.get(opts.id);
    if (fromStore) return fromStore;
  }

  return opts.legacy;
}
