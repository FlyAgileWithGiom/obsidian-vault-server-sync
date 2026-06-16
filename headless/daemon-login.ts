import {
  generatePkce,
  buildAuthorizeUrl,
  exchangeCode,
  registerClient,
  validateCallbackParams,
} from "../src/clerk-oauth";
import type { SecretStore } from "../src/secret-store";
import { SECRET_ID_GATEWAY_CLIENT_ID } from "../src/secret-store";

/**
 * Headless Clerk OAuth login for the vault-sync daemon.
 *
 * The daemon has no Obsidian protocol handler, so it cannot use the plugin's
 * obsidian:// redirect. Per RFC 8252 it uses a loopback redirect
 * (http://127.0.0.1:PORT/callback): open the system browser once, let Clerk
 * (proxied by the gateway) redirect back to a short-lived local HTTP server,
 * capture the authorization code, exchange it, and persist the rotating refresh
 * token (+ client_id) in the Keychain.
 *
 * This module owns the runtime-agnostic ORCHESTRATION and the security-critical
 * parsing/validation (state CSRF guard, loopback callback parsing). The actual
 * side-effects — opening the browser and running the loopback HTTP server — are
 * injected (openBrowser / waitForCode) so the orchestration is unit-testable with
 * a fake store and mock fetch. The thin Node side-effect wiring lives in main.ts.
 */

/**
 * Canonical OAuth scope for the daemon login.
 *
 * offline_access is REQUIRED so Clerk issues a refresh token — the daemon runs
 * unattended and must refresh the 1-day access JWT without re-prompting the user.
 */
export const DAEMON_OAUTH_SCOPE = "offline_access";

// Bytes of entropy for the opaque OAuth `state` CSRF/replay guard. 32 bytes
// base64url-encodes to a 43-char value, matching the PKCE verifier strength.
const STATE_ENTROPY_BYTES = 32;

/**
 * Generate an opaque, high-entropy OAuth `state` value.
 *
 * The state is echoed back on the callback and compared (parseLoopbackCallback);
 * a mismatch means the callback did not originate from this login attempt.
 */
export function generateState(): string {
  const bytes = new Uint8Array(STATE_ENTROPY_BYTES);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Result of a successful loopback callback parse. */
export interface LoopbackCallbackResult {
  code: string;
}

/**
 * Parse the loopback redirect callback request and validate it.
 *
 * Accepts either a path-only request target (Node's req.url, e.g.
 * "/callback?code=...&state=...") or an absolute URL; both forms are normalised
 * against a dummy base so URLSearchParams can read the query.
 *
 * Security invariants (all throw on violation, never silently proceed):
 *   - The `state` MUST be present and equal the expected value (CSRF/replay guard).
 *   - An OAuth `error` param (e.g. access_denied) surfaces as a thrown error so the
 *     failure is visible — never mistaken for a missing code.
 *   - A `code` MUST be present on success.
 */
export function parseLoopbackCallback(
  requestUrl: string,
  expectedState: string,
): LoopbackCallbackResult {
  // Normalise a path-only target ("/callback?...") to an absolute URL so the
  // standard URL parser can read the query string. The base host is irrelevant —
  // only the query is consumed.
  const url = new URL(requestUrl, "http://127.0.0.1");
  // The state/error/code validation is shared with the plugin's obsidian://
  // callback via validateCallbackParams — single source of truth so neither
  // client drifts on the CSRF/error/code invariants.
  return validateCallbackParams(url.searchParams, expectedState);
}

/** Dependencies for runLogin — side-effects injected for testability. */
export interface RunLoginDeps {
  /** Gateway base URL (the Obsidian connector URL, e.g. https://mcp.fly-agile.com). */
  gatewayUrl: string;
  /**
   * Statically-configured public client_id. When omitted, runLogin obtains one via
   * Dynamic Client Registration and persists it.
   */
  clientId?: string;
  /** Secret store the refresh token (+ client_id) is persisted into. */
  store: SecretStore;
  /** Opens the system browser at the given authorize URL (thin side-effect). */
  openBrowser: (url: string) => Promise<void>;
  /**
   * Runs the loopback HTTP server (or manual paste flow), returns the captured
   * authorization code. Receives the redirect URI it must bind/expect so the
   * port stays consistent with the authorize request. State validation happens
   * inside this callback (it sees the raw request and calls parseLoopbackCallback).
   */
  waitForCode: (redirectUri: string, expectedState: string) => Promise<string>;
  /**
   * The loopback redirect URI to use. When omitted, the caller is expected to
   * supply one via waitForCode binding; tests and the production wiring pass an
   * explicit value built from the chosen port.
   */
  redirectUri?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
}

// Default loopback redirect when the caller does not supply one. Port 0 lets the
// OS assign a free port; the production wiring overrides this with the bound port.
const DEFAULT_LOOPBACK_REDIRECT = "http://127.0.0.1:0/callback";

/**
 * Run the full headless login: PKCE -> authorize -> capture code -> exchange ->
 * persist. Returns nothing; on success the store holds a fresh refresh token and
 * client_id. Throws on any failure (state mismatch, OAuth error, exchange non-2xx)
 * so the caller (the --login one-shot) can exit non-zero with a clear message.
 *
 * The access token returned by the exchange is intentionally discarded here: the
 * daemon's steady-state token manager re-derives it from the stored refresh token.
 */
export async function runLogin(deps: RunLoginDeps): Promise<void> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const redirectUri = deps.redirectUri ?? DEFAULT_LOOPBACK_REDIRECT;

  // Obtain a client_id: use the configured one, else register a public client via DCR.
  let clientId = deps.clientId;
  if (!clientId) {
    const reg = await registerClient({
      gatewayUrl: deps.gatewayUrl,
      redirectUris: [redirectUri],
      fetch: fetchFn,
    });
    clientId = reg.clientId;
  }
  // Persist the client_id (public identifier) so later starts and re-logins reuse it.
  await deps.store.set(SECRET_ID_GATEWAY_CLIENT_ID, clientId);

  const { codeVerifier, codeChallenge } = await generatePkce();
  const state = generateState();

  const authorizeUrl = buildAuthorizeUrl({
    gatewayUrl: deps.gatewayUrl,
    clientId,
    redirectUri,
    scope: DAEMON_OAUTH_SCOPE,
    state,
    codeChallenge,
  });

  // Side-effects: open the browser, then await the loopback callback (or paste).
  await deps.openBrowser(authorizeUrl);
  const code = await deps.waitForCode(redirectUri, state);

  // Exchange the code; exchangeCode persists the refresh token. Access token is
  // returned but deliberately not used here (the token manager re-derives it).
  await exchangeCode({
    gatewayUrl: deps.gatewayUrl,
    clientId,
    code,
    codeVerifier,
    redirectUri,
    store: deps.store,
    fetch: fetchFn,
  });
}
