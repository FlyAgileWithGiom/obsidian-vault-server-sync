import { describe, it, expect, vi } from "vitest";
import { provisionGatewayCredential, type ProvisionOpts } from "./provision";
import {
  SECRET_ID_GATEWAY_CLIENT_ID,
  SECRET_ID_GATEWAY_CLIENT_SECRET,
  type SecretStore,
} from "./secret-store";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * In-memory fake secret store (same pattern as gateway-fetch.test.ts).
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
 * Build a mock fetch that returns a single response.
 */
function mockFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  return vi.fn(async () => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
}

/**
 * Build a mock fetch that returns a plain text response (for error bodies).
 */
function mockFetchText(status: number, text: string): ReturnType<typeof vi.fn> {
  return vi.fn(async () => {
    return new Response(text, {
      status,
      headers: { "Content-Type": "text/plain" },
    });
  });
}

const BASE_OPTS: Omit<ProvisionOpts, "store" | "fetch"> = {
  gatewayUrl: "https://gateway.test",
  bootstrapToken: "bt-secret-token",
  userId: "clerk-user-sub-123",
};

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

describe("provisionGatewayCredential — request shape", () => {
  it("sends a POST to {gatewayUrl}/credentials/provision with the correct headers and body", async () => {
    const store = fakeStore();
    const fetchMock = mockFetch(201, {
      client_id: "cid-1",
      client_secret: "csec-1",
      token_endpoint: "https://gateway.test/token",
      vault_db: null,
    });

    await provisionGatewayCredential({ ...BASE_OPTS, store, fetch: fetchMock });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe("https://gateway.test/credentials/provision");
    expect(init.method).toBe("POST");

    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Authorization"]).toBe("Bearer bt-secret-token");

    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ user_id: "clerk-user-sub-123" });
  });

  it("strips a trailing slash from gatewayUrl before building the endpoint", async () => {
    const store = fakeStore();
    const fetchMock = mockFetch(201, {
      client_id: "cid-1",
      client_secret: "csec-1",
      token_endpoint: "https://gateway.test/token",
      vault_db: null,
    });

    await provisionGatewayCredential({
      ...BASE_OPTS,
      gatewayUrl: "https://gateway.test/",
      store,
      fetch: fetchMock,
    });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://gateway.test/credentials/provision");
  });
});

// ---------------------------------------------------------------------------
// HTTP 201 — first-time creation
// ---------------------------------------------------------------------------

describe("provisionGatewayCredential — 201 first-time creation", () => {
  it("stores client_id and client_secret in the secret store", async () => {
    const store = fakeStore();
    const fetchMock = mockFetch(201, {
      client_id: "cid-new",
      client_secret: "csec-new",
      token_endpoint: "https://gateway.test/token",
      vault_db: null,
    });

    await provisionGatewayCredential({ ...BASE_OPTS, store, fetch: fetchMock });

    expect(store._data.get(SECRET_ID_GATEWAY_CLIENT_ID)).toBe("cid-new");
    expect(store._data.get(SECRET_ID_GATEWAY_CLIENT_SECRET)).toBe("csec-new");
  });

  it("returns 'created' on a 201 response", async () => {
    const store = fakeStore();
    const fetchMock = mockFetch(201, {
      client_id: "cid-x",
      client_secret: "csec-x",
      token_endpoint: "https://gateway.test/token",
      vault_db: null,
    });

    const result = await provisionGatewayCredential({ ...BASE_OPTS, store, fetch: fetchMock });

    expect(result).toBe("created");
  });
});

// ---------------------------------------------------------------------------
// HTTP 200 — already provisioned
// ---------------------------------------------------------------------------

describe("provisionGatewayCredential — 200 already provisioned", () => {
  it("returns 'already-provisioned' on a 200 with secret_already_provisioned:true", async () => {
    const store = fakeStore({
      [SECRET_ID_GATEWAY_CLIENT_ID]: "cid-existing",
      [SECRET_ID_GATEWAY_CLIENT_SECRET]: "csec-existing",
    });
    const fetchMock = mockFetch(200, {
      client_id: "cid-existing",
      secret_already_provisioned: true,
    });

    const result = await provisionGatewayCredential({ ...BASE_OPTS, store, fetch: fetchMock });

    expect(result).toBe("already-provisioned");
  });

  it("does NOT overwrite the existing secret store on a 200 already-provisioned response", async () => {
    const store = fakeStore({
      [SECRET_ID_GATEWAY_CLIENT_ID]: "cid-existing",
      [SECRET_ID_GATEWAY_CLIENT_SECRET]: "csec-existing",
    });
    const fetchMock = mockFetch(200, {
      client_id: "cid-existing",
      secret_already_provisioned: true,
    });

    await provisionGatewayCredential({ ...BASE_OPTS, store, fetch: fetchMock });

    // The existing values must remain untouched — a 200 never re-returns the secret
    expect(store._data.get(SECRET_ID_GATEWAY_CLIENT_ID)).toBe("cid-existing");
    expect(store._data.get(SECRET_ID_GATEWAY_CLIENT_SECRET)).toBe("csec-existing");
    // The store must have exactly 2 entries (no new writes)
    expect(store._data.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Error responses — 401, 403, 503
// ---------------------------------------------------------------------------

describe("provisionGatewayCredential — error responses", () => {
  it("throws an error containing the HTTP status for a 401 (bad bootstrap token)", async () => {
    const store = fakeStore();
    const fetchMock = mockFetchText(401, "Unauthorized");

    await expect(
      provisionGatewayCredential({ ...BASE_OPTS, store, fetch: fetchMock }),
    ).rejects.toThrow("401");
  });

  it("throws an error containing the HTTP status for a 403 (user_id mismatch)", async () => {
    const store = fakeStore();
    const fetchMock = mockFetchText(403, "Forbidden");

    await expect(
      provisionGatewayCredential({ ...BASE_OPTS, store, fetch: fetchMock }),
    ).rejects.toThrow("403");
  });

  it("throws an error containing the HTTP status for a 503 (provisioning disabled)", async () => {
    const store = fakeStore();
    const fetchMock = mockFetchText(503, "Service Unavailable");

    await expect(
      provisionGatewayCredential({ ...BASE_OPTS, store, fetch: fetchMock }),
    ).rejects.toThrow("503");
  });

  it("does NOT write to the store when the gateway returns an error", async () => {
    const store = fakeStore();
    const fetchMock = mockFetchText(401, "Unauthorized");

    await expect(
      provisionGatewayCredential({ ...BASE_OPTS, store, fetch: fetchMock }),
    ).rejects.toThrow();

    expect(store._data.size).toBe(0);
  });
});
