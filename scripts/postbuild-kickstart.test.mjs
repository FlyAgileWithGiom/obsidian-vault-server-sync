import { describe, it, expect, vi } from "vitest";
import { kickstart } from "./postbuild-kickstart.mjs";

// Shared stub factory
function makeDeps(overrides = {}) {
  return {
    platform: "darwin",
    uid: "501",
    exec: vi.fn(),
    log: vi.fn(),
    error: vi.fn(),
    ...overrides,
  };
}

describe("postbuild-kickstart", () => {
  describe("non-macOS platform", () => {
    it("exits 0 without calling exec on Linux", () => {
      const deps = makeDeps({ platform: "linux" });
      const code = kickstart(deps);
      expect(code).toBe(0);
      expect(deps.exec).not.toHaveBeenCalled();
    });

    it("exits 0 without calling exec on Windows", () => {
      const deps = makeDeps({ platform: "win32" });
      const code = kickstart(deps);
      expect(code).toBe(0);
      expect(deps.exec).not.toHaveBeenCalled();
    });
  });

  describe("macOS — agent loaded", () => {
    it("kickstarts each loaded agent and logs success", () => {
      const deps = makeDeps({
        // exec succeeds for both list and kickstart calls
        exec: vi.fn().mockReturnValue(""),
      });
      const code = kickstart(deps);
      expect(code).toBe(0);

      // Should have called launchctl list + kickstart for each label
      const execCalls = deps.exec.mock.calls.map(([cmd]) => cmd);
      expect(execCalls).toContain(
        "launchctl list com.flyagile.vault-sync-daemon"
      );
      expect(execCalls).toContain(
        "launchctl list com.flyagile.vault-sync-daemon.mantu"
      );
      expect(execCalls).toContain(
        'launchctl kickstart -k "gui/501/com.flyagile.vault-sync-daemon"'
      );
      expect(execCalls).toContain(
        'launchctl kickstart -k "gui/501/com.flyagile.vault-sync-daemon.mantu"'
      );

      // Both logs should have been emitted
      expect(deps.log).toHaveBeenCalledWith(
        "[postbuild] kickstarted com.flyagile.vault-sync-daemon"
      );
      expect(deps.log).toHaveBeenCalledWith(
        "[postbuild] kickstarted com.flyagile.vault-sync-daemon.mantu"
      );
      expect(deps.error).not.toHaveBeenCalled();
    });
  });

  describe("macOS — agent not loaded", () => {
    it("skips silently when launchctl list exits non-zero", () => {
      const deps = makeDeps({
        // Simulate `launchctl list <label>` throwing (label not loaded)
        exec: vi.fn().mockImplementation((cmd) => {
          if (cmd.startsWith("launchctl list")) {
            throw new Error("Could not find service");
          }
          return "";
        }),
      });
      const code = kickstart(deps);
      expect(code).toBe(0);

      // No kickstart commands should have been issued
      const execCalls = deps.exec.mock.calls.map(([cmd]) => cmd);
      expect(execCalls.some((c) => c.includes("kickstart"))).toBe(false);

      // No log output
      expect(deps.log).not.toHaveBeenCalled();
      expect(deps.error).not.toHaveBeenCalled();
    });
  });

  describe("macOS — kickstart fails", () => {
    it("logs the error and still exits 0 (non-fatal)", () => {
      const deps = makeDeps({
        exec: vi.fn().mockImplementation((cmd) => {
          if (cmd.includes("kickstart")) {
            throw new Error("kickstart permission denied");
          }
          return ""; // list succeeds
        }),
      });
      const code = kickstart(deps);
      expect(code).toBe(0);
      expect(deps.error).toHaveBeenCalledTimes(2); // once per label
      expect(deps.error.mock.calls[0][0]).toMatch(/kickstart failed/);
      expect(deps.error.mock.calls[0][0]).toMatch(
        "com.flyagile.vault-sync-daemon"
      );
      // No success logs
      expect(deps.log).not.toHaveBeenCalled();
    });

    it("kickstart failure for one agent does not prevent the other from being tried", () => {
      let callCount = 0;
      const deps = makeDeps({
        exec: vi.fn().mockImplementation((cmd) => {
          if (cmd.includes("kickstart")) {
            callCount++;
            if (callCount === 1) throw new Error("first kickstart failed");
          }
          return "";
        }),
      });
      kickstart(deps);
      // Both kickstarts should have been attempted
      const kickstartCalls = deps.exec.mock.calls.filter(([cmd]) =>
        cmd.includes("kickstart")
      );
      expect(kickstartCalls).toHaveLength(2);
      // First failed → error logged; second succeeded → log emitted
      expect(deps.error).toHaveBeenCalledTimes(1);
      expect(deps.log).toHaveBeenCalledTimes(1);
    });
  });
});
