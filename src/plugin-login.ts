import {
  generatePkce,
  generateState,
  buildAuthorizeUrl,
  exchangeCode,
  registerClient,
  validateCallbackParams,
} from "./clerk-oauth";
import type { SecretStore } from "./secret-store";
import { SECRET_ID_GATEWAY_CLIENT_ID } from "./secret-store";

/**
 * Obsidian-plugin Clerk OAuth login orchestration (desktop + iOS).
 *
 * The plugin uses ONE login path on both platforms: a redirect to the custom
 * scheme obsidian://vault-sync/oauth-callback handled by
 * registerObsidianProtocolHandler. Unlike the daemon's loopback flow (a single
 * in-process Promise), the plugin's authorize -> callback crosses an app boundary
 * (the system browser, then back into Obsidian), so the PKCE verifier and the CSRF
 * state must be stashed transiently BEFORE the browser opens and re-read in the
 * protocol-handler callback.
 *
 * This module owns the runtime-agnostic orchestration and reuses the shared
 * src/clerk-oauth.ts primitives (PKCE, authorize URL, code exchange, DCR, and the
 * validateCallbackParams state/error/code guard). The side-effects — opening the
 * browser and persisting the transient stash — are injected so the orchestration
 * is unit-testable. It deliberately depends only on src/ (never headless/), so it
 * is safe to bundle into the plugin (the headless module pulls in node:http /
 * child_process and must not enter the plugin bundle).
 */

/**
 * The unified redirect URI for the plugin on BOTH desktop and iOS.
 *
 * registerObsidianProtocolHandler dispatches obsidian:// URLs to the plugin on
 * every platform, so this single custom-scheme URI replaces the daemon's
 * per-platform loopback. It is the value that MUST be registered as an allowed
 * redirect URI in Clerk.
 */
export const OAUTH_REDIRECT_URI = "obsidian://vault-sync/oauth-callback";

/**
 * The protocol action passed to registerObsidianProtocolHandler.
 *
 * Obsidian parses obsidian://<action>?<params> and matches <action> against the
 * full path between the scheme and the query. For OAUTH_REDIRECT_URI that path is
 * "vault-sync/oauth-callback". Deriving it from the URI keeps the registered
 * handler and the redirect URI provably in sync.
 */
export const OAUTH_PROTOCOL_ACTION = OAUTH_REDIRECT_URI.replace("obsidian://", "");

/**
 * Canonical OAuth scope for the plugin login.
 *
 * offline_access is REQUIRED so Clerk issues a refresh token: the plugin must
 * refresh the 1-day access JWT in the background without re-prompting the user.
 */
export const PLUGIN_OAUTH_SCOPE = "offline_access";

/**
 * The transient login material stashed across the browser round-trip.
 *
 * codeVerifier is the PKCE secret paired with the challenge sent to /authorize;
 * state is the CSRF/replay guard echoed back on the callback. Both are short-lived
 * and cleared once the code is exchanged (or when a new login starts).
 */
export interface TransientLoginState {
  codeVerifier: string;
  state: string;
}

/**
 * Storage seam for the transient {codeVerifier, state} stash.
 *
 * Synchronous by design — it holds a single small in-flight object, typically in
 * plugin instance memory (an in-process login). It is intentionally NOT the
 * SecretStore: the verifier/state are ephemeral per-attempt values, not durable
 * credentials.
 */
export interface TransientLoginStore {
  get(): TransientLoginState | null;
  set(value: TransientLoginState): void;
  clear(): void;
}

/** Dependencies for startPluginLogin — side-effects injected for testability. */
export interface StartPluginLoginDeps {
  /** Gateway base URL (the Obsidian connector URL, e.g. https://mcp.fly-agile.com). */
  gatewayUrl: string;
  /** Durable credential store (client_id persisted here; refresh token later). */
  store: SecretStore;
  /** Holds the {codeVerifier, state} across the browser round-trip. */
  transient: TransientLoginStore;
  /** Opens the system browser / new window at the authorize URL (window.open on desktop+iOS). */
  openBrowser: (url: string) => void | Promise<void>;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Begin a login: derive PKCE, obtain a client_id (reuse stored, else DCR), stash
 * {codeVerifier, state}, then open the browser at the authorize URL.
 *
 * The stash is written BEFORE openBrowser so a callback that races the browser
 * (the redirect can fire before openBrowser resolves) still finds the verifier.
 */
export async function startPluginLogin(deps: StartPluginLoginDeps): Promise<void> {
  const fetchFn = deps.fetch ?? globalThis.fetch;

  // Reuse a previously-persisted client_id; otherwise register a public client
  // via DCR with the obsidian:// redirect and persist the assigned id.
  let clientId = (await deps.store.get(SECRET_ID_GATEWAY_CLIENT_ID)) ?? "";
  if (!clientId) {
    const reg = await registerClient({
      gatewayUrl: deps.gatewayUrl,
      redirectUris: [OAUTH_REDIRECT_URI],
      fetch: fetchFn,
    });
    clientId = reg.clientId;
    await deps.store.set(SECRET_ID_GATEWAY_CLIENT_ID, clientId);
  }

  const { codeVerifier, codeChallenge } = await generatePkce();
  const state = generateState();

  // Stash BEFORE opening the browser — the redirect callback may arrive first.
  deps.transient.set({ codeVerifier, state });

  const authorizeUrl = buildAuthorizeUrl({
    gatewayUrl: deps.gatewayUrl,
    clientId,
    redirectUri: OAUTH_REDIRECT_URI,
    scope: PLUGIN_OAUTH_SCOPE,
    state,
    codeChallenge,
  });

  await deps.openBrowser(authorizeUrl);
}

/** Dependencies for completePluginLogin — side-effects injected for testability. */
export interface CompletePluginLoginDeps {
  gatewayUrl: string;
  store: SecretStore;
  transient: TransientLoginStore;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Complete a login from the obsidian:// protocol-handler callback params.
 *
 * Validates the callback (state/error/code) against the stashed state, exchanges
 * the authorization code for tokens (persisting the rotating refresh token), and
 * clears the transient stash. A forged/mismatched callback throws WITHOUT clearing
 * the stash, so it cannot abort a still-pending legitimate login.
 */
export async function completePluginLogin(
  deps: CompletePluginLoginDeps,
  params: URLSearchParams,
): Promise<void> {
  const pending = deps.transient.get();
  if (!pending) {
    throw new Error("OAuth callback received with no pending login — ignoring.");
  }

  // Validate FIRST (state/error/code). A throw here leaves the stash intact so a
  // forged callback cannot cancel a genuine in-flight attempt.
  const { code } = validateCallbackParams(params, pending.state);

  const clientId = await deps.store.get(SECRET_ID_GATEWAY_CLIENT_ID);
  if (!clientId) {
    throw new Error("No gateway client_id available — cannot complete login.");
  }

  await exchangeCode({
    gatewayUrl: deps.gatewayUrl,
    clientId,
    code,
    codeVerifier: pending.codeVerifier,
    redirectUri: OAUTH_REDIRECT_URI,
    store: deps.store,
    fetch: deps.fetch,
  });

  // Only clear after a successful exchange — the verifier is single-use anyway.
  deps.transient.clear();
}
