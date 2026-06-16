import type { SecretStore } from "./secret-store";
import { SECRET_ID_GATEWAY_REFRESH_TOKEN } from "./secret-store";
import type { GatewayTokenResponse } from "./gateway-fetch";

/**
 * Runtime-agnostic Clerk OAuth helpers for the interactive login that seeds the
 * sync clients' credentials.
 *
 * The gateway is a pure OAuth Resource Server with Clerk as the Authorization
 * Server. It proxies /authorize and /token to Clerk and (optionally) /register
 * for Dynamic Client Registration. The sync clients are PUBLIC PKCE clients:
 * no client_secret, authorization-code + PKCE (S256), refresh tokens via the
 * offline_access scope.
 *
 * This module depends only on the global `fetch` and Web Crypto (`crypto.subtle`),
 * so it runs identically under pouchdb-browser (Obsidian plugin, desktop + iOS)
 * and pouchdb-node (headless daemon). The steady-state refresh lifecycle lives in
 * gateway-fetch.ts; this module is run ONCE per login to obtain the first refresh
 * token (and, optionally, to register a client_id via DCR).
 */

// PKCE verifier length (RFC 7636 allows 43-128 chars of the unreserved set).
// 32 random bytes base64url-encode to 43 chars — the minimum that satisfies the
// spec while keeping the URL compact.
const PKCE_VERIFIER_BYTES = 32;

// Cap how much of a non-2xx error body we surface in a thrown Error (it reaches
// logs and user notifications). The token/register bodies can echo submitted
// material, so never surface them verbatim — only the cap and the status.
const ERROR_BODY_MAX = 200;

/** PKCE pair: the secret verifier and its S256-derived public challenge. */
export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

/**
 * Base64url-encode raw bytes (unpadded), per RFC 7636 / RFC 4648 §5.
 * Used for both the random verifier and the SHA-256 challenge digest.
 */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Generate a PKCE verifier/challenge pair using S256.
 *
 * The verifier is cryptographically-random bytes base64url-encoded; the challenge
 * is base64url(SHA-256(verifier)). The verifier is held by the caller until the
 * token exchange; the challenge is what goes on the wire in the authorize request.
 */
export async function generatePkce(): Promise<PkcePair> {
  const randomBytes = new Uint8Array(PKCE_VERIFIER_BYTES);
  crypto.getRandomValues(randomBytes);
  const codeVerifier = base64UrlEncode(randomBytes);

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );
  const codeChallenge = base64UrlEncode(new Uint8Array(digest));

  return { codeVerifier, codeChallenge };
}

/** Parameters for buildAuthorizeUrl. */
export interface AuthorizeUrlOpts {
  gatewayUrl: string;
  clientId: string;
  redirectUri: string;
  /** Space-delimited scopes. Must include `offline_access` for a refresh token. */
  scope: string;
  /** Opaque CSRF/replay guard echoed back on the callback. */
  state: string;
  /** The S256 code_challenge from generatePkce(). */
  codeChallenge: string;
}

/**
 * Build the authorization-code + PKCE authorize URL: GET {gatewayUrl}/authorize.
 *
 * The gateway proxies this to Clerk. The custom-scheme (obsidian://) or loopback
 * (http://127.0.0.1) redirect_uri is percent-encoded by URLSearchParams so it
 * survives the round-trip intact.
 */
export function buildAuthorizeUrl(opts: AuthorizeUrlOpts): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: opts.scope,
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${stripTrailingSlash(opts.gatewayUrl)}/authorize?${params.toString()}`;
}

/** Parameters for exchangeCode. */
export interface ExchangeCodeOpts {
  gatewayUrl: string;
  clientId: string;
  /** The authorization code returned on the redirect callback. */
  code: string;
  /** The PKCE verifier paired with the challenge used in buildAuthorizeUrl. */
  codeVerifier: string;
  /** Must match the redirect_uri sent to /authorize. */
  redirectUri: string;
  /** Secret store the rotating refresh token is persisted into. */
  store: SecretStore;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Exchange an authorization code for tokens: POST {gatewayUrl}/token with the
 * authorization_code grant (form-encoded), then persist the refresh token.
 *
 * Public PKCE client: the body carries code_verifier + client_id but NO
 * client_secret. On success the rotating refresh token is written to the store
 * (the token manager rotates it from there); the access token is returned for the
 * caller to use immediately but is never persisted.
 *
 * Throws on a non-2xx response with the status (never the raw body, which may echo
 * submitted code/verifier material) so the failure is visible without leaking
 * secrets into logs or the settings panel.
 */
export async function exchangeCode(opts: ExchangeCodeOpts): Promise<GatewayTokenResponse> {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const tokenUrl = `${stripTrailingSlash(opts.gatewayUrl)}/token`;

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    code_verifier: opts.codeVerifier,
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
  }).toString();

  const resp = await fetchFn(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!resp.ok) {
    const detail = (await resp.text().catch(() => "")).slice(0, ERROR_BODY_MAX);
    throw new Error(`Clerk token exchange returned ${resp.status}: ${detail}`);
  }

  const data = (await resp.json()) as GatewayTokenResponse;

  // Persist the refresh token so the token manager can rotate it on later starts.
  // The access token is in-memory only — it is returned, never stored.
  await opts.store.set(SECRET_ID_GATEWAY_REFRESH_TOKEN, data.refresh_token);

  return data;
}

/** Parameters for registerClient. */
export interface RegisterClientOpts {
  gatewayUrl: string;
  redirectUris: string[];
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
}

/** Result of Dynamic Client Registration: the assigned public client_id. */
export interface RegisterClientResult {
  clientId: string;
}

/**
 * Register a public client via Dynamic Client Registration: POST {gatewayUrl}/register.
 *
 * Optional — used only when a client_id must be obtained dynamically rather than
 * configured statically. Returns the assigned client_id (a public identifier, not
 * a secret). Throws on a non-2xx response.
 */
export async function registerClient(opts: RegisterClientOpts): Promise<RegisterClientResult> {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const registerUrl = `${stripTrailingSlash(opts.gatewayUrl)}/register`;

  const resp = await fetchFn(registerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: opts.redirectUris,
      token_endpoint_auth_method: "none", // public PKCE client: no client_secret
    }),
  });

  if (!resp.ok) {
    const detail = (await resp.text().catch(() => "")).slice(0, ERROR_BODY_MAX);
    throw new Error(`Dynamic Client Registration returned ${resp.status}: ${detail}`);
  }

  const data = (await resp.json()) as { client_id: string };
  return { clientId: data.client_id };
}

/** Result of a validated OAuth authorization-code callback. */
export interface CallbackParams {
  code: string;
}

/**
 * Validate the query parameters of an OAuth authorization-code callback and
 * extract the authorization code.
 *
 * This is the security-critical core shared by BOTH clients: the daemon's
 * loopback HTTP callback and the plugin's obsidian:// protocol-handler callback.
 * Both parse a `URLSearchParams` (the daemon from the loopback request URL, the
 * plugin from the Obsidian-supplied protocol params) and submit it here so the
 * state/error/code invariants are enforced identically — neither client can drift.
 *
 * Invariants (all throw on violation; never silently proceed):
 *   - The `state` MUST be present and equal `expectedState`. This is checked
 *     FIRST, before any other param is trusted: a tampered/absent state means the
 *     callback did not originate from this login attempt (CSRF/replay guard).
 *   - An explicit OAuth `error` (e.g. access_denied) surfaces as a thrown error so
 *     the failure is visible — never mistaken for a missing code.
 *   - A `code` MUST be present on success.
 */
export function validateCallbackParams(
  params: URLSearchParams,
  expectedState: string,
): CallbackParams {
  // Validate state BEFORE trusting any other param.
  const state = params.get("state");
  if (!state || state !== expectedState) {
    throw new Error("OAuth callback state mismatch — possible CSRF/replay; login aborted.");
  }

  // Surface an explicit OAuth error (user denied, invalid request, etc.) rather
  // than reporting a confusing "missing code".
  const error = params.get("error");
  if (error) {
    throw new Error(`OAuth authorization failed: ${error}`);
  }

  const code = params.get("code");
  if (!code) {
    throw new Error("OAuth callback missing authorization code.");
  }

  return { code };
}

/** Remove a single trailing slash so URL concatenation never doubles it. */
function stripTrailingSlash(url: string): string {
  return url.replace(/\/$/, "");
}
