import { describe, it, expect } from "vitest";
import { App } from "./__mocks__/obsidian";
import {
  SECRET_ID_COUCH_USER,
  SECRET_ID_COUCH_PASSWORD,
  ENV_COUCH_USER,
  ENV_COUCH_PASSWORD,
  SECRET_ID_GATEWAY_CLIENT_ID,
  SECRET_ID_GATEWAY_REFRESH_TOKEN,
  ENV_GATEWAY_CLIENT_ID,
  ENV_GATEWAY_REFRESH_TOKEN,
  SecretStorageSecretStore,
  resolveSecret,
  readEnvSecret,
  type SecretStore,
} from "./secret-store";

// ---------------------------------------------------------------------------
// Logical-name → valid Obsidian secret id mapping
// ---------------------------------------------------------------------------
// Obsidian's SecretStorage requires lowercase-alphanumeric-with-dashes ids, so
// couchDbUser/couchDbPassword cannot be used verbatim. Lock the mapped ids.

describe("secret id constants", () => {
  it("maps logical credentials to valid lowercase-dash ids", () => {
    expect(SECRET_ID_COUCH_USER).toBe("vault-sync-couch-user");
    expect(SECRET_ID_COUCH_PASSWORD).toBe("vault-sync-couch-password");
    // Must satisfy Obsidian's id rule: lowercase alphanumeric with optional dashes
    for (const id of [SECRET_ID_COUCH_USER, SECRET_ID_COUCH_PASSWORD]) {
      expect(id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("uses VAULT_SYNC_COUCH_USER / VAULT_SYNC_COUCH_PASSWORD env var names", () => {
    expect(ENV_COUCH_USER).toBe("VAULT_SYNC_COUCH_USER");
    expect(ENV_COUCH_PASSWORD).toBe("VAULT_SYNC_COUCH_PASSWORD");
  });
});

// ---------------------------------------------------------------------------
// SecretStorageSecretStore — wraps app.secretStorage (Obsidian >= 1.11.4)
// ---------------------------------------------------------------------------

describe("SecretStorageSecretStore", () => {
  it("writes a secret to app.secretStorage under the mapped id and reads it back", async () => {
    const app = new App();
    const store = new SecretStorageSecretStore(app);

    await store.set(SECRET_ID_COUCH_PASSWORD, "s3cret");

    // Stored under the exact id (not the logical name)
    expect(app.secretStorage.getSecret(SECRET_ID_COUCH_PASSWORD)).toBe("s3cret");
    expect(await store.get(SECRET_ID_COUCH_PASSWORD)).toBe("s3cret");
  });

  it("returns null for an unset secret", async () => {
    const app = new App();
    const store = new SecretStorageSecretStore(app);
    expect(await store.get(SECRET_ID_COUCH_USER)).toBeNull();
  });

  it("isAvailable() is true when app.secretStorage is present", () => {
    const app = new App();
    const store = new SecretStorageSecretStore(app);
    expect(store.isAvailable()).toBe(true);
  });

  it("isAvailable() is false and get/set degrade gracefully when secretStorage is absent (pre-1.11.4)", async () => {
    // Simulate an older Obsidian runtime: no secretStorage on app.
    const app = { vault: {} } as unknown as App;
    const store = new SecretStorageSecretStore(app);

    expect(store.isAvailable()).toBe(false);
    // get must return null (caller falls back to legacy in-vault), never throw
    expect(await store.get(SECRET_ID_COUCH_PASSWORD)).toBeNull();
    // set must be a no-op, never throw
    await expect(store.set(SECRET_ID_COUCH_PASSWORD, "x")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// readEnvSecret — iOS-safe env reader (process may be undefined on mobile)
// ---------------------------------------------------------------------------

describe("readEnvSecret", () => {
  it("returns the env value when set", () => {
    expect(readEnvSecret("FOO", { FOO: "bar" })).toBe("bar");
  });

  it("returns null for an unset/empty env var", () => {
    expect(readEnvSecret("FOO", {})).toBeNull();
    expect(readEnvSecret("FOO", { FOO: "" })).toBeNull();
  });

  it("returns null when the env source is undefined (iOS Obsidian — no process)", () => {
    // process.env is undefined on mobile; readEnvSecret must not throw.
    expect(readEnvSecret("FOO", undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveSecret — precedence: env -> store -> legacy in-vault
// ---------------------------------------------------------------------------

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

describe("resolveSecret precedence (env > store > legacy in-vault)", () => {
  it("prefers env over store and legacy", async () => {
    const store = fakeStore({ x: "from-store" });
    const v = await resolveSecret({
      envName: "X_ENV",
      env: { X_ENV: "from-env" },
      store,
      id: "x",
      legacy: "from-legacy",
    });
    expect(v).toBe("from-env");
  });

  it("falls back to store when env is unset", async () => {
    const store = fakeStore({ x: "from-store" });
    const v = await resolveSecret({
      envName: "X_ENV",
      env: {},
      store,
      id: "x",
      legacy: "from-legacy",
    });
    expect(v).toBe("from-store");
  });

  it("falls back to legacy in-vault when env and store are both empty", async () => {
    const store = fakeStore({});
    const v = await resolveSecret({
      envName: "X_ENV",
      env: {},
      store,
      id: "x",
      legacy: "from-legacy",
    });
    expect(v).toBe("from-legacy");
  });

  it("returns empty string (not a throw) when nothing is found anywhere — fail-safe to plain auth failure", async () => {
    const store = fakeStore({});
    const v = await resolveSecret({
      envName: "X_ENV",
      env: {},
      store,
      id: "x",
      legacy: "",
    });
    // Empty -> downstream builds a credential-less URL -> plain 401, never a destructive resync.
    expect(v).toBe("");
  });

  it("tolerates an unavailable store (returns null) and falls through to legacy", async () => {
    const unavailable: SecretStore = {
      async get() {
        return null;
      },
      async set() {
        /* no-op */
      },
      isAvailable() {
        return false;
      },
    };
    const v = await resolveSecret({
      envName: "X_ENV",
      env: {},
      store: unavailable,
      id: "x",
      legacy: "from-legacy",
    });
    expect(v).toBe("from-legacy");
  });
});

// ---------------------------------------------------------------------------
// Gateway Clerk OAuth credential constants (public PKCE client)
// ---------------------------------------------------------------------------
// The clients are public PKCE OAuth clients: there is NO client_secret. Only the
// DCR-registered client_id and the rotating refresh_token are persisted. The
// access token is short-lived (1-day Clerk JWT) and held in-memory only — never
// stored.

describe("gateway secret id constants", () => {
  it("maps gateway client_id to a valid lowercase-dash Obsidian secret id", () => {
    expect(SECRET_ID_GATEWAY_CLIENT_ID).toBe("vault-sync-gateway-client-id");
    expect(SECRET_ID_GATEWAY_CLIENT_ID).toMatch(/^[a-z0-9-]+$/);
  });

  it("does NOT export a client_secret id — public PKCE clients have no secret", async () => {
    // Guard against regressing to the obsolete client_credentials model. A public
    // PKCE client stores only client_id + refresh_token, never a client_secret.
    const mod = (await import("./secret-store")) as Record<string, unknown>;
    expect(mod.SECRET_ID_GATEWAY_CLIENT_SECRET).toBeUndefined();
    expect(mod.ENV_GATEWAY_CLIENT_SECRET).toBeUndefined();
  });

  it("maps gateway refresh_token to a valid lowercase-dash Obsidian secret id", () => {
    expect(SECRET_ID_GATEWAY_REFRESH_TOKEN).toBe("vault-sync-gateway-refresh-token");
    expect(SECRET_ID_GATEWAY_REFRESH_TOKEN).toMatch(/^[a-z0-9-]+$/);
  });

  it("uses VAULT_SYNC_GATEWAY_* env var names following the existing convention", () => {
    expect(ENV_GATEWAY_CLIENT_ID).toBe("VAULT_SYNC_GATEWAY_CLIENT_ID");
    expect(ENV_GATEWAY_REFRESH_TOKEN).toBe("VAULT_SYNC_GATEWAY_REFRESH_TOKEN");
  });
});

describe("gateway refresh token round-trips through the store", () => {
  it("stores and retrieves the rotating refresh token via resolveSecret precedence", async () => {
    const app = new App();
    const store = new SecretStorageSecretStore(app);

    // Simulate token manager persisting a received refresh token
    await store.set(SECRET_ID_GATEWAY_REFRESH_TOKEN, "rt-abc123");

    const resolved = await resolveSecret({
      envName: ENV_GATEWAY_REFRESH_TOKEN,
      env: {},
      store,
      id: SECRET_ID_GATEWAY_REFRESH_TOKEN,
      // Gateway refresh token has no in-vault legacy value — degrade to empty string
      // which yields a plain auth failure rather than a destructive operation.
      legacy: "",
    });
    expect(resolved).toBe("rt-abc123");
  });

  it("env override takes precedence over stored refresh token", async () => {
    const app = new App();
    const store = new SecretStorageSecretStore(app);
    await store.set(SECRET_ID_GATEWAY_REFRESH_TOKEN, "rt-from-store");

    const resolved = await resolveSecret({
      envName: ENV_GATEWAY_REFRESH_TOKEN,
      env: { [ENV_GATEWAY_REFRESH_TOKEN]: "rt-from-env" },
      store,
      id: SECRET_ID_GATEWAY_REFRESH_TOKEN,
      legacy: "",
    });
    expect(resolved).toBe("rt-from-env");
  });

  it("returns empty string (fail-safe) when no gateway refresh token is anywhere — no throw", async () => {
    const app = new App();
    const store = new SecretStorageSecretStore(app);

    const resolved = await resolveSecret({
      envName: ENV_GATEWAY_REFRESH_TOKEN,
      env: {},
      store,
      id: SECRET_ID_GATEWAY_REFRESH_TOKEN,
      legacy: "",
    });
    // Empty -> token manager falls through to client_credentials grant; not a crash.
    expect(resolved).toBe("");
  });
});
