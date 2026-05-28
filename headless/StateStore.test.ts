import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { JsonStateStore } from "./StateStore";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "state-store-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// JsonStateStore
// ---------------------------------------------------------------------------

describe("JsonStateStore", () => {
  it("persistence round-trip: fresh instance reads values written by a previous instance", () => {
    const filePath = path.join(tmpDir, "state.json");

    const store1 = new JsonStateStore(filePath);
    store1.set("vault-sync-revmap", "abc123");
    store1.set("lastSync", "2026-05-28T00:00:00Z");

    // Construct a brand new instance pointing at the same file — simulates a
    // daemon restart. It must load from disk, not from any shared in-memory state.
    const store2 = new JsonStateStore(filePath);
    expect(store2.get("vault-sync-revmap")).toBe("abc123");
    expect(store2.get("lastSync")).toBe("2026-05-28T00:00:00Z");
  });

  it("get() returns null for a key that was never set", () => {
    const store = new JsonStateStore(path.join(tmpDir, "state.json"));
    expect(store.get("nonexistent")).toBeNull();
  });

  it("set() writes to disk immediately (regression guard — save() must be called on every set)", () => {
    const filePath = path.join(tmpDir, "state.json");
    const store = new JsonStateStore(filePath);
    store.set("key", "value");

    // Read the file directly — if save() is a no-op the file won't contain the key.
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, string>;
    expect(parsed["key"]).toBe("value");
  });

  it("creates the parent directory when it does not yet exist (nested path)", () => {
    const nested = path.join(tmpDir, "a", "b", "c", "state.json");
    const store = new JsonStateStore(nested);
    store.set("k", "v");

    expect(fs.existsSync(nested)).toBe(true);
  });

  it("starts with empty state when the file does not exist", () => {
    const store = new JsonStateStore(path.join(tmpDir, "no-such-file.json"));
    expect(store.get("anything")).toBeNull();
  });
});
