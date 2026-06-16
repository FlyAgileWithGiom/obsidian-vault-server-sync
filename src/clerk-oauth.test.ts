import { describe, it, expect, vi } from "vitest";
import {
  generatePkce,
  buildAuthorizeUrl,
  exchangeCode,
  registerClient,
  validateCallbackParams,
} from "./clerk-oauth";
import {
  SECRET_ID_GATEWAY_REFRESH_TOKEN,
  type SecretStore,
} from "./secret-store";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** In-memory fake secret store (same pattern as the other unit tests). */
function fakeStore(initial: Record<string, string> = {}): SecretStore & {
  _data: Map<string, string>;
} {
  const _data = new Map(Object.entries(initial));
  return {
    _data,
    async get(id) {
      return _data.has(id) ? (_data.get(id) as string) : null;
    },
    async set(id, value) {
      _data.set(id, value);
    },
    isAvailable() {
      return true;
    },
  };
}

/**
 * Reference base64url(SHA-256(verifier)) computed independently of the module so
 * the test verifies the S256 relationship rather than trusting the implementation.
 */
async function expectedChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// generatePkce — S256 verifier/challenge relationship
// ---------------------------------------------------------------------------

describe("generatePkce", () => {
  it("produces a base64url verifier within the RFC 7636 length bounds (43-128)", async () => {
    const { codeVerifier } = await generatePkce();
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(codeVerifier.length).toBeLessThanOrEqual(128);
    // base64url alphabet only — no +, /, or = padding
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("derives the challenge as base64url(SHA-256(verifier)) — the S256 relationship", async () => {
    const { codeVerifier, codeChallenge } = await generatePkce();
    expect(codeChallenge).toBe(await expectedChallenge(codeVerifier));
    // base64url, unpadded
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("produces a fresh, unpredictable verifier on each call", async () => {
    const a = await generatePkce();
    const b = await generatePkce();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.codeChallenge).not.toBe(b.codeChallenge);
  });
});

// ---------------------------------------------------------------------------
// buildAuthorizeUrl — PKCE authorize request
// ---------------------------------------------------------------------------

describe("buildAuthorizeUrl", () => {
  const base = {
    gatewayUrl: "https://mcp.fly-agile.com",
    clientId: "client_abc",
    redirectUri: "obsidian://vault-sync/oauth-callback",
    scope: "openid offline_access",
    state: "state-xyz",
    codeChallenge: "challenge-123",
  };

  it("targets {gatewayUrl}/authorize", () => {
    const url = new URL(buildAuthorizeUrl(base));
    expect(url.origin + url.pathname).toBe("https://mcp.fly-agile.com/authorize");
  });

  it("includes the PKCE S256 parameters", () => {
    const url = new URL(buildAuthorizeUrl(base));
    expect(url.searchParams.get("code_challenge")).toBe("challenge-123");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  it("includes client_id, redirect_uri, state, and the offline_access scope", () => {
    const url = new URL(buildAuthorizeUrl(base));
    expect(url.searchParams.get("client_id")).toBe("client_abc");
    expect(url.searchParams.get("redirect_uri")).toBe("obsidian://vault-sync/oauth-callback");
    expect(url.searchParams.get("state")).toBe("state-xyz");
    // offline_access must be present so Clerk issues a refresh token
    expect(url.searchParams.get("scope")).toContain("offline_access");
  });

  it("percent-encodes the custom-scheme redirect_uri so it survives round-tripping", () => {
    // The raw query string must not contain a bare 'obsidian://' (it must be encoded).
    const raw = buildAuthorizeUrl(base);
    const query = raw.slice(raw.indexOf("?") + 1);
    expect(query).not.toContain("obsidian://");
    expect(query).toContain("obsidian%3A%2F%2F");
  });
});

// ---------------------------------------------------------------------------
// exchangeCode — authorization_code grant -> stores refresh token
// ---------------------------------------------------------------------------

describe("exchangeCode", () => {
  const codeOpts = {
    gatewayUrl: "https://mcp.fly-agile.com",
    clientId: "client_abc",
    code: "auth-code-1",
    codeVerifier: "verifier-1",
    redirectUri: "obsidian://vault-sync/oauth-callback",
  };

  it("POSTs the authorization_code grant form-encoded to {gatewayUrl}/token", async () => {
    const store = fakeStore();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ access_token: "at-1", refresh_token: "rt-1", token_type: "Bearer", expires_in: 86400 }),
    );

    await exchangeCode({ ...codeOpts, store, fetch: fetchMock as unknown as typeof fetch });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://mcp.fly-agile.com/token");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = init.body as string;
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=auth-code-1");
    expect(body).toContain("code_verifier=verifier-1");
    expect(body).toContain("client_id=client_abc");
    // Public PKCE client — no client_secret in the exchange
    expect(body).not.toContain("client_secret");
  });

  it("returns the token response and persists the refresh token to the store", async () => {
    const store = fakeStore();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ access_token: "at-2", refresh_token: "rt-2", token_type: "Bearer", expires_in: 86400 }),
    );

    const result = await exchangeCode({ ...codeOpts, store, fetch: fetchMock as unknown as typeof fetch });

    expect(result.access_token).toBe("at-2");
    expect(result.refresh_token).toBe("rt-2");
    // The interactive login seeds the refresh token the token manager later rotates.
    expect(store._data.get(SECRET_ID_GATEWAY_REFRESH_TOKEN)).toBe("rt-2");
  });

  it("does NOT persist the access token (it is in-memory only)", async () => {
    const store = fakeStore();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ access_token: "at-secret", refresh_token: "rt-3", token_type: "Bearer", expires_in: 86400 }),
    );

    await exchangeCode({ ...codeOpts, store, fetch: fetchMock as unknown as typeof fetch });

    for (const [, value] of store._data) {
      expect(value).not.toBe("at-secret");
    }
  });

  it("throws on a non-2xx token response without echoing the error body verbatim", async () => {
    const store = fakeStore();
    const fetchMock = vi.fn(async () => jsonResponse({ error: "invalid_grant" }, 400));

    await expect(
      exchangeCode({ ...codeOpts, store, fetch: fetchMock as unknown as typeof fetch }),
    ).rejects.toThrow(/400/);
  });
});

// ---------------------------------------------------------------------------
// registerClient — Dynamic Client Registration (optional)
// ---------------------------------------------------------------------------

describe("registerClient", () => {
  it("POSTs redirect_uris to {gatewayUrl}/register and returns the assigned client_id", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ client_id: "client_dcr_1" }, 201),
    );

    const result = await registerClient({
      gatewayUrl: "https://mcp.fly-agile.com",
      redirectUris: ["obsidian://vault-sync/oauth-callback"],
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(result.clientId).toBe("client_dcr_1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://mcp.fly-agile.com/register");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as { redirect_uris: string[] };
    expect(body.redirect_uris).toEqual(["obsidian://vault-sync/oauth-callback"]);
  });

  it("throws on a non-2xx registration response", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "invalid_redirect_uri" }, 400));

    await expect(
      registerClient({
        gatewayUrl: "https://mcp.fly-agile.com",
        redirectUris: ["bad"],
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/400/);
  });
});

// ---------------------------------------------------------------------------
// validateCallbackParams — shared OAuth callback validation (state/error/code)
// ---------------------------------------------------------------------------

describe("validateCallbackParams", () => {
  it("returns the code when state matches and a code is present", () => {
    const params = new URLSearchParams({ code: "auth-code-1", state: "expected" });
    expect(validateCallbackParams(params, "expected")).toEqual({ code: "auth-code-1" });
  });

  it("throws on a state mismatch (CSRF/replay guard)", () => {
    const params = new URLSearchParams({ code: "auth-code-1", state: "tampered" });
    expect(() => validateCallbackParams(params, "expected")).toThrow(/state mismatch/i);
  });

  it("throws when state is absent (cannot prove origin)", () => {
    const params = new URLSearchParams({ code: "auth-code-1" });
    expect(() => validateCallbackParams(params, "expected")).toThrow(/state mismatch/i);
  });

  it("surfaces an explicit OAuth error param rather than a missing-code error", () => {
    const params = new URLSearchParams({ error: "access_denied", state: "expected" });
    expect(() => validateCallbackParams(params, "expected")).toThrow(/access_denied/);
  });

  it("throws when the code is missing on an otherwise-valid callback", () => {
    const params = new URLSearchParams({ state: "expected" });
    expect(() => validateCallbackParams(params, "expected")).toThrow(/authorization code/i);
  });

  it("validates state BEFORE surfacing an error param (untrusted callbacks never read further)", () => {
    // A mismatched state must abort before the error param is even consulted.
    const params = new URLSearchParams({ error: "access_denied", state: "tampered" });
    expect(() => validateCallbackParams(params, "expected")).toThrow(/state mismatch/i);
  });
});
