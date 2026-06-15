import type { SecretStore } from "./secret-store";
import { SECRET_ID_GATEWAY_REFRESH_TOKEN } from "./secret-store";

/**
 * Gateway OAuth2 token response shape.
 *
 * Matches the real gateway contract (mcp-gateway PR #2):
 *   POST /token -> { access_token, refresh_token, token_type:"Bearer", expires_in:86400 }
 *
 * The gateway uses rotating refresh tokens: every successful refresh returns a
 * NEW refresh_token that invalidates the previous one, so the new value must be
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
 * clientId and clientSecret are the long-lived machine credentials provisioned
 * via POST /credentials/provision on the gateway. They remain stable across
 * token refreshes and are resolved from the secret store before calling this
 * factory (see resolveSecret() usage in the engine/daemon).
 */
export interface TokenManagerOpts {
  gatewayUrl: string;
  clientId: string;
  clientSecret: string;
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
   * - No token / expired: initiates a new token exchange (refresh_token grant
   *   if a stored refresh token exists, otherwise client_credentials).
   *
   * Throws if the gateway token endpoint returns a non-2xx response.
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

/**
 * Create a stateful token manager that handles the full OAuth2 token lifecycle:
 * initial client_credentials grant, refresh_token rotation, in-memory caching,
 * and single-flight mutex protection against refresh storms.
 *
 * The access token is held in-memory only and is NEVER written to the store.
 * The rotating refresh token IS written to the store on every successful exchange
 * so it survives process restarts.
 *
 * This function depends only on the global `fetch`, so it works identically
 * under pouchdb-browser (Obsidian plugin) and pouchdb-node (headless daemon).
 */
export function makeTokenManager(opts: TokenManagerOpts): TokenManager {
  const { gatewayUrl, clientId, clientSecret, store } = opts;
  const tokenUrl = `${gatewayUrl}/token`;

  // In-memory token state — never serialised or persisted.
  let accessToken: string | null = null;
  let expiresAt: number = 0;

  // Single-flight mutex: when a refresh is in progress, subsequent callers
  // (including concurrent forceRefresh() calls after a 401) await this promise
  // rather than issuing additional /token requests.
  let refreshInFlight: Promise<void> | null = null;

  async function doTokenExchange(): Promise<void> {
    // Prefer refresh_token grant when a stored refresh token is available.
    // Fall back to client_credentials when no refresh token exists yet
    // (first-time provisioning or after a deliberate token scrub).
    const storedRefreshToken = await store.get(SECRET_ID_GATEWAY_REFRESH_TOKEN);

    let body: string;
    if (storedRefreshToken) {
      body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: storedRefreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString();
    } else {
      body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }).toString();
    }

    const resp = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!resp.ok) {
      // Propagate gateway errors (e.g. 401 invalid_client) as thrown errors
      // so the caller knows the refresh failed entirely.
      const text = await resp.text().catch(() => "");
      throw new Error(`Gateway token endpoint returned ${resp.status}: ${text}`);
    }

    const data = (await resp.json()) as GatewayTokenResponse;

    // Persist the rotating refresh token so the next process startup can skip
    // client_credentials and go straight to refresh_token grant.
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
