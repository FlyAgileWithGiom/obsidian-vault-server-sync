#!/usr/bin/env node
/**
 * Post-build hook: kickstart LaunchAgents so the running daemon picks up the
 * freshly compiled dist/headless.js instead of stale bytes loaded at launch.
 *
 * Behaviour:
 *  - Non-macOS: exits 0 silently (no LaunchAgents on Linux/Windows)
 *  - Each known label: check if loaded via `launchctl list`, kickstart if yes
 *  - Not loaded: skip silently (daemon not set up on this machine)
 *  - kickstart failure: log and exit 0 (non-fatal — don't break dev loop)
 */

import { execSync } from "node:child_process";
import os from "node:os";

const LABELS = [
  "com.flyagile.vault-sync-daemon",
  "com.flyagile.vault-sync-daemon.mantu",
];

/**
 * Core logic extracted for dependency injection and unit testing.
 *
 * @param {object} deps
 * @param {string}   deps.platform  - os.platform() value
 * @param {string}   deps.uid       - numeric user id as string (id -u equivalent)
 * @param {Function} deps.exec      - (cmd: string) => string  (throws on non-zero exit)
 * @param {Function} deps.log       - (msg: string) => void
 * @param {Function} deps.error     - (msg: string) => void
 * @returns {number} exit code (always 0)
 */
export function kickstart({ platform, uid, exec, log, error }) {
  if (platform !== "darwin") {
    // Not macOS — LaunchAgents don't apply
    return 0;
  }

  for (const label of LABELS) {
    let loaded = false;
    try {
      exec(`launchctl list ${label}`);
      loaded = true;
    } catch {
      // launchctl list exits non-zero when the label is not loaded
      loaded = false;
    }

    if (!loaded) {
      continue; // not set up on this machine, skip silently
    }

    try {
      exec(`launchctl kickstart -k "gui/${uid}/${label}"`);
      log(`[postbuild] kickstarted ${label}`);
    } catch (err) {
      // Non-fatal: log the error but don't fail the build
      error(`[postbuild] kickstart failed for ${label}: ${err.message ?? err}`);
    }
  }

  return 0;
}

// --- Entry point (direct invocation) ---
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const code = kickstart({
    platform: os.platform(),
    uid: String(os.userInfo().uid),
    exec: (cmd) => execSync(cmd, { stdio: "pipe" }).toString(),
    log: (msg) => process.stdout.write(msg + "\n"),
    error: (msg) => process.stderr.write(msg + "\n"),
  });
  process.exit(code);
}
