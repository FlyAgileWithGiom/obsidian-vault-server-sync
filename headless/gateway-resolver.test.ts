import { describe, it, expect, vi } from "vitest";
import { buildGatewayCredsResolver, resolveGatewayClientId } from "./gateway-resolver";
import {
  SECRET_ID_GATEWAY_CLIENT_ID,
  SECRET_ID_GATEWAY_REFRESH_TOKEN,
  ENV_GATEWAY_CLIENT_ID,
  type SecretStore,
} from "../src/secret-store";

/** In-memory SecretStore stand-in. */
function fakeStore(initial: Record<string, string> = {}): SecretStore {
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
  };
}

describe("buildGatewayCredsResolver", () => {
  it("returns null (Phase A fallback) when no client_id is available", async () => {
    const resolver = buildGatewayCredsResolver({
      gatewayUrl: "https://mcp.fly-agile.com",
      store: fakeStore({ [SECRET_ID_GATEWAY_REFRESH_TOKEN]: "rt" }),
      env: {},
    });
    expect(await resolver()).toBeNull();
  });

  it("returns null (Phase A fallback) when no refresh token is stored", async () => {
    const resolver = buildGatewayCredsResolver({
      gatewayUrl: "https://mcp.fly-agile.com",
      store: fakeStore({ [SECRET_ID_GATEWAY_CLIENT_ID]: "client_x" }),
      env: {},
    });
    expect(await resolver()).toBeNull();
  });

  it("returns a Bearer-injecting fetch when client_id + refresh token are present", async () => {
    const store = fakeStore({
      [SECRET_ID_GATEWAY_CLIENT_ID]: "client_x",
      [SECRET_ID_GATEWAY_REFRESH_TOKEN]: "rt_seed",
    });

    // The token manager will refresh once on first use; mock that round-trip.
    const fetchSpy = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/token")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              access_token: "access_jwt",
              refresh_token: "rt_rotated",
              token_type: "Bearer",
              expires_in: 86400,
            };
          },
          async text() {
            return "";
          },
        } as unknown as Response;
      }
      // The proxied CouchDB call: assert the Bearer header is injected.
      const headers = (init?.headers ?? {}) as Record<string, string>;
      return {
        ok: true,
        status: 200,
        _authHeader: headers.Authorization,
        async json() {
          return {};
        },
        async text() {
          return "";
        },
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchSpy);

    try {
      const resolver = buildGatewayCredsResolver({
        gatewayUrl: "https://mcp.fly-agile.com",
        store,
        env: {},
      });
      const gatewayFetch = await resolver();
      expect(gatewayFetch).not.toBeNull();

      const resp = (await gatewayFetch!("https://mcp.fly-agile.com/couchdb/vault-x/_all_docs")) as Response & {
        _authHeader?: string;
      };
      expect(resp._authHeader).toBe("Bearer access_jwt");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("prefers an env client_id over the stored one", async () => {
    const store = fakeStore({
      [SECRET_ID_GATEWAY_CLIENT_ID]: "store_client",
      [SECRET_ID_GATEWAY_REFRESH_TOKEN]: "rt",
    });
    const seenClientIds: string[] = [];
    const fetchSpy = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/token")) {
        seenClientIds.push(String(new URLSearchParams(String(init?.body)).get("client_id")));
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              access_token: "a",
              refresh_token: "b",
              token_type: "Bearer",
              expires_in: 86400,
            };
          },
          async text() {
            return "";
          },
        } as unknown as Response;
      }
      return { ok: true, status: 200, async json() { return {}; }, async text() { return ""; } } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const resolver = buildGatewayCredsResolver({
        gatewayUrl: "https://mcp.fly-agile.com",
        store,
        env: { [ENV_GATEWAY_CLIENT_ID]: "env_client" },
      });
      const gatewayFetch = await resolver();
      await gatewayFetch!("https://mcp.fly-agile.com/couchdb/vault-x");
      expect(seenClientIds).toContain("env_client");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("resolveGatewayClientId", () => {
  it("returns the env client_id when set", async () => {
    const id = await resolveGatewayClientId({
      store: fakeStore({ [SECRET_ID_GATEWAY_CLIENT_ID]: "store_client" }),
      env: { [ENV_GATEWAY_CLIENT_ID]: "env_client" },
    });
    expect(id).toBe("env_client");
  });

  it("falls back to the stored client_id", async () => {
    const id = await resolveGatewayClientId({
      store: fakeStore({ [SECRET_ID_GATEWAY_CLIENT_ID]: "store_client" }),
      env: {},
    });
    expect(id).toBe("store_client");
  });

  it("returns empty string when no client_id is anywhere", async () => {
    const id = await resolveGatewayClientId({ store: fakeStore(), env: {} });
    expect(id).toBe("");
  });
});
