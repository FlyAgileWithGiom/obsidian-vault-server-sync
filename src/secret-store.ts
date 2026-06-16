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
 * Gateway Clerk OAuth credential ids (public PKCE client).
 *
 * The sync clients authenticate as PUBLIC OAuth clients using authorization-code
 * + PKCE against Clerk (proxied by the gateway). A public client has NO
 * client_secret, so only two values are persisted:
 *
 *   - client_id: the OAuth client identifier. When the client is registered via
 *     Dynamic Client Registration it is assigned at registration time and stored
 *     here; a statically-configured client_id is stored here too. It is not a
 *     secret, but persisting it avoids re-registering on every start.
 *   - refresh_token: the long-lived rotating token. Clerk rotates the refresh
 *     token on every use and never expires it, so the new value MUST be persisted
 *     immediately after each token exchange to survive a process restart.
 *
 * The access token is a short-lived (1-day) Clerk JWT, derived on demand from the
 * refresh token and held in-memory ONLY — it is never written to the store.
 *
 * "No in-vault legacy" for these IDs: the `legacy` parameter for resolveSecret()
 * is always "" (empty string), which degrades to a plain auth failure rather
 * than a destructive re-pull — consistent with the fail-safe in the ADR.
 */
export const SECRET_ID_GATEWAY_CLIENT_ID = "vault-sync-gateway-client-id";
export const SECRET_ID_GATEWAY_REFRESH_TOKEN = "vault-sync-gateway-refresh-token";

/** Environment-variable names for gateway Clerk OAuth credentials. */
export const ENV_GATEWAY_CLIENT_ID = "VAULT_SYNC_GATEWAY_CLIENT_ID";
export const ENV_GATEWAY_REFRESH_TOKEN = "VAULT_SYNC_GATEWAY_REFRESH_TOKEN";

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
