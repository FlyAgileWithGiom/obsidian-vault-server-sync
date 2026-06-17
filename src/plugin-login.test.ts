import { describe, it, expect, vi } from "vitest";
import {
  startPluginLogin,
  completePluginLogin,
  OAUTH_REDIRECT_URI,
  OAUTH_PROTOCOL_ACTION,
  PLUGIN_OAUTH_SCOPE,
  type TransientLoginState,
} from "./plugin-login";
import {
  SECRET_ID_GATEWAY_CLIENT_ID,
  SECRET_ID_GATEWAY_REFRESH_TOKEN,
  type SecretStore,
} from "./secret-store";

/** In-memory fake secret store (mirrors the other unit tests). */
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

/** In-memory transient store for the {codeVerifier, state} stash. */
function fakeTransient(): {
  get(): TransientLoginState | null;
  set(v: TransientLoginState): void;
  clear(): void;
  _value: TransientLoginState | null;
} {
  let value: TransientLoginState | null = null;
  return {
    get value() {
      return value;
    },
    get() {
      return value;
    },
    set(v: TransientLoginState) {
      value = v;
    },
    clear() {
      value = null;
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("plugin-login constants", () => {
  it("uses the unified obsidian:// redirect URI for desktop + iOS", () => {
    expect(OAUTH_REDIRECT_URI).toBe("obsidian://fly-vault-sync-oauth");
  });

  it("uses a SINGLE-SEGMENT action (no slash) so Obsidian's host-based dispatch routes it", () => {
    // A path-style action ("a/b") registers a handler the dispatcher never matches.
    expect(OAUTH_PROTOCOL_ACTION).not.toContain("/");
    expect(OAUTH_REDIRECT_URI).toBe(`obsidian://${OAUTH_PROTOCOL_ACTION}`);
  });

  it("requests offline_access so Clerk issues a refresh token", () => {
    expect(PLUGIN_OAUTH_SCOPE).toContain("offline_access");
  });
});

// ---------------------------------------------------------------------------
// startPluginLogin
// ---------------------------------------------------------------------------

describe("startPluginLogin", () => {
  it("stashes {codeVerifier, state} transiently BEFORE opening the browser", async () => {
    const store = fakeStore({ [SECRET_ID_GATEWAY_CLIENT_ID]: "client_static" });
    const transient = fakeTransient();
    const order: string[] = [];
    const openBrowser = vi.fn(async () => {
      // At the moment the browser opens, the transient must already be set so an
      // immediate callback can be validated (the redirect can race the browser).
      order.push("open");
      expect(transient.get()).not.toBeNull();
    });

    await startPluginLogin({
      gatewayUrl: "https://mcp.fly-agile.com",
      store,
      transient,
      openBrowser,
    });

    expect(openBrowser).toHaveBeenCalledTimes(1);
    const stashed = transient.get();
    expect(stashed).not.toBeNull();
    expect(stashed!.codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(stashed!.state).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("opens an authorize URL carrying the stashed state, S256 challenge, and obsidian:// redirect", async () => {
    const store = fakeStore({ [SECRET_ID_GATEWAY_CLIENT_ID]: "client_static" });
    const transient = fakeTransient();
    let openedUrl = "";
    const openBrowser = vi.fn(async (url: string) => {
      openedUrl = url;
    });

    await startPluginLogin({
      gatewayUrl: "https://mcp.fly-agile.com",
      store,
      transient,
      openBrowser,
    });

    const url = new URL(openedUrl);
    expect(url.origin + url.pathname).toBe("https://mcp.fly-agile.com/authorize");
    expect(url.searchParams.get("client_id")).toBe("client_static");
    expect(url.searchParams.get("redirect_uri")).toBe(OAUTH_REDIRECT_URI);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toContain("offline_access");
    // The state on the wire must equal the stashed state.
    expect(url.searchParams.get("state")).toBe(transient.get()!.state);
  });

  it("registers a client via DCR when no client_id is stored, then persists it", async () => {
    const store = fakeStore();
    const transient = fakeTransient();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.endsWith("/register")) return jsonResponse({ client_id: "client_dcr" });
      throw new Error(`unexpected fetch ${u}`);
    });

    await startPluginLogin({
      gatewayUrl: "https://mcp.fly-agile.com",
      store,
      transient,
      openBrowser: vi.fn(async () => {}),
      fetch: fetchMock as unknown as typeof fetch,
    });

    // DCR registered with the obsidian:// redirect URI...
    const registerCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/register"));
    expect(registerCall).toBeDefined();
    const body = JSON.parse((registerCall![1] as RequestInit).body as string);
    expect(body.redirect_uris).toContain(OAUTH_REDIRECT_URI);
    // ...and the assigned client_id persisted for reuse on later logins.
    expect(store._data.get(SECRET_ID_GATEWAY_CLIENT_ID)).toBe("client_dcr");
  });
});

// ---------------------------------------------------------------------------
// completePluginLogin
// ---------------------------------------------------------------------------

describe("completePluginLogin", () => {
  it("validates state, exchanges the code, and persists the refresh token", async () => {
    const store = fakeStore({ [SECRET_ID_GATEWAY_CLIENT_ID]: "client_static" });
    const transient = fakeTransient();
    transient.set({ codeVerifier: "verifier-1", state: "state-1" });
    const fetchMock = vi.fn(async () =>
      jsonResponse({ access_token: "at", refresh_token: "rt-new", token_type: "Bearer", expires_in: 86400 }),
    );

    await completePluginLogin(
      { gatewayUrl: "https://mcp.fly-agile.com", store, transient, fetch: fetchMock as unknown as typeof fetch },
      new URLSearchParams({ code: "auth-code", state: "state-1" }),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://mcp.fly-agile.com/token");
    const reqBody = (init.body as string) ?? "";
    expect(reqBody).toContain("grant_type=authorization_code");
    expect(reqBody).toContain("code_verifier=verifier-1");
    expect(store._data.get(SECRET_ID_GATEWAY_REFRESH_TOKEN)).toBe("rt-new");
  });

  it("clears the transient stash after a successful exchange", async () => {
    const store = fakeStore({ [SECRET_ID_GATEWAY_CLIENT_ID]: "client_static" });
    const transient = fakeTransient();
    transient.set({ codeVerifier: "verifier-1", state: "state-1" });
    const fetchMock = vi.fn(async () =>
      jsonResponse({ access_token: "at", refresh_token: "rt", token_type: "Bearer", expires_in: 86400 }),
    );

    await completePluginLogin(
      { gatewayUrl: "https://mcp.fly-agile.com", store, transient, fetch: fetchMock as unknown as typeof fetch },
      new URLSearchParams({ code: "auth-code", state: "state-1" }),
    );

    expect(transient.get()).toBeNull();
  });

  it("throws on a state mismatch and does NOT exchange the code", async () => {
    const store = fakeStore({ [SECRET_ID_GATEWAY_CLIENT_ID]: "client_static" });
    const transient = fakeTransient();
    transient.set({ codeVerifier: "verifier-1", state: "state-1" });
    const fetchMock = vi.fn();

    await expect(
      completePluginLogin(
        { gatewayUrl: "https://mcp.fly-agile.com", store, transient, fetch: fetchMock as unknown as typeof fetch },
        new URLSearchParams({ code: "auth-code", state: "TAMPERED" }),
      ),
    ).rejects.toThrow(/state mismatch/i);

    expect(fetchMock).not.toHaveBeenCalled();
    // A failed/forged callback must NOT clear a still-pending legitimate login.
    expect(transient.get()).not.toBeNull();
  });

  it("throws when there is no pending login (no transient stash)", async () => {
    const store = fakeStore({ [SECRET_ID_GATEWAY_CLIENT_ID]: "client_static" });
    const transient = fakeTransient(); // empty

    await expect(
      completePluginLogin(
        { gatewayUrl: "https://mcp.fly-agile.com", store, transient },
        new URLSearchParams({ code: "auth-code", state: "state-1" }),
      ),
    ).rejects.toThrow(/no pending login/i);
  });

  it("throws when no client_id is available to bind the exchange", async () => {
    const store = fakeStore(); // no client_id
    const transient = fakeTransient();
    transient.set({ codeVerifier: "verifier-1", state: "state-1" });

    await expect(
      completePluginLogin(
        { gatewayUrl: "https://mcp.fly-agile.com", store, transient },
        new URLSearchParams({ code: "auth-code", state: "state-1" }),
      ),
    ).rejects.toThrow(/client_id/i);
  });
});
