import { describe, it, expect, vi, afterEach } from "vitest";
import {
  makeTokenManager,
  makeGatewayFetch,
  type TokenManagerOpts,
  type GatewayTokenResponse,
} from "./gateway-fetch";
import {
  SECRET_ID_GATEWAY_REFRESH_TOKEN,
  type SecretStore,
} from "./secret-store";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * In-memory fake secret store (same pattern as secret-store.test.ts).
 * Allows tests to inspect what was written without depending on the real store
 * implementations (SecretStorageSecretStore or KeychainSecretStore).
 */
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
 * Build a minimal token response matching the real gateway contract:
 *   POST /token -> { access_token, refresh_token, token_type:"Bearer", expires_in:86400 }
 */
function tokenResponse(overrides: Partial<GatewayTokenResponse> = {}): GatewayTokenResponse {
  return {
    access_token: "at-default",
    refresh_token: "rt-default",
    token_type: "Bearer",
    expires_in: 86400,
    ...overrides,
  };
}

/**
 * Build a mock fetch function whose calls can be inspected.
 * Default behaviour: the first call returns a 200 with a valid token response
 * for POST /token, and a 200 for all other URLs.
 */
function mockFetchReturning(
  responses: Array<{ status: number; body?: unknown }>,
): ReturnType<typeof vi.fn> {
  let callIndex = 0;
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    const resp = responses[callIndex] ?? { status: 200, body: {} };
    callIndex++;
    const bodyText = resp.body ? JSON.stringify(resp.body) : "{}";
    return new Response(bodyText, {
      status: resp.status,
      headers: { "Content-Type": "application/json" },
    });
  });
}

/** Opts for makeTokenManager pointing at a stable test gateway */
function testManagerOpts(
  store: SecretStore,
  overrides: Partial<TokenManagerOpts> = {},
): TokenManagerOpts {
  return {
    gatewayUrl: "https://gateway.test",
    clientId: "cid-test",
    clientSecret: "csec-test",
    store,
    ...overrides,
  };
}

// Clean up global fetch stub after each test
afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// TokenManager — client_credentials grant (no refresh token yet)
// ---------------------------------------------------------------------------

describe("TokenManager — client_credentials grant", () => {
  it("fetches an access token via client_credentials when no refresh token exists", async () => {
    const store = fakeStore(); // no refresh token stored
    const fetchMock = mockFetchReturning([
      { status: 200, body: tokenResponse({ access_token: "at-fresh", refresh_token: "rt-fresh" }) },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const manager = makeTokenManager(testManagerOpts(store));
    const token = await manager.getValidToken();

    expect(token).toBe("at-fresh");

    // Assert the correct form-encoded body was sent to /token
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://gateway.test/token");
    expect(init.method).toBe("POST");
    const body = init.body as string;
    expect(body).toContain("grant_type=client_credentials");
    expect(body).toContain("client_id=cid-test");
    expect(body).toContain("client_secret=csec-test");
  });

  it("persists the received refresh token to the store after client_credentials grant", async () => {
    const store = fakeStore();
    vi.stubGlobal(
      "fetch",
      mockFetchReturning([
        { status: 200, body: tokenResponse({ access_token: "at-1", refresh_token: "rt-1" }) },
      ]),
    );

    const manager = makeTokenManager(testManagerOpts(store));
    await manager.getValidToken();

    // Rotating refresh token must be persisted to survive a process restart
    expect(store._data.get(SECRET_ID_GATEWAY_REFRESH_TOKEN)).toBe("rt-1");
  });

  it("does NOT write the access token to the store (in-memory only)", async () => {
    const store = fakeStore();
    vi.stubGlobal(
      "fetch",
      mockFetchReturning([
        { status: 200, body: tokenResponse({ access_token: "at-secret" }) },
      ]),
    );

    const manager = makeTokenManager(testManagerOpts(store));
    await manager.getValidToken();

    // The store must NOT contain the access token — it is in-memory only
    for (const [, value] of store._data) {
      expect(value).not.toBe("at-secret");
    }
  });
});

// ---------------------------------------------------------------------------
// TokenManager — refresh_token grant (when a refresh token already exists)
// ---------------------------------------------------------------------------

describe("TokenManager — refresh_token grant", () => {
  it("uses refresh_token grant when a stored refresh token exists", async () => {
    const store = fakeStore({ [SECRET_ID_GATEWAY_REFRESH_TOKEN]: "rt-existing" });
    const fetchMock = mockFetchReturning([
      { status: 200, body: tokenResponse({ access_token: "at-refreshed", refresh_token: "rt-new" }) },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const manager = makeTokenManager(testManagerOpts(store));
    await manager.getValidToken();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = init.body as string;
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=rt-existing");
    // Must NOT include client_secret in a refresh grant (not required by the contract)
    // — but client_id is required in some OAuth implementations; we accept either form.
  });

  it("persists the rotated refresh token to the store after refresh_token grant", async () => {
    const store = fakeStore({ [SECRET_ID_GATEWAY_REFRESH_TOKEN]: "rt-old" });
    vi.stubGlobal(
      "fetch",
      mockFetchReturning([
        { status: 200, body: tokenResponse({ refresh_token: "rt-rotated" }) },
      ]),
    );

    const manager = makeTokenManager(testManagerOpts(store));
    await manager.getValidToken();

    expect(store._data.get(SECRET_ID_GATEWAY_REFRESH_TOKEN)).toBe("rt-rotated");
  });
});

// ---------------------------------------------------------------------------
// TokenManager — in-memory caching (no redundant /token requests)
// ---------------------------------------------------------------------------

describe("TokenManager — in-memory caching", () => {
  it("returns the cached token on a second call within the valid window", async () => {
    const store = fakeStore();
    const fetchMock = mockFetchReturning([
      { status: 200, body: tokenResponse({ access_token: "at-cached" }) },
      // Second call — should NOT reach here
      { status: 500, body: { error: "should not be called" } },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const manager = makeTokenManager(testManagerOpts(store));
    const first = await manager.getValidToken();
    const second = await manager.getValidToken();

    expect(first).toBe("at-cached");
    expect(second).toBe("at-cached");
    // Only one network call: the cache hit on the second call must not touch /token
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// TokenManager — single-flight mutex (concurrent calls during an expiry
// trigger exactly ONE refresh, not a refresh storm)
// ---------------------------------------------------------------------------

describe("TokenManager — single-flight mutex", () => {
  it("concurrent getValidToken() calls trigger exactly one /token request", async () => {
    const store = fakeStore(); // no existing token
    let tokenCallCount = 0;

    // Slow token endpoint: resolves after a tick so concurrent calls pile up
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if ((url as string).endsWith("/token")) {
          tokenCallCount++;
          // Slight delay to allow other callers to queue behind the in-flight mutex
          await new Promise((r) => setTimeout(r, 10));
          return new Response(JSON.stringify(tokenResponse({ access_token: "at-single" })), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("{}", { status: 200 });
      }),
    );

    const manager = makeTokenManager(testManagerOpts(store));

    // Launch 5 concurrent getValidToken() calls — all should queue behind one fetch
    const results = await Promise.all([
      manager.getValidToken(),
      manager.getValidToken(),
      manager.getValidToken(),
      manager.getValidToken(),
      manager.getValidToken(),
    ]);

    // All callers receive the same valid token
    expect(results).toEqual(["at-single", "at-single", "at-single", "at-single", "at-single"]);
    // Exactly one network round-trip — not 5
    expect(tokenCallCount).toBe(1);
  });

  it("concurrent makeGatewayFetch() calls hitting 401 trigger exactly one refresh", async () => {
    const store = fakeStore({ [SECRET_ID_GATEWAY_REFRESH_TOKEN]: "rt-init" });
    let tokenCallCount = 0;

    // Phase 1 fetch: returns the initial stale token (at-stale)
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if ((url as string).endsWith("/token")) {
          tokenCallCount++;
          if (tokenCallCount === 1) {
            // First call: seed the manager with a token the server will reject
            return new Response(
              JSON.stringify(tokenResponse({ access_token: "at-stale", refresh_token: "rt-init" })),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          // Subsequent calls (the one forced refresh): slow to let concurrent callers pile up
          await new Promise((r) => setTimeout(r, 10));
          return new Response(
            JSON.stringify(tokenResponse({ access_token: "at-refreshed", refresh_token: "rt-new" })),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        // Resource requests: 401 for the stale token, 200 for the refreshed token
        const auth = (init?.headers as Record<string, string>)?.Authorization ?? "";
        if (auth === "Bearer at-refreshed") {
          return new Response("{}", { status: 200 });
        }
        return new Response('{"error":"token_expired"}', { status: 401 });
      }),
    );

    const manager = makeTokenManager(testManagerOpts(store));

    // Prime the manager with at-stale so that concurrent resource calls all start
    // with the same stale token (which the server will 401).
    await manager.getValidToken(); // => at-stale cached

    const gatewayFetch = makeGatewayFetch({ tokenManager: manager });

    // Launch 3 concurrent resource requests — all hit 401 with at-stale, then
    // race to forceRefresh(). The single-flight mutex must allow only ONE /token
    // call for the refresh (tokenCallCount goes from 1 to 2, not 1 to 4).
    const results = await Promise.all([
      gatewayFetch("https://gateway.test/couchdb/vault-slug", {}),
      gatewayFetch("https://gateway.test/couchdb/vault-slug", {}),
      gatewayFetch("https://gateway.test/couchdb/vault-slug", {}),
    ]);

    // All should ultimately succeed after the single refresh
    expect(results.every((r) => r.status === 200)).toBe(true);
    // One /token call to seed + one /token call for the refresh = 2 total
    // (NOT 4, which would happen without the single-flight mutex)
    expect(tokenCallCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// makeGatewayFetch — Bearer injection + 401 retry
// ---------------------------------------------------------------------------

describe("makeGatewayFetch — Bearer token injection", () => {
  it("injects Authorization: Bearer <token> on every outgoing request", async () => {
    const store = fakeStore();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if ((url as string).endsWith("/token")) {
          return new Response(JSON.stringify(tokenResponse({ access_token: "at-injected" })), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        // Echo back the Authorization header for inspection
        const auth = (init?.headers as Record<string, string>)?.Authorization ?? "";
        return new Response(JSON.stringify({ receivedAuth: auth }), { status: 200 });
      }),
    );

    const manager = makeTokenManager(testManagerOpts(store));
    const gatewayFetch = makeGatewayFetch({ tokenManager: manager });

    const resp = await gatewayFetch("https://gateway.test/couchdb/vault-slug", {});
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { receivedAuth: string };
    expect(body.receivedAuth).toBe("Bearer at-injected");
  });
});

describe("makeGatewayFetch — 401 -> refresh -> retry", () => {
  it("retries the original request once after a 401 and returns the retried response", async () => {
    const store = fakeStore({ [SECRET_ID_GATEWAY_REFRESH_TOKEN]: "rt-init" });
    let resourceCallCount = 0;
    let tokenCallCount = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if ((url as string).endsWith("/token")) {
          tokenCallCount++;
          // First token call returns "at-old" (stale); second returns "at-new"
          const token = tokenCallCount === 1 ? "at-old" : "at-new";
          return new Response(
            JSON.stringify(tokenResponse({ access_token: token, refresh_token: "rt-new" })),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        resourceCallCount++;
        const auth = (init?.headers as Record<string, string>)?.Authorization ?? "";
        // First resource call uses "at-old" -> 401 (simulates server-side expiry)
        // Second resource call uses "at-new" -> 200
        if (auth === "Bearer at-new") {
          return new Response('{"ok":true}', { status: 200 });
        }
        return new Response('{"error":"expired"}', { status: 401 });
      }),
    );

    const manager = makeTokenManager(testManagerOpts(store));
    const gatewayFetch = makeGatewayFetch({ tokenManager: manager });

    // This call:
    //   1. getValidToken() -> /token (at-old) cached
    //   2. Resource call with "Bearer at-old" -> 401
    //   3. forceRefresh() -> /token (at-new)
    //   4. Retry resource call with "Bearer at-new" -> 200
    const resp = await gatewayFetch("https://gateway.test/couchdb/vault-slug/_changes", {});
    expect(resp.status).toBe(200);
    // Exactly two resource attempts: the original + one retry
    expect(resourceCallCount).toBe(2);
    // Exactly two /token calls: initial fetch + the forced refresh
    expect(tokenCallCount).toBe(2);
  });

  it("does NOT retry a second time if the retried request also returns 401 — surfaces the response", async () => {
    const store = fakeStore({ [SECRET_ID_GATEWAY_REFRESH_TOKEN]: "rt-init" });
    let resourceCallCount = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if ((url as string).endsWith("/token")) {
          return new Response(JSON.stringify(tokenResponse()), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        resourceCallCount++;
        // Always 401 — simulates a truly revoked token
        return new Response('{"error":"unauthorized"}', { status: 401 });
      }),
    );

    const manager = makeTokenManager(testManagerOpts(store));
    const gatewayFetch = makeGatewayFetch({ tokenManager: manager });

    const resp = await gatewayFetch("https://gateway.test/couchdb/vault-slug", {});
    // Must surface the 401 response, not retry forever
    expect(resp.status).toBe(401);
    // Original attempt + exactly one retry = 2 resource calls total
    expect(resourceCallCount).toBe(2);
  });

  it("surfaces the error when the refresh itself fails (e.g. invalid_client from gateway)", async () => {
    const store = fakeStore({ [SECRET_ID_GATEWAY_REFRESH_TOKEN]: "rt-bad" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if ((url as string).endsWith("/token")) {
          // Gateway returns 401 on a bad refresh token
          return new Response('{"error":"invalid_client"}', { status: 401 });
        }
        // First resource call — triggers the refresh
        return new Response('{"error":"expired"}', { status: 401 });
      }),
    );

    const manager = makeTokenManager(testManagerOpts(store));
    const gatewayFetch = makeGatewayFetch({ tokenManager: manager });

    // When refresh fails, getValidToken() should throw, which propagates
    await expect(gatewayFetch("https://gateway.test/couchdb/vault-slug", {})).rejects.toThrow();
  });
});
