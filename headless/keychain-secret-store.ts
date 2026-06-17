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
  private readonly timeoutMs: number;
  private readonly allowAnyApp: boolean;

  constructor(
    opts: {
      platform?: NodeJS.Platform;
      execFile?: ExecFileLike;
      /**
       * Per-call timeout. The default (5s) protects the HEADLESS daemon from
       * hanging on a GUI prompt. The interactive `--login` MUST pass a long value
       * so the one-time "Always Allow" authorization prompt can actually be
       * answered before the `security` process is killed.
       */
      timeoutMs?: number;
      /**
       * Add `-A` on write so any local app (i.e. the headless daemon's own
       * `security` invocations) can read the item WITHOUT a GUI prompt. Required
       * for a daemon that must read the token unattended after the one-time login.
       */
      allowAnyApp?: boolean;
    } = {},
  ) {
    this.platform = opts.platform ?? process.platform;
    this.execFile = opts.execFile ?? defaultExecFile;
    this.timeoutMs = opts.timeoutMs ?? SECURITY_TIMEOUT_MS;
    this.allowAnyApp = opts.allowAnyApp ?? false;
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
        { timeout: this.timeoutMs, killSignal: "SIGTERM" },
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
      // -U updates the item if it already exists (instead of erroring on dup).
      // -A (when allowAnyApp) grants read access to any app so the headless daemon
      // never has to answer a GUI authorization prompt on its silent reads.
      const args = ["add-generic-password", "-U"];
      if (this.allowAnyApp) args.push("-A");
      args.push("-s", KEYCHAIN_SERVICE, "-a", id, "-w", value);
      await this.execFile("security", args, {
        timeout: this.timeoutMs,
        killSignal: "SIGTERM",
      });
    } catch {
      // Best-effort: a failed write leaves the legacy in-vault value in place.
    }
  }

  async delete(id: string): Promise<void> {
    if (!this.isAvailable()) return;
    try {
      await this.execFile(
        "security",
        ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", id],
        { timeout: this.timeoutMs, killSignal: "SIGTERM" },
      );
    } catch {
      // not-found / locked / denied / timeout — all swallowed. Delete is
      // best-effort: a wedged keychain must never hang or crash the daemon.
    }
  }
}
