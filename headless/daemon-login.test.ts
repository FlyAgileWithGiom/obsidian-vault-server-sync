import { describe, it, expect, vi } from "vitest";
import {
  parseLoopbackCallback,
  generateState,
  runLogin,
  DAEMON_OAUTH_SCOPE,
} from "./daemon-login";
import {
  SECRET_ID_GATEWAY_CLIENT_ID,
  SECRET_ID_GATEWAY_REFRESH_TOKEN,
  type SecretStore,
} from "../src/secret-store";

/** In-memory SecretStore stand-in; never touches the real keychain. */
function fakeStore(initial: Record<string, string> = {}): SecretStore & {
  _dump(): Record<string, string>;
} {
  const m = new Map(Object.entries(initial));
  return {
    async get(id) {
      return m.has(id) ? (m.get(id) as string) : null;
    },
    async set(id, value) {
      m.set(id, value);
    },
    isAvailable() {
      return true;
    },
    _dump() {
      return Object.fromEntries(m);
    },
  };
}

// ---------------------------------------------------------------------------
// parseLoopbackCallback — extract the code, validate state, surface OAuth errors
// ---------------------------------------------------------------------------

describe("parseLoopbackCallback", () => {
  const STATE = "abc123state";

  it("returns the authorization code when state matches", () => {
    const url = `/callback?code=auth_code_xyz&state=${STATE}`;
    expect(parseLoopbackCallback(url, STATE)).toEqual({ code: "auth_code_xyz" });
  });

  it("parses an absolute URL form as well as a path-only form", () => {
    const url = `http://127.0.0.1:54321/callback?code=abc&state=${STATE}`;
    expect(parseLoopbackCallback(url, STATE)).toEqual({ code: "abc" });
  });

  it("throws on a state mismatch (CSRF/replay guard)", () => {
    const url = `/callback?code=auth_code_xyz&state=tampered`;
    expect(() => parseLoopbackCallback(url, STATE)).toThrow(/state/i);
  });

  it("throws when the state param is absent", () => {
    const url = `/callback?code=auth_code_xyz`;
    expect(() => parseLoopbackCallback(url, STATE)).toThrow(/state/i);
  });

  it("surfaces an OAuth error param without leaking it as a code", () => {
    const url = `/callback?error=access_denied&error_description=user+said+no&state=${STATE}`;
    expect(() => parseLoopbackCallback(url, STATE)).toThrow(/access_denied/);
  });

  it("throws when no code is present and there is no error", () => {
    const url = `/callback?state=${STATE}`;
    expect(() => parseLoopbackCallback(url, STATE)).toThrow(/code/i);
  });
});

// ---------------------------------------------------------------------------
// generateState — opaque, non-empty, unique per call
// ---------------------------------------------------------------------------

describe("generateState", () => {
  it("returns a non-empty opaque value", () => {
    expect(generateState().length).toBeGreaterThan(16);
  });

  it("returns a different value on each call", () => {
    expect(generateState()).not.toBe(generateState());
  });
});

// ---------------------------------------------------------------------------
// runLogin — orchestrate PKCE -> authorize -> capture -> exchange -> store
// ---------------------------------------------------------------------------

describe("runLogin", () => {
  function tokenResponse() {
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          access_token: "access_jwt",
          refresh_token: "refresh_rotated",
          token_type: "Bearer",
          expires_in: 86400,
        };
      },
      async text() {
        return "";
      },
    } as unknown as Response;
  }

  it("opens the authorize URL, captures the code, exchanges it, and stores the refresh token", async () => {
    const store = fakeStore();
    const openedUrls: string[] = [];
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => tokenResponse(),
    );

    // The waitForCode side-effect captures whatever authorize URL was opened and
    // returns a code; runLogin must have already validated state inside the loopback
    // server before handing us the code, so the harness just returns the bare code.
    await runLogin({
      gatewayUrl: "https://mcp.fly-agile.com",
      clientId: "client_static",
      store,
      openBrowser: async (url) => {
        openedUrls.push(url);
      },
      waitForCode: async () => "captured_code",
      fetch: fetchMock,
    });

    // Authorize URL carries PKCE challenge + the loopback redirect + offline_access.
    expect(openedUrls).toHaveLength(1);
    const authUrl = openedUrls[0];
    expect(authUrl).toContain("https://mcp.fly-agile.com/authorize");
    expect(authUrl).toContain("code_challenge=");
    expect(authUrl).toContain("code_challenge_method=S256");
    expect(authUrl).toContain("scope=offline_access");
    expect(authUrl).toMatch(/redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Fcallback/);

    // Token exchange happened against /token with the authorization_code grant.
    expect(fetchMock).toHaveBeenCalledOnce();
    const [tokenUrl, init] = fetchMock.mock.calls[0];
    expect(tokenUrl).toBe("https://mcp.fly-agile.com/token");
    expect(String(init?.body)).toContain("grant_type=authorization_code");
    expect(String(init?.body)).toContain("code=captured_code");
    expect(String(init?.body)).toContain("code_verifier=");

    // Refresh token + client_id persisted; access token NOT persisted.
    expect(await store.get(SECRET_ID_GATEWAY_REFRESH_TOKEN)).toBe("refresh_rotated");
    expect(await store.get(SECRET_ID_GATEWAY_CLIENT_ID)).toBe("client_static");
    expect(store._dump()).not.toHaveProperty("access_token");
  });

  it("registers a client via DCR when no clientId is supplied", async () => {
    const store = fakeStore();
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      if (String(url).endsWith("/register")) {
        return {
          ok: true,
          status: 201,
          async json() {
            return { client_id: "dcr_assigned" };
          },
          async text() {
            return "";
          },
        } as unknown as Response;
      }
      return tokenResponse();
    });

    await runLogin({
      gatewayUrl: "https://mcp.fly-agile.com",
      store,
      openBrowser: async () => {},
      waitForCode: async () => "captured_code",
      fetch: fetchMock,
    });

    // DCR was called, and the assigned client_id was persisted + used in the exchange.
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/register"))).toBe(true);
    expect(await store.get(SECRET_ID_GATEWAY_CLIENT_ID)).toBe("dcr_assigned");
  });

  it("passes the loopback port through to the redirect URI consistently", async () => {
    const store = fakeStore();
    const openedUrls: string[] = [];
    let redirectSeenByWait = "";
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => tokenResponse(),
    );

    await runLogin({
      gatewayUrl: "https://mcp.fly-agile.com",
      clientId: "c",
      store,
      openBrowser: async (url) => {
        openedUrls.push(url);
      },
      waitForCode: async (redirectUri) => {
        redirectSeenByWait = redirectUri;
        return "code";
      },
      fetch: fetchMock,
    });

    // The redirect_uri in the authorize URL must equal the one given to waitForCode
    // (loopback server binds that exact URI) AND the one sent on the token exchange.
    const authUrl = new URL(openedUrls[0]);
    const redirectInAuth = authUrl.searchParams.get("redirect_uri");
    expect(redirectInAuth).toBe(redirectSeenByWait);
    const [, init] = fetchMock.mock.calls[0];
    expect(decodeURIComponent(String(init?.body))).toContain(`redirect_uri=${redirectSeenByWait}`);
  });

  it("exposes offline_access in the canonical scope constant", () => {
    expect(DAEMON_OAUTH_SCOPE).toContain("offline_access");
  });
});
