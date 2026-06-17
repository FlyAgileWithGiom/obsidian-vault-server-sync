import { describe, it, expect, vi } from "vitest";
import {
  KeychainSecretStore,
  KEYCHAIN_SERVICE,
  type ExecFileLike,
} from "./keychain-secret-store";
import { SECRET_ID_COUCH_PASSWORD } from "../src/secret-store";

// ---------------------------------------------------------------------------
// KeychainSecretStore — macOS `security` CLI backend for the daemon (#78)
//
// The `security` binary is never invoked in tests: an injected execFile-like
// runner stands in. The real point of these tests is that EVERY failure mode
// (non-zero exit, not-found, locked, timeout) collapses to null / swallow, so a
// wedged or locked keychain can never hang or crash the KeepAlive launchd daemon.
// ---------------------------------------------------------------------------

function darwinOpts(execFile: ExecFileLike) {
  return { platform: "darwin" as NodeJS.Platform, execFile };
}

describe("KeychainSecretStore.isAvailable", () => {
  it("is true on darwin", () => {
    const store = new KeychainSecretStore(darwinOpts(vi.fn()));
    expect(store.isAvailable()).toBe(true);
  });

  it("is false off darwin (security CLI is macOS-only)", () => {
    const store = new KeychainSecretStore({ platform: "linux", execFile: vi.fn() });
    expect(store.isAvailable()).toBe(false);
  });
});

describe("KeychainSecretStore.get", () => {
  it("returns the secret from `security find-generic-password -w`, trimmed", async () => {
    const execFile: ExecFileLike = vi.fn(async (_file, _args) => ({
      // security appends a trailing newline to -w output.
      stdout: "hunter2\n",
      stderr: "",
    }));
    const store = new KeychainSecretStore(darwinOpts(execFile));

    const value = await store.get(SECRET_ID_COUCH_PASSWORD);
    expect(value).toBe("hunter2");

    // Invoked the find subcommand with -w against the shared service + the id as account.
    expect(execFile).toHaveBeenCalledTimes(1);
    const [file, args] = (execFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(file).toBe("security");
    expect(args).toContain("find-generic-password");
    expect(args).toContain("-w");
    expect(args).toContain("-s");
    expect(args).toContain(KEYCHAIN_SERVICE);
    expect(args).toContain("-a");
    expect(args).toContain(SECRET_ID_COUCH_PASSWORD);
  });

  it("returns null when the item is not found (security exits non-zero / rejects)", async () => {
    const execFile: ExecFileLike = vi.fn(async () => {
      const err = new Error("The specified item could not be found in the keychain.") as Error & {
        code?: number;
      };
      err.code = 44; // errSecItemNotFound
      throw err;
    });
    const store = new KeychainSecretStore(darwinOpts(execFile));
    expect(await store.get(SECRET_ID_COUCH_PASSWORD)).toBeNull();
  });

  it("returns null when the keychain is locked / access denied (never prompts or hangs)", async () => {
    const execFile: ExecFileLike = vi.fn(async () => {
      const err = new Error("User interaction is not allowed.") as Error & { code?: number };
      err.code = 36; // errSecInteractionNotAllowed
      throw err;
    });
    const store = new KeychainSecretStore(darwinOpts(execFile));
    expect(await store.get(SECRET_ID_COUCH_PASSWORD)).toBeNull();
  });

  it("returns null when the runner times out (bounded — security wedged on a GUI prompt)", async () => {
    const execFile: ExecFileLike = vi.fn(async () => {
      const err = new Error("spawn ETIMEDOUT") as Error & { killed?: boolean; signal?: string };
      err.killed = true;
      err.signal = "SIGTERM";
      throw err;
    });
    const store = new KeychainSecretStore(darwinOpts(execFile));
    expect(await store.get(SECRET_ID_COUCH_PASSWORD)).toBeNull();
  });

  it("returns null without touching security when off darwin", async () => {
    const execFile = vi.fn();
    const store = new KeychainSecretStore({ platform: "linux", execFile });
    expect(await store.get(SECRET_ID_COUCH_PASSWORD)).toBeNull();
    expect(execFile).not.toHaveBeenCalled();
  });

  it("passes a bounded timeout to the runner so a blocking security call cannot hang the daemon", async () => {
    const execFile: ExecFileLike = vi.fn(async () => ({ stdout: "x\n", stderr: "" }));
    const store = new KeychainSecretStore(darwinOpts(execFile));
    await store.get(SECRET_ID_COUCH_PASSWORD);
    const [, , opts] = (execFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts).toBeTruthy();
    expect(typeof opts.timeout).toBe("number");
    expect(opts.timeout).toBeGreaterThan(0);
  });
});

describe("KeychainSecretStore.set", () => {
  it("adds/updates the item via `security add-generic-password -U` and does not throw", async () => {
    const execFile: ExecFileLike = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const store = new KeychainSecretStore(darwinOpts(execFile));

    await expect(store.set(SECRET_ID_COUCH_PASSWORD, "hunter2")).resolves.toBeUndefined();

    const [file, args] = (execFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(file).toBe("security");
    expect(args).toContain("add-generic-password");
    expect(args).toContain("-U"); // update if exists
    expect(args).toContain("-s");
    expect(args).toContain(KEYCHAIN_SERVICE);
    expect(args).toContain("-a");
    expect(args).toContain(SECRET_ID_COUCH_PASSWORD);
    // Secret value passed via -w
    expect(args).toContain("-w");
    expect(args).toContain("hunter2");
  });

  it("swallows errors (a locked keychain leaves the legacy in-vault value in place)", async () => {
    const execFile: ExecFileLike = vi.fn(async () => {
      throw new Error("write denied");
    });
    const store = new KeychainSecretStore(darwinOpts(execFile));
    await expect(store.set(SECRET_ID_COUCH_PASSWORD, "x")).resolves.toBeUndefined();
  });

  it("is a no-op off darwin", async () => {
    const execFile = vi.fn();
    const store = new KeychainSecretStore({ platform: "linux", execFile });
    await store.set(SECRET_ID_COUCH_PASSWORD, "x");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("does NOT add -A by default (item stays ACL-restricted)", async () => {
    const execFile: ExecFileLike = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const store = new KeychainSecretStore(darwinOpts(execFile));
    await store.set(SECRET_ID_COUCH_PASSWORD, "x");
    const [, args] = (execFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args).not.toContain("-A");
  });

  it("adds -A when allowAnyApp is set (so the headless daemon reads without a GUI prompt)", async () => {
    const execFile: ExecFileLike = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const store = new KeychainSecretStore({ ...darwinOpts(execFile), allowAnyApp: true });
    await store.set(SECRET_ID_COUCH_PASSWORD, "x");
    const [, args] = (execFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args).toContain("-A");
  });

  it("passes a custom timeoutMs through to the runner (interactive login needs a long one)", async () => {
    const execFile: ExecFileLike = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const store = new KeychainSecretStore({ ...darwinOpts(execFile), timeoutMs: 120_000 });
    await store.set(SECRET_ID_COUCH_PASSWORD, "x");
    const [, , opts] = (execFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.timeout).toBe(120_000);
  });
});

describe("KeychainSecretStore.delete", () => {
  it("invokes `security delete-generic-password` with the shared service and the account id", async () => {
    const execFile: ExecFileLike = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const store = new KeychainSecretStore(darwinOpts(execFile));

    await expect(store.delete(SECRET_ID_COUCH_PASSWORD)).resolves.toBeUndefined();

    expect(execFile).toHaveBeenCalledTimes(1);
    const [file, args] = (execFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(file).toBe("security");
    expect(args).toContain("delete-generic-password");
    expect(args).toContain("-s");
    expect(args).toContain(KEYCHAIN_SERVICE);
    expect(args).toContain("-a");
    expect(args).toContain(SECRET_ID_COUCH_PASSWORD);
  });

  it("swallows the not-found error (item absent — delete is idempotent)", async () => {
    const execFile: ExecFileLike = vi.fn(async () => {
      const err = new Error("The specified item could not be found in the keychain.") as Error & {
        code?: number;
      };
      err.code = 44; // errSecItemNotFound
      throw err;
    });
    const store = new KeychainSecretStore(darwinOpts(execFile));
    await expect(store.delete(SECRET_ID_COUCH_PASSWORD)).resolves.toBeUndefined();
  });

  it("swallows the locked / access-denied error (never prompts or hangs)", async () => {
    const execFile: ExecFileLike = vi.fn(async () => {
      const err = new Error("User interaction is not allowed.") as Error & { code?: number };
      err.code = 36; // errSecInteractionNotAllowed
      throw err;
    });
    const store = new KeychainSecretStore(darwinOpts(execFile));
    await expect(store.delete(SECRET_ID_COUCH_PASSWORD)).resolves.toBeUndefined();
  });

  it("swallows a timeout (bounded — security must never hang the daemon on delete)", async () => {
    const execFile: ExecFileLike = vi.fn(async () => {
      const err = new Error("spawn ETIMEDOUT") as Error & { killed?: boolean; signal?: string };
      err.killed = true;
      err.signal = "SIGTERM";
      throw err;
    });
    const store = new KeychainSecretStore(darwinOpts(execFile));
    await expect(store.delete(SECRET_ID_COUCH_PASSWORD)).resolves.toBeUndefined();
  });

  it("is a no-op off darwin (security CLI is macOS-only)", async () => {
    const execFile = vi.fn();
    const store = new KeychainSecretStore({ platform: "linux", execFile });
    await store.delete(SECRET_ID_COUCH_PASSWORD);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("passes a bounded timeout to the runner so a blocking security call cannot hang the daemon", async () => {
    const execFile: ExecFileLike = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const store = new KeychainSecretStore(darwinOpts(execFile));
    await store.delete(SECRET_ID_COUCH_PASSWORD);
    const [, , opts] = (execFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts).toBeTruthy();
    expect(typeof opts.timeout).toBe("number");
    expect(opts.timeout).toBeGreaterThan(0);
  });
});
