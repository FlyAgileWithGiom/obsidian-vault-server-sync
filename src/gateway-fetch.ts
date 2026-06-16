import type { SecretStore } from "./secret-store";
import { SECRET_ID_GATEWAY_REFRESH_TOKEN } from "./secret-store";

/**
 * Gateway OAuth token response shape.
 *
 * Matches the Clerk token contract proxied by the gateway:
 *   POST /token -> { access_token, refresh_token, token_type:"Bearer", expires_in:86400 }
 *
 * Clerk uses rotating refresh tokens: every successful refresh returns a NEW
 * refresh_token that invalidates the previous one, so the new value must be
 * persisted immediately after each successful token exchange.
 */
export interface GatewayTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number; // seconds
}

/**
 * Configuration for makeTokenManager.
 *
 * clientId is the public PKCE OAuth client identifier (statically configured or
 * DCR-registered). A public client has NO client_secret, so none is supplied
 * here. The initial token is always obtained via the refresh_token grant using a
 * refresh token previously stored by the interactive Clerk login — this factory
 * never performs the initial authorization-code exchange (that is the job of
 * clerk-oauth.ts, run once at login time).
 */
export interface TokenManagerOpts {
  gatewayUrl: string;
  clientId: string;
  store: SecretStore;
}

/**
 * Public interface for the token manager returned by makeTokenManager.
 */
export interface TokenManager {
  /**
   * Returns a valid access token.
   *
   * - Cache hit (token present and not expired): returns immediately.
   * - In-flight refresh (another caller is already refreshing): awaits that
   *   in-flight promise and returns the freshly set token. This is the
   *   single-flight invariant — exactly one network round-trip per refresh
   *   cycle regardless of how many concurrent callers hit an expiry simultaneously.
   * - No token / expired: initiates a refresh_token grant using the stored
   *   refresh token.
   *
   * Throws if no refresh token is stored, or if the gateway token endpoint
   * returns a non-2xx response.
   */
  getValidToken(): Promise<string>;

  /**
   * Invalidates the in-memory token and forces a new token exchange.
   *
   * Called by makeGatewayFetch after a 401 response, which indicates the
   * server-side token was rejected even though our local cache considered it
   * valid. The single-flight mutex ensures that N concurrent 401 callers
   * trigger exactly ONE network refresh request.
   *
   * Throws if the gateway token endpoint returns a non-2xx response.
   */
  forceRefresh(): Promise<string>;
}

// A small grace margin (30 s) subtracted from expires_in before caching,
// so the token is refreshed slightly before the gateway truly expires it.
const TOKEN_EXPIRY_GRACE_MS = 30_000;

// Cap how much of a non-credential gateway error body we surface in a thrown
// Error (it reaches logs and user notifications). Credential failures (401/403)
// surface no body at all.
const GATEWAY_ERROR_BODY_MAX = 200;

/**
 * Create a stateful token manager that handles the steady-state OAuth token
 * lifecycle for a public PKCE client: refresh_token rotation, in-memory caching,
 * and single-flight mutex protection against refresh storms.
 *
 * The access token is held in-memory only and is NEVER written to the store.
 * The rotating refresh token IS written to the store on every successful exchange
 * so it survives process restarts.
 *
 * The initial refresh token must already be present in the store (placed there by
 * the interactive Clerk login in clerk-oauth.ts). With no stored refresh token the
 * manager cannot acquire an access token and throws — there is no client_secret
 * and therefore no client_credentials fallback.
 *
 * This function depends only on the global `fetch`, so it works identically
 * under pouchdb-browser (Obsidian plugin) and pouchdb-node (headless daemon).
 */
export function makeTokenManager(opts: TokenManagerOpts): TokenManager {
  const { gatewayUrl, clientId, store } = opts;
  const tokenUrl = `${gatewayUrl}/token`;

  // In-memory token state — never serialised or persisted.
  let accessToken: string | null = null;
  let expiresAt: number = 0;

  // Single-flight mutex: when a refresh is in progress, subsequent callers
  // (including concurrent forceRefresh() calls after a 401) await this promise
  // rather than issuing additional /token requests.
  let refreshInFlight: Promise<void> | null = null;

  async function doTokenExchange(): Promise<void> {
    // Public PKCE client: the only grant available is refresh_token. The initial
    // refresh token comes from the interactive Clerk login (clerk-oauth.ts). With
    // no stored refresh token there is nothing to exchange and no client_secret to
    // fall back on — throw so the caller can prompt the user to log in again.
    const storedRefreshToken = await store.get(SECRET_ID_GATEWAY_REFRESH_TOKEN);
    if (!storedRefreshToken) {
      throw new Error(
        "No gateway refresh token stored — interactive Clerk login required before sync can authenticate.",
      );
    }

    // client_id is sent (Clerk binds the refresh token to it); a public PKCE
    // client has no client_secret.
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: storedRefreshToken,
      client_id: clientId,
    }).toString();

    const resp = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!resp.ok) {
      // Propagate gateway errors (e.g. 401 invalid_client) as thrown errors
      // so the caller knows the refresh failed entirely. Do NOT echo the raw
      // body on credential failures (it can carry submitted token material), and
      // cap it otherwise — this error surfaces in logs and user notifications.
      if (resp.status === 401 || resp.status === 403) {
        throw new Error(`Gateway token endpoint returned ${resp.status} (invalid credentials)`);
      }
      const detail = (await resp.text().catch(() => "")).slice(0, GATEWAY_ERROR_BODY_MAX);
      throw new Error(`Gateway token endpoint returned ${resp.status}: ${detail}`);
    }

    const data = (await resp.json()) as GatewayTokenResponse;

    // Persist the rotated refresh token immediately: Clerk invalidates the
    // previous one, so the new value must replace it to survive a process restart.
    await store.set(SECRET_ID_GATEWAY_REFRESH_TOKEN, data.refresh_token);

    // Cache the access token in-memory only — never write to the store.
    accessToken = data.access_token;
    expiresAt = Date.now() + data.expires_in * 1_000 - TOKEN_EXPIRY_GRACE_MS;
  }

  /**
   * Shared acquire-or-wait logic: if no refresh is in-flight, start one.
   * If one is already in-flight, coalesce onto it (single-flight).
   */
  async function acquireToken(): Promise<void> {
    if (refreshInFlight !== null) {
      await refreshInFlight;
      return;
    }
    refreshInFlight = doTokenExchange().finally(() => {
      refreshInFlight = null;
    });
    await refreshInFlight;
  }

  return {
    async getValidToken(): Promise<string> {
      // Fast path: valid in-memory token.
      if (accessToken !== null && Date.now() < expiresAt) {
        return accessToken;
      }
      await acquireToken();
      return accessToken as string;
    },

    async forceRefresh(): Promise<string> {
      // Invalidate the cached token so the next acquireToken() call issues a
      // real network request even if the clock still considers it unexpired.
      // (The server has rejected it, so our local expiry estimate was wrong.)
      accessToken = null;
      expiresAt = 0;
      await acquireToken();
      return accessToken as string;
    },
  };
}

/**
 * Options for makeGatewayFetch.
 */
export interface GatewayFetchOpts {
  tokenManager: TokenManager;
}

/**
 * Returns a `fetch`-compatible function that:
 * 1. Obtains a valid Bearer token from the token manager.
 * 2. Injects `Authorization: Bearer <token>` into every request.
 * 3. On a 401 response, calls tokenManager.forceRefresh() — the single-flight
 *    mutex in the token manager ensures that N concurrent 401 callers trigger
 *    exactly ONE network refresh request — and retries the original request once.
 * 4. If the retry also fails (401 or otherwise), surfaces the response without
 *    further retries — avoids infinite loops on truly revoked credentials.
 *
 * This function depends only on the global `fetch` and the injected
 * tokenManager, so it is runtime-agnostic (works under both pouchdb-browser
 * and pouchdb-node). It is passed as the `fetch` option to PouchDB:
 *   new PouchDB(remoteUrl, { fetch: makeGatewayFetch({ tokenManager }) })
 */
export function makeGatewayFetch(opts: GatewayFetchOpts): typeof fetch {
  const { tokenManager } = opts;

  return async function gatewayFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    // Obtain (or reuse cached) access token.
    const token = await tokenManager.getValidToken();

    // Merge the Authorization header into the caller's init, preserving any
    // other headers the caller provided (e.g. Content-Type, If-None-Match).
    const authedInit: RequestInit = {
      ...init,
      headers: {
        ...(init?.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${token}`,
      },
    };

    const response = await fetch(input, authedInit);

    // On 401, force-invalidate the cached token and retry exactly once.
    // The token manager's single-flight mutex ensures that concurrent callers
    // all hitting 401 at the same time only trigger ONE /token request.
    if (response.status === 401) {
      const freshToken = await tokenManager.forceRefresh();
      const retryInit: RequestInit = {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string> | undefined),
          Authorization: `Bearer ${freshToken}`,
        },
      };
      // Retry once; whatever the server returns (200 or another 401) is final.
      return fetch(input, retryInit);
    }

    return response;
  };
}
