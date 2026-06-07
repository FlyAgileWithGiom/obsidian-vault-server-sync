import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import type { SecretStore } from "../src/secret-store";

/**
 * macOS Keychain SecretStore for the headless daemon (#78).
 *
 * Giom's explicit choice over a credential file: the CouchDB user/password live
 * in the login keychain (`security` CLI), never in the synced vault. The
 * K8s/SealedSecret consumer is separate and out of scope.
 *
 * SAFETY — must never hang or crash the daemon (invariant 6):
 *   The daemon runs under a `KeepAlive` LaunchAgent. If the login keychain is
 *   locked or the item is not authorised for non-interactive access, `security`
 *   can BLOCK on a GUI prompt that no headless process can answer. We bound every
 *   call with a timeout+killSignal and collapse EVERY failure (non-zero exit,
 *   not-found, locked, timeout) to null on read / a swallowed no-op on write, so
 *   the caller falls back to the legacy in-vault credential instead of wedging.
 *
 *   Launchd caveat: for non-interactive reads to succeed at all, the login
 *   keychain must be unlocked and node pre-authorised for the item (the `set`
 *   path uses `-U`; a one-time interactive `security add-generic-password -T`
 *   may be needed to grant the daemon access). Documented in the ADR.
 */

/** Shared keychain service name — single source of truth with the account ids. */
export const KEYCHAIN_SERVICE = "com.flyagile.vault-sync";

/** Bound each `security` invocation so a blocking prompt cannot hang the daemon. */
const SECURITY_TIMEOUT_MS = 5000;

/** Subset of node's execFile (promisified) that this store depends on. */
export type ExecFileLike = (
  file: string,
  args: string[],
  options: { timeout: number; killSignal: NodeJS.Signals },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExecFile = promisify(nodeExecFile) as unknown as ExecFileLike;

export class KeychainSecretStore implements SecretStore {
  private readonly platform: NodeJS.Platform;
  private readonly execFile: ExecFileLike;

  constructor(opts: { platform?: NodeJS.Platform; execFile?: ExecFileLike } = {}) {
    this.platform = opts.platform ?? process.platform;
    this.execFile = opts.execFile ?? defaultExecFile;
  }

  /** The `security` CLI is macOS-only; off darwin the store is inert. */
  isAvailable(): boolean {
    return this.platform === "darwin";
  }

  async get(id: string): Promise<string | null> {
    if (!this.isAvailable()) return null;
    try {
      const { stdout } = await this.execFile(
        "security",
        ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", id, "-w"],
        { timeout: SECURITY_TIMEOUT_MS, killSignal: "SIGTERM" },
      );
      // `-w` prints the bare password with a trailing newline.
      const value = stdout.replace(/\n$/, "");
      return value.length > 0 ? value : null;
    } catch {
      // not-found / locked / denied / timeout — all degrade to legacy fallback.
      return null;
    }
  }

  async set(id: string, value: string): Promise<void> {
    if (!this.isAvailable()) return;
    try {
      await this.execFile(
        "security",
        // -U updates the item if it already exists (instead of erroring on dup).
        ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", id, "-w", value],
        { timeout: SECURITY_TIMEOUT_MS, killSignal: "SIGTERM" },
      );
    } catch {
      // Best-effort: a failed write leaves the legacy in-vault value in place.
    }
  }
}
