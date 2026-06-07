import { describe, it, expect } from "vitest";
import { App } from "./__mocks__/obsidian";
import {
  SECRET_ID_COUCH_USER,
  SECRET_ID_COUCH_PASSWORD,
  ENV_COUCH_USER,
  ENV_COUCH_PASSWORD,
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
