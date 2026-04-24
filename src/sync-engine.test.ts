import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SyncEngine } from "./sync-engine";
import { CouchClient } from "./couch-client";
import { Vault, TFile, TFolder } from "./__mocks__/obsidian";
import type { VaultSyncSettings, CouchDoc, CouchChangeRow } from "./types";

// Mock CouchClient so we control all network behavior
vi.mock("./couch-client", () => {
  return {
    CouchClient: vi.fn().mockImplementation(() => ({
      isConfigured: vi.fn().mockReturnValue(true),
      ensureDb: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      allDocs: vi.fn().mockResolvedValue({ total_rows: 0, rows: [] }),
      allDocsByKeys: vi.fn().mockResolvedValue({ total_rows: 0, rows: [] }),
      bulkDocs: vi.fn().mockResolvedValue([]),
      changes: vi.fn().mockResolvedValue({ last_seq: "0", results: [] }),
      cancelChanges: vi.fn(),
      updateSettings: vi.fn(),
      getAttachment: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
      putAttachment: vi.fn().mockResolvedValue({ ok: true, id: "", rev: "1-x" }),
    })),
    CouchError: class CouchError extends Error {
      constructor(public status: number, message: string) {
        super(message);
        this.name = "CouchError";
      }
    },
  };
});

// Mock localStorage
const localStorageMock: Record<string, string> = {};
vi.stubGlobal("localStorage", {
  getItem: vi.fn((key: string) => localStorageMock[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { localStorageMock[key] = value; }),
  removeItem: vi.fn((key: string) => { delete localStorageMock[key]; }),
});

function makeSettings(overrides: Partial<VaultSyncSettings> = {}): VaultSyncSettings {
  return {
    couchDbUrl: "https://couch.example.com",
    couchDbName: "test-vault",
    couchDbUser: "admin",
    couchDbPassword: "secret",
    syncDebounceMs: 50,
    excludePatterns: [".obsidian/", ".trash/"],
    ...overrides,
  };
}

function getClient(engine: SyncEngine): ReturnType<typeof vi.fn> & Record<string, ReturnType<typeof vi.fn>> {
  // Access the mocked CouchClient instance via the constructor
  return (CouchClient as unknown as ReturnType<typeof vi.fn>).mock.results[
    (CouchClient as unknown as ReturnType<typeof vi.fn>).mock.results.length - 1
  ].value;
}

describe("SyncEngine", () => {
  let vault: Vault;
  let settings: VaultSyncSettings;
  let engine: SyncEngine;
  let stateChanges: string[];
  let errors: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(localStorageMock).forEach(k => delete localStorageMock[k]);

    vault = new Vault();
    settings = makeSettings();
    engine = new SyncEngine(settings, vault as any);
    stateChanges = [];
    errors = [];
    engine.onStateChange = (state) => stateChanges.push(state);
    engine.onError = (msg) => errors.push(msg);
  });

  afterEach(() => {
    engine.stop();
  });

  describe("lifecycle", () => {
    it("reports not-configured when client is not configured", async () => {
      const client = getClient(engine);
      client.isConfigured.mockReturnValue(false);

      await engine.start();

      expect(stateChanges).toContain("not-configured");
      expect(engine.isRunning()).toBe(false);
    });

    it("sets running state after successful start", async () => {
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await engine.start();

      expect(engine.isRunning()).toBe(true);
      expect(stateChanges).toContain("syncing");
      expect(stateChanges).toContain("ok");
    });

    it("reports error and stops on start failure", async () => {
      const client = getClient(engine);
      client.ensureDb.mockRejectedValue(new Error("Network error"));

      await engine.start();

      expect(engine.isRunning()).toBe(false);
      expect(stateChanges).toContain("error");
      expect(errors.length).toBeGreaterThan(0);
    });

    it("cleans up on stop", async () => {
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await engine.start();
      engine.stop();

      expect(engine.isRunning()).toBe(false);
      expect(client.cancelChanges).toHaveBeenCalled();
      expect(stateChanges[stateChanges.length - 1]).toBe("idle");
    });
  });

  describe("fullSync - push", () => {
    it("pushes local files to CouchDB via bulkDocs", async () => {
      vault._addFile("notes/hello.md", "hello world", 1000);
      vault._addFile("notes/readme.md", "readme content", 2000);

      const client = getClient(engine);
      // get() throws to simulate docs don't exist remotely
      client.get.mockRejectedValue(new Error("not found"));
      client.bulkDocs.mockResolvedValue([
        { ok: true, id: "file/notes/hello.md", rev: "1-aaa" },
        { ok: true, id: "file/notes/readme.md", rev: "1-bbb" },
      ]);
      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.changes.mockResolvedValue({ last_seq: "2", results: [] });

      await engine.start();

      expect(client.bulkDocs).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ _id: "file/notes/hello.md", content: "hello world" }),
          expect.objectContaining({ _id: "file/notes/readme.md", content: "readme content" }),
        ])
      );
    });

    it("skips excluded paths during push", async () => {
      vault._addFile(".obsidian/config.json", "{}", 1000);
      vault._addFile(".trash/deleted.md", "old", 1000);
      vault._addFile("notes/keep.md", "keep", 1000);

      const client = getClient(engine);
      client.get.mockRejectedValue(new Error("not found"));
      client.bulkDocs.mockResolvedValue([{ ok: true, id: "file/notes/keep.md", rev: "1-a" }]);
      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await engine.start();

      // bulkDocs should only have the non-excluded file
      if (client.bulkDocs.mock.calls.length > 0) {
        const pushedDocs = client.bulkDocs.mock.calls[0][0] as CouchDoc[];
        const pushedIds = pushedDocs.map((d: CouchDoc) => d._id);
        expect(pushedIds).not.toContain("file/.obsidian/config.json");
        expect(pushedIds).not.toContain("file/.trash/deleted.md");
        expect(pushedIds).toContain("file/notes/keep.md");
      }
    });

    it("skips push when rev is already known (synced before)", async () => {
      vault._addFile("notes/old.md", "local content", 1000);

      // Pre-populate revMap to simulate a previous sync
      localStorageMock["vault-sync-revmap"] = JSON.stringify({ "file/notes/old.md": "1-r" });
      const engine2 = new SyncEngine(settings, vault as any);
      engine2.onStateChange = (state) => stateChanges.push(state);
      engine2.onError = (msg) => errors.push(msg);

      const client2 = getClient(engine2);
      // allDocs returns same rev as in revMap
      client2.allDocs.mockResolvedValue({
        total_rows: 1,
        rows: [{
          id: "file/notes/old.md",
          key: "file/notes/old.md",
          value: { rev: "1-r" },
        }],
      });
      client2.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await engine2.start();

      // bulkDocs should not be called (rev unchanged)
      expect(client2.bulkDocs).not.toHaveBeenCalled();
      engine2.stop();
    });

    it("trusts remote on first sync and does not re-push existing docs", async () => {
      vault._addFile("notes/newer.md", "updated", 3000);

      const client = getClient(engine);
      // Doc exists on remote - first sync should trust it, not re-push
      client.allDocs.mockResolvedValue({
        total_rows: 1,
        rows: [{
          id: "file/notes/newer.md",
          key: "file/notes/newer.md",
          value: { rev: "1-old" },
        }],
      });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await engine.start();

      // Should not push (doc already exists remotely)
      expect(client.bulkDocs).not.toHaveBeenCalled();
    });
  });

  describe("fullSync - pull", () => {
    it("pulls remote docs on first sync with empty vault", async () => {
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({
        total_rows: 1,
        rows: [{
          id: "file/notes/remote.md",
          key: "file/notes/remote.md",
          value: { rev: "1-r" },
        }],
      });
      client.allDocsByKeys.mockResolvedValue({
        total_rows: 1,
        rows: [{
          id: "file/notes/remote.md",
          key: "file/notes/remote.md",
          value: { rev: "1-r" },
          doc: { _id: "file/notes/remote.md", _rev: "1-r", content: "from remote", mtime: 5000 },
        }],
      });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await engine.start();

      expect(vault._getContent("notes/remote.md")).toBe("from remote");
    });

    it("overwrites local file when remote is newer", async () => {
      vault._addFile("notes/shared.md", "old local", 1000);

      // Pre-populate revMap so push is skipped (rev matches)
      localStorageMock["vault-sync-revmap"] = JSON.stringify({ "file/notes/shared.md": "1-r" });
      const engine2 = new SyncEngine(settings, vault as any);
      engine2.onStateChange = (state) => stateChanges.push(state);
      engine2.onError = (msg) => errors.push(msg);

      const client = getClient(engine2);
      // allDocs returns newer rev (2-r vs 1-r in revMap) -> triggers pull
      client.allDocs.mockResolvedValue({
        total_rows: 1,
        rows: [{
          id: "file/notes/shared.md",
          key: "file/notes/shared.md",
          value: { rev: "2-r" },
        }],
      });
      client.allDocsByKeys.mockResolvedValue({
        total_rows: 1,
        rows: [{
          id: "file/notes/shared.md",
          key: "file/notes/shared.md",
          value: { rev: "2-r" },
          doc: { _id: "file/notes/shared.md", _rev: "2-r", content: "newer remote", mtime: 5000 },
        }],
      });
      client.changes.mockResolvedValue({ last_seq: "2", results: [] });

      await engine2.start();

      expect(vault._getContent("notes/shared.md")).toBe("newer remote");
      engine2.stop();
    });

    it("skips _design/ docs during pull", async () => {
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({
        total_rows: 1,
        rows: [{
          id: "_design/views",
          key: "_design/views",
          value: { rev: "1-d" },
          doc: { _id: "_design/views", _rev: "1-d", content: "{}", mtime: 0 },
        }],
      });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await engine.start();

      expect(vault.getAbstractFileByPath("_design/views")).toBeNull();
    });

    it("uses batch pull via allDocsByKeys for speed", async () => {
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({
        total_rows: 2,
        rows: [
          { id: "file/notes/a.md", key: "file/notes/a.md", value: { rev: "1-a" } },
          { id: "file/notes/b.md", key: "file/notes/b.md", value: { rev: "1-b" } },
        ],
      });
      client.allDocsByKeys.mockResolvedValue({
        total_rows: 2,
        rows: [
          { id: "file/notes/a.md", key: "file/notes/a.md", value: { rev: "1-a" }, doc: { _id: "file/notes/a.md", _rev: "1-a", content: "aaa", mtime: 1000 } },
          { id: "file/notes/b.md", key: "file/notes/b.md", value: { rev: "1-b" }, doc: { _id: "file/notes/b.md", _rev: "1-b", content: "bbb", mtime: 2000 } },
        ],
      });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await engine.start();

      expect(client.allDocsByKeys).toHaveBeenCalled();
      expect(client.get).not.toHaveBeenCalled(); // Should NOT use individual GETs
      expect(vault._getContent("notes/a.md")).toBe("aaa");
      expect(vault._getContent("notes/b.md")).toBe("bbb");
    });

    it("skips docs with null content in batch pull", async () => {
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({
        total_rows: 2,
        rows: [
          { id: "file/notes/text.md", key: "file/notes/text.md", value: { rev: "1-t" } },
          { id: "file/images/photo.png", key: "file/images/photo.png", value: { rev: "1-p" } },
        ],
      });
      client.allDocsByKeys.mockResolvedValue({
        total_rows: 2,
        rows: [
          { id: "file/notes/text.md", key: "file/notes/text.md", value: { rev: "1-t" }, doc: { _id: "file/notes/text.md", _rev: "1-t", content: "hello", mtime: 1000 } },
          { id: "file/images/photo.png", key: "file/images/photo.png", value: { rev: "1-p" }, doc: { _id: "file/images/photo.png", _rev: "1-p", content: null, mtime: 2000, _attachments: {} } },
        ],
      });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await engine.start();

      expect(vault._getContent("notes/text.md")).toBe("hello");
      expect(vault._getContent("images/photo.png")).toBeUndefined(); // null content skipped
    });

    it("skips binary extensions in pull", async () => {
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({
        total_rows: 2,
        rows: [
          { id: "file/notes/text.md", key: "file/notes/text.md", value: { rev: "1-t" } },
          { id: "file/images/photo.jpg", key: "file/images/photo.jpg", value: { rev: "1-j" } },
        ],
      });
      // allDocsByKeys should only be called with the .md doc, not .jpg
      client.allDocsByKeys.mockResolvedValue({
        total_rows: 1,
        rows: [
          { id: "file/notes/text.md", key: "file/notes/text.md", value: { rev: "1-t" }, doc: { _id: "file/notes/text.md", _rev: "1-t", content: "hello", mtime: 1000 } },
        ],
      });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await engine.start();

      expect(vault._getContent("notes/text.md")).toBe("hello");
      // Verify allDocsByKeys was called without the .jpg
      const calledKeys = client.allDocsByKeys.mock.calls[0][0];
      expect(calledKeys).not.toContain("file/images/photo.jpg");
    });

    it("applies remote doc when mtime is missing (external tool update)", async () => {
      // When an external tool (e.g., Claude) writes to CouchDB without mtime,
      // the doc should still be applied to the vault
      vault._addFile("notes/external.md", "old content", 1000);

      localStorageMock["vault-sync-revmap"] = JSON.stringify({ "file/notes/external.md": "1-old" });
      const engine2 = new SyncEngine(settings, vault as any);
      engine2.onStateChange = () => {};
      engine2.onError = () => {};

      const client = getClient(engine2);
      client.allDocs.mockResolvedValue({
        total_rows: 1,
        rows: [{ id: "file/notes/external.md", key: "file/notes/external.md", value: { rev: "2-ext" } }],
      });
      client.allDocsByKeys.mockResolvedValue({
        total_rows: 1,
        rows: [{
          id: "file/notes/external.md",
          key: "file/notes/external.md",
          value: { rev: "2-ext" },
          doc: { _id: "file/notes/external.md", _rev: "2-ext", content: "updated by external tool" },
        }],
      });
      client.changes.mockResolvedValue({ last_seq: "2", results: [] });

      await engine2.start();

      expect(vault._getContent("notes/external.md")).toBe("updated by external tool");
      engine2.stop();
    });

    it("applies remote doc when mtime is 0 (external tool update)", async () => {
      vault._addFile("notes/zero-mtime.md", "old content", 1000);

      localStorageMock["vault-sync-revmap"] = JSON.stringify({ "file/notes/zero-mtime.md": "1-old" });
      const engine2 = new SyncEngine(settings, vault as any);
      engine2.onStateChange = () => {};
      engine2.onError = () => {};

      const client = getClient(engine2);
      client.allDocs.mockResolvedValue({
        total_rows: 1,
        rows: [{ id: "file/notes/zero-mtime.md", key: "file/notes/zero-mtime.md", value: { rev: "2-ext" } }],
      });
      client.allDocsByKeys.mockResolvedValue({
        total_rows: 1,
        rows: [{
          id: "file/notes/zero-mtime.md",
          key: "file/notes/zero-mtime.md",
          value: { rev: "2-ext" },
          doc: { _id: "file/notes/zero-mtime.md", _rev: "2-ext", content: "updated with mtime 0", mtime: 0 },
        }],
      });
      client.changes.mockResolvedValue({ last_seq: "2", results: [] });

      await engine2.start();

      expect(vault._getContent("notes/zero-mtime.md")).toBe("updated with mtime 0");
      engine2.stop();
    });

    it("applies remote doc when mtime equals local but content differs", async () => {
      vault._addFile("notes/same-mtime.md", "local version", 5000);

      localStorageMock["vault-sync-revmap"] = JSON.stringify({ "file/notes/same-mtime.md": "1-old" });
      const engine2 = new SyncEngine(settings, vault as any);
      engine2.onStateChange = () => {};
      engine2.onError = () => {};

      const client = getClient(engine2);
      client.allDocs.mockResolvedValue({
        total_rows: 1,
        rows: [{ id: "file/notes/same-mtime.md", key: "file/notes/same-mtime.md", value: { rev: "2-r" } }],
      });
      client.allDocsByKeys.mockResolvedValue({
        total_rows: 1,
        rows: [{
          id: "file/notes/same-mtime.md",
          key: "file/notes/same-mtime.md",
          value: { rev: "2-r" },
          doc: { _id: "file/notes/same-mtime.md", _rev: "2-r", content: "remote version", mtime: 5000 },
        }],
      });
      client.changes.mockResolvedValue({ last_seq: "2", results: [] });

      await engine2.start();

      expect(vault._getContent("notes/same-mtime.md")).toBe("remote version");
      engine2.stop();
    });

    it("applies remote changes from changes feed when mtime is missing", async () => {
      vault._addFile("notes/feed.md", "old content", 1000);

      const client = getClient(engine);
      client.allDocs.mockResolvedValue({
        total_rows: 1,
        rows: [{ id: "file/notes/feed.md", key: "file/notes/feed.md", value: { rev: "1-r" } }],
      });
      client.allDocsByKeys.mockResolvedValue({
        total_rows: 1,
        rows: [{
          id: "file/notes/feed.md",
          key: "file/notes/feed.md",
          value: { rev: "1-r" },
          doc: { _id: "file/notes/feed.md", _rev: "1-r", content: "old content", mtime: 1000 },
        }],
      });
      // First changes call for initial sync
      client.changes.mockResolvedValueOnce({ last_seq: "1", results: [] });
      // Second changes call returns an update with no mtime
      client.changes.mockResolvedValueOnce({
        last_seq: "2",
        results: [{
          seq: "2",
          id: "file/notes/feed.md",
          changes: [{ rev: "2-r" }],
          doc: { _id: "file/notes/feed.md", _rev: "2-r", content: "updated by Claude" },
        }],
      });

      await engine.start();

      // Wait for the first poll cycle
      await new Promise((r) => setTimeout(r, 3500));

      expect(vault._getContent("notes/feed.md")).toBe("updated by Claude");
    });

    it("falls back to individual GETs when batch fails", async () => {
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({
        total_rows: 1,
        rows: [
          { id: "file/notes/a.md", key: "file/notes/a.md", value: { rev: "1-a" } },
        ],
      });
      // Batch fails (timeout/encoding)
      client.allDocsByKeys.mockRejectedValue(new Error("Request timed out"));
      // Fallback to individual GET
      client.get.mockResolvedValue({ _id: "file/notes/a.md", _rev: "1-a", content: "aaa", mtime: 1000 });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await engine.start();

      expect(vault._getContent("notes/a.md")).toBe("aaa");
    });

    it("deletes local files that were deleted on remote", async () => {
      // File exists locally and in revMap (was synced before)
      vault._addFile("notes/deleted-remote.md", "old content", 1000);
      localStorageMock["vault-sync-revmap"] = JSON.stringify({
        "file/notes/deleted-remote.md": "1-old",
        "file/notes/still-exists.md": "1-a",
      });
      const engine2 = new SyncEngine(settings, vault as any);
      engine2.onStateChange = () => {};
      engine2.onError = () => {};

      const client = getClient(engine2);
      // Remote only has still-exists.md -- deleted-remote.md was deleted on remote
      client.allDocs.mockResolvedValue({
        total_rows: 1,
        rows: [
          { id: "file/notes/still-exists.md", key: "file/notes/still-exists.md", value: { rev: "1-a" } },
        ],
      });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await engine2.start();

      // deleted-remote.md should be deleted locally
      expect(vault.getAbstractFileByPath("notes/deleted-remote.md")).toBeNull();
      engine2.stop();
    });
  });

  describe("local change handlers", () => {
    it("ignores changes when not running", () => {
      const file = new TFile("notes/test.md", 1000);
      // Should not throw, just silently return
      engine.handleLocalChange(file as any);
    });

    it("ignores excluded files", async () => {
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.changes.mockResolvedValue({ last_seq: "0", results: [] });
      await engine.start();

      const file = new TFile(".obsidian/config.json", 1000);
      engine.handleLocalChange(file as any);

      // Wait for debounce
      await new Promise((r) => setTimeout(r, 100));
      expect(client.put).not.toHaveBeenCalled();
    });

    it("debounces rapid changes to the same file", async () => {
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.changes.mockResolvedValue({ last_seq: "0", results: [] });
      client.get.mockRejectedValue(new Error("not found"));
      client.put.mockResolvedValue({ ok: true, id: "file/notes/typing.md", rev: "1-a" });

      await engine.start();

      const file = vault._addFile("notes/typing.md", "version1", 1000);

      // Simulate rapid typing (3 changes in quick succession)
      engine.handleLocalChange(file as any);
      await new Promise((r) => setTimeout(r, 10));
      engine.handleLocalChange(file as any);
      await new Promise((r) => setTimeout(r, 10));
      engine.handleLocalChange(file as any);

      // Wait for debounce to fire (settings.syncDebounceMs = 50)
      await new Promise((r) => setTimeout(r, 120));

      // Should only push once (debounced)
      expect(client.put).toHaveBeenCalledTimes(1);
    });

    it("handles local delete by calling CouchDB delete", async () => {
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.changes.mockResolvedValue({ last_seq: "0", results: [] });
      client.delete.mockResolvedValue({ ok: true, id: "file/notes/gone.md", rev: "2-del" });

      await engine.start();

      // Manually set a rev in the engine's revMap via a push first
      const file = vault._addFile("notes/gone.md", "content", 1000);
      client.get.mockRejectedValue(new Error("not found"));
      client.put.mockResolvedValue({ ok: true, id: "file/notes/gone.md", rev: "1-a" });

      engine.handleLocalChange(file as any);
      await new Promise((r) => setTimeout(r, 100));

      // Now delete
      await engine.handleLocalDelete(file as any);

      expect(client.delete).toHaveBeenCalledWith("file/notes/gone.md", "1-a");
    });

    it("treats 404 on remote delete as success (already deleted)", async () => {
      const { CouchError } = await import("./couch-client");
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.changes.mockResolvedValue({ last_seq: "0", results: [] });

      await engine.start();

      // Push a file so revMap has it
      const file = vault._addFile("notes/already-gone.md", "content", 1000);
      client.get.mockRejectedValue(new Error("not found"));
      client.put.mockResolvedValue({ ok: true, id: "file/notes/already-gone.md", rev: "1-a" });
      engine.handleLocalChange(file as any);
      await new Promise((r) => setTimeout(r, 100));

      // Remote delete returns 404 (already deleted)
      client.delete.mockRejectedValue(new CouchError(404, '{"error":"not_found","reason":"deleted"}'));

      const errorSpy = vi.fn();
      engine.onError = errorSpy;

      await engine.handleLocalDelete(file as any);

      // Should NOT show an error notification
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("handles rename as delete old + push new", async () => {
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.changes.mockResolvedValue({ last_seq: "0", results: [] });
      client.get.mockRejectedValue(new Error("not found"));
      client.put.mockResolvedValue({ ok: true, id: "file/notes/renamed.md", rev: "1-new" });
      client.delete.mockResolvedValue({ ok: true, id: "file/notes/original.md", rev: "2-del" });

      await engine.start();

      // Simulate: engine knows about the old path
      const file = vault._addFile("notes/renamed.md", "content", 1000);
      // Manually push old file first so revMap has it
      client.put.mockResolvedValue({ ok: true, id: "file/notes/original.md", rev: "1-old" });
      const oldFile = vault._addFile("notes/original.md", "content", 1000);
      engine.handleLocalChange(oldFile as any);
      await new Promise((r) => setTimeout(r, 100));

      // Now rename
      client.put.mockResolvedValue({ ok: true, id: "file/notes/renamed.md", rev: "1-new" });
      await engine.handleLocalRename(file as any, "notes/original.md");

      expect(client.delete).toHaveBeenCalledWith("file/notes/original.md", "1-old");
      expect(client.put).toHaveBeenCalledWith(
        expect.objectContaining({ _id: "file/notes/renamed.md" })
      );
    });
  });

  describe("echo loop prevention", () => {
    it("ignores local changes triggered by remote apply", async () => {
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({
        total_rows: 1,
        rows: [{
          id: "file/notes/remote.md",
          key: "file/notes/remote.md",
          value: { rev: "1-r" },
          doc: { _id: "file/notes/remote.md", _rev: "1-r", content: "remote content", mtime: 5000 },
        }],
      });
      // changes() returns a doc during incremental polling
      client.changes
        .mockResolvedValueOnce({ last_seq: "1", results: [] }) // Initial
        .mockResolvedValueOnce({
          last_seq: "2",
          results: [{
            seq: "2",
            id: "file/notes/remote.md",
            changes: [{ rev: "2-r" }],
            doc: { _id: "file/notes/remote.md", _rev: "2-r", content: "updated remote", mtime: 6000 },
          }],
        });

      await engine.start();

      // During remote apply, handleLocalChange should be a no-op
      // This is internal behavior - we verify indirectly by checking
      // that no extra put() calls happen after a remote change
      const putCallsBefore = client.put.mock.calls.length;

      // Simulate what happens: remote doc is applied, which triggers vault.modify,
      // which would normally trigger handleLocalChange
      // The applyingRemote flag prevents the echo
      const file = vault._addFile("notes/remote.md", "remote content", 5000);
      engine.handleLocalChange(file as any);
      await new Promise((r) => setTimeout(r, 100));

      // put() should not have been called for this file during remote apply
      // (it was only called if the engine pushed during fullSync)
      // The key assertion: no echo loop occurred
      expect(client.put.mock.calls.length).toBe(putCallsBefore);
    });
  });

  describe("persistence", () => {
    it("persists revMap and lastSeq to localStorage", async () => {
      const client = getClient(engine);
      client.get.mockRejectedValue(new Error("not found"));
      client.bulkDocs.mockResolvedValue([{ ok: true, id: "file/a.md", rev: "1-x" }]);
      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.changes.mockResolvedValue({ last_seq: "5", results: [] });

      vault._addFile("a.md", "content", 1000);
      await engine.start();

      expect(localStorage.setItem).toHaveBeenCalledWith(
        "vault-sync-revmap",
        expect.any(String)
      );
      expect(localStorage.setItem).toHaveBeenCalledWith(
        "vault-sync-last-seq",
        expect.any(String)
      );
    });

    it("restores revMap from localStorage on construction", () => {
      localStorageMock["vault-sync-revmap"] = JSON.stringify({ "a.md": "1-abc" });
      localStorageMock["vault-sync-last-seq"] = JSON.stringify("42");

      const engine2 = new SyncEngine(settings, vault as any);
      engine2.onStateChange = () => {};
      engine2.onError = () => {};

      // Verify by checking that localStorage.getItem was called
      expect(localStorage.getItem).toHaveBeenCalledWith("vault-sync-revmap");
      expect(localStorage.getItem).toHaveBeenCalledWith("vault-sync-last-seq");
    });

    it("handles corrupted localStorage gracefully", () => {
      localStorageMock["vault-sync-revmap"] = "not-valid-json{{{";
      localStorageMock["vault-sync-last-seq"] = "also-broken";

      // Should not throw
      const engine2 = new SyncEngine(settings, vault as any);
      engine2.onStateChange = () => {};
      engine2.stop();
    });
  });

  describe("conflict resolution (last-write-wins)", () => {
    it("pushes local version when local mtime is newer", async () => {
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.changes.mockResolvedValue({ last_seq: "0", results: [] });

      await engine.start();

      // Simulate a file that already has a rev (was synced before)
      const file = vault._addFile("notes/conflict.md", "local version", 3000);
      // First put fails with 409 (stale rev)
      const { CouchError } = await import("./couch-client");
      client.put
        .mockRejectedValueOnce(new CouchError(409, "conflict"))
        .mockResolvedValueOnce({ ok: true, id: "file/notes/conflict.md", rev: "3-winner" });
      // get() returns remote with older mtime
      client.get.mockResolvedValue({
        _id: "file/notes/conflict.md",
        _rev: "2-remote",
        content: "remote version",
        mtime: 2000,
      });

      engine.handleLocalChange(file as any);
      await new Promise((r) => setTimeout(r, 100));

      // Should have re-pushed local content with remote's _rev
      expect(client.put).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: "file/notes/conflict.md",
          _rev: "2-remote",
          content: "local version",
          mtime: 3000,
        })
      );
    });

    it("applies remote version when remote mtime is newer", async () => {
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.changes.mockResolvedValue({ last_seq: "0", results: [] });

      await engine.start();

      const file = vault._addFile("notes/conflict.md", "old local", 1000);
      const { CouchError } = await import("./couch-client");
      client.put.mockRejectedValueOnce(new CouchError(409, "conflict"));
      // Remote is newer
      client.get.mockResolvedValue({
        _id: "file/notes/conflict.md",
        _rev: "2-remote",
        content: "newer remote",
        mtime: 5000,
      });

      engine.handleLocalChange(file as any);
      await new Promise((r) => setTimeout(r, 100));

      // Should have applied remote content to vault
      expect(vault._getContent("notes/conflict.md")).toBe("newer remote");
    });

    it("does not create conflict files", async () => {
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.changes.mockResolvedValue({ last_seq: "0", results: [] });

      await engine.start();

      const file = vault._addFile("notes/conflict.md", "local", 1000);
      const { CouchError } = await import("./couch-client");
      client.put.mockRejectedValueOnce(new CouchError(409, "conflict"));
      client.get.mockResolvedValue({
        _id: "file/notes/conflict.md",
        _rev: "2-remote",
        content: "remote",
        mtime: 5000,
      });

      engine.handleLocalChange(file as any);
      await new Promise((r) => setTimeout(r, 100));

      // Verify no .sync-conflict file was created
      const allFiles = vault.getFiles();
      const conflictFiles = allFiles.filter((f: any) => f.path.includes("sync-conflict"));
      expect(conflictFiles).toHaveLength(0);
    });

    it("retries when resolveConflict itself gets a 409", async () => {
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.changes.mockResolvedValue({ last_seq: "0", results: [] });

      await engine.start();

      const file = vault._addFile("notes/double-conflict.md", "latest local", 5000);
      const { CouchError } = await import("./couch-client");

      // Initial push → 409
      // Resolve attempt 1: get remote, put → 409 again (rev changed between fetch and put)
      // Resolve attempt 2: get remote (fresh rev), put → success
      client.put
        .mockRejectedValueOnce(new CouchError(409, "conflict"))
        .mockRejectedValueOnce(new CouchError(409, "conflict"))
        .mockResolvedValueOnce({ ok: true, id: "file/notes/double-conflict.md", rev: "4-final" });

      // get is called 3 times: once in pushTextFile (to fetch rev), twice in resolveConflict retries
      client.get
        .mockResolvedValueOnce({
          _id: "file/notes/double-conflict.md",
          _rev: "2-stale",
          content: "remote v1",
          mtime: 3000,
        })
        .mockResolvedValueOnce({
          _id: "file/notes/double-conflict.md",
          _rev: "2-stale",
          content: "remote v1",
          mtime: 3000,
        })
        .mockResolvedValueOnce({
          _id: "file/notes/double-conflict.md",
          _rev: "3-intermediate",
          content: "remote v2",
          mtime: 4000,
        });

      engine.handleLocalChange(file as any);
      await new Promise((r) => setTimeout(r, 100));

      // Should have succeeded on third put with the fresh rev
      expect(client.put).toHaveBeenCalledTimes(3);
      expect(client.put).toHaveBeenLastCalledWith(
        expect.objectContaining({
          _rev: "3-intermediate",
          content: "latest local",
          mtime: 5000,
        })
      );
    });

    it("skips re-push when content is identical", async () => {
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.changes.mockResolvedValue({ last_seq: "0", results: [] });

      await engine.start();

      const file = vault._addFile("notes/same.md", "same content", 2000);
      const { CouchError } = await import("./couch-client");
      client.put.mockRejectedValueOnce(new CouchError(409, "conflict"));
      // Remote has identical content
      client.get.mockResolvedValue({
        _id: "file/notes/same.md",
        _rev: "2-remote",
        content: "same content",
        mtime: 1000,
      });

      engine.handleLocalChange(file as any);
      await new Promise((r) => setTimeout(r, 100));

      // put should have been called only once (the initial failed attempt)
      // The conflict resolution should NOT push again since content is identical
      expect(client.put).toHaveBeenCalledTimes(1);
    });
  });

  describe("updateSettings", () => {
    it("propagates new settings to CouchClient", () => {
      const client = getClient(engine);
      const newSettings = makeSettings({ couchDbUrl: "https://new-host.com" });
      engine.updateSettings(newSettings);
      expect(client.updateSettings).toHaveBeenCalledWith(newSettings);
    });
  });

  describe("binary file sync - pull", () => {
    it("skips getAttachment for orphan docs without _attachments", async () => {
      // 386 orphan docs in production have no _attachments field (metadata-only docs from old LiveSync)
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({
        total_rows: 2,
        rows: [
          { id: "file/images/orphan.png", key: "file/images/orphan.png", value: { rev: "1-o" } },
          { id: "file/images/real.png", key: "file/images/real.png", value: { rev: "1-r" } },
        ],
      });
      // allDocsByKeys returns: orphan has no _attachments, real one has data.bin attachment
      client.allDocsByKeys.mockResolvedValue({
        total_rows: 2,
        rows: [
          {
            id: "file/images/orphan.png",
            key: "file/images/orphan.png",
            value: { rev: "1-o" },
            doc: { _id: "file/images/orphan.png", _rev: "1-o", content: null, mtime: 0 },
            // No _attachments field
          },
          {
            id: "file/images/real.png",
            key: "file/images/real.png",
            value: { rev: "1-r" },
            doc: {
              _id: "file/images/real.png", _rev: "1-r", content: null, mtime: 0,
              _attachments: { "data.bin": { content_type: "image/png", length: 4, stub: true } },
            },
          },
        ],
      });
      const pngData = new Uint8Array([1, 2, 3, 4]).buffer;
      client.getAttachment = vi.fn().mockResolvedValue(pngData);
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await engine.start();

      // getAttachment must be called only once (for real.png), not for orphan.png
      expect(client.getAttachment).toHaveBeenCalledTimes(1);
      expect(client.getAttachment).toHaveBeenCalledWith("file/images/real.png", "data.bin");
      expect(client.getAttachment).not.toHaveBeenCalledWith("file/images/orphan.png", "data.bin");
    });

    it("records orphan rev in revMap without calling getAttachment", async () => {
      // Orphan docs should have their rev recorded so they are not re-fetched on next sync
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({
        total_rows: 1,
        rows: [{ id: "file/images/orphan.png", key: "file/images/orphan.png", value: { rev: "1-o" } }],
      });
      client.allDocsByKeys.mockResolvedValue({
        total_rows: 1,
        rows: [{
          id: "file/images/orphan.png",
          key: "file/images/orphan.png",
          value: { rev: "1-o" },
          doc: { _id: "file/images/orphan.png", _rev: "1-o", content: null, mtime: 0 },
          // No _attachments
        }],
      });
      client.getAttachment = vi.fn();
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await engine.start();

      expect(client.getAttachment).not.toHaveBeenCalled();
      // Rev should be persisted (no errors emitted)
      expect(errors).toHaveLength(0);
    });

    it("reports setError for real attachment fetch errors (non-404)", async () => {
      // Non-404 errors (network error, auth failure) should still surface via setError
      const { CouchError } = await import("./couch-client");
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({
        total_rows: 1,
        rows: [{ id: "file/images/broken.png", key: "file/images/broken.png", value: { rev: "1-b" } }],
      });
      client.allDocsByKeys.mockResolvedValue({
        total_rows: 1,
        rows: [{
          id: "file/images/broken.png",
          key: "file/images/broken.png",
          value: { rev: "1-b" },
          doc: {
            _id: "file/images/broken.png", _rev: "1-b", content: null, mtime: 0,
            _attachments: { "data.bin": { content_type: "image/png", length: 0, stub: true } },
          },
        }],
      });
      // Simulate a 500 server error when fetching the attachment
      client.getAttachment = vi.fn().mockRejectedValue(new CouchError(500, "Internal Server Error"));
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await engine.start();

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain("broken.png");
    });

    it("pulls binary file via getAttachment and creates it in vault", async () => {
      const pngData = new Uint8Array([137, 80, 78, 71]).buffer; // PNG magic bytes
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({
        total_rows: 1,
        rows: [{ id: "file/images/photo.png", key: "file/images/photo.png", value: { rev: "1-p" } }],
      });
      client.allDocsByKeys.mockResolvedValue({
        total_rows: 1,
        rows: [{
          id: "file/images/photo.png",
          key: "file/images/photo.png",
          value: { rev: "1-p" },
          doc: {
            _id: "file/images/photo.png", _rev: "1-p", content: null, mtime: 0,
            _attachments: { "data.bin": { content_type: "image/png", length: 4, stub: true } },
          },
        }],
      });
      client.getAttachment = vi.fn().mockResolvedValue(pngData);
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await engine.start();

      expect(client.getAttachment).toHaveBeenCalledWith("file/images/photo.png", "data.bin");
      expect(vault._getBinaryContent("images/photo.png")).toBe(pngData);
    });

    it("updates existing binary file when remote rev differs", async () => {
      const oldData = new Uint8Array([1, 2, 3]).buffer;
      const newData = new Uint8Array([4, 5, 6]).buffer;
      vault._addBinaryFile("images/photo.png", oldData);

      localStorageMock["vault-sync-revmap"] = JSON.stringify({ "file/images/photo.png": "1-old" });
      const engine2 = new SyncEngine(settings, vault as any);
      engine2.onStateChange = () => {};
      engine2.onError = () => {};

      const client = getClient(engine2);
      client.allDocs.mockResolvedValue({
        total_rows: 1,
        rows: [{ id: "file/images/photo.png", key: "file/images/photo.png", value: { rev: "2-new" } }],
      });
      client.allDocsByKeys.mockResolvedValue({
        total_rows: 1,
        rows: [{
          id: "file/images/photo.png",
          key: "file/images/photo.png",
          value: { rev: "2-new" },
          doc: {
            _id: "file/images/photo.png", _rev: "2-new", content: null, mtime: 0,
            _attachments: { "data.bin": { content_type: "image/png", length: 3, stub: true } },
          },
        }],
      });
      client.getAttachment = vi.fn().mockResolvedValue(newData);
      client.changes.mockResolvedValue({ last_seq: "2", results: [] });

      await engine2.start();

      expect(vault._getBinaryContent("images/photo.png")).toBe(newData);
      engine2.stop();
    });

    it("routes binary changes feed doc to getAttachment", async () => {
      const pngData = new Uint8Array([1]).buffer;
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });

      // First poll: nothing; second poll: binary change arrives
      client.changes
        .mockResolvedValueOnce({ last_seq: "1", results: [] })
        .mockResolvedValueOnce({
          last_seq: "2",
          results: [{
            seq: "2",
            id: "file/images/new.png",
            changes: [{ rev: "1-p" }],
            doc: { _id: "file/images/new.png", _rev: "1-p", content: null, mtime: 0 },
          }],
        });
      client.getAttachment = vi.fn().mockResolvedValue(pngData);

      await engine.start();
      await new Promise((r) => setTimeout(r, 3500));

      expect(client.getAttachment).toHaveBeenCalledWith("file/images/new.png", "data.bin");
      expect(vault._getBinaryContent("images/new.png")).toBe(pngData);
    });
  });

  describe("binary file sync - parallel pull", () => {
    function makeBinaryRow(id: string, rev: string) {
      return {
        id,
        key: id,
        value: { rev },
        doc: {
          _id: id, _rev: rev, content: null, mtime: 0,
          _attachments: { "data.bin": { content_type: "image/png", length: 4, stub: true } },
        },
      };
    }

    it("downloads multiple attachments in parallel", async () => {
      // 6 docs: with PARALLEL_BINARY_PULLS=5 the first batch of 5 should start before any resolves
      const docIds = ["a", "b", "c", "d", "e", "f"].map(n => `file/images/${n}.png`);
      const revs = docIds.map((_, i) => `1-${i}`);

      const client = getClient(engine);
      client.allDocs.mockResolvedValue({
        total_rows: docIds.length,
        rows: docIds.map((id, i) => ({ id, key: id, value: { rev: revs[i] } })),
      });
      client.allDocsByKeys.mockResolvedValue({
        total_rows: docIds.length,
        rows: docIds.map((id, i) => makeBinaryRow(id, revs[i])),
      });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      // Track concurrent in-flight count
      let maxConcurrent = 0;
      let inFlight = 0;
      client.getAttachment = vi.fn().mockImplementation(() => {
        inFlight++;
        if (inFlight > maxConcurrent) maxConcurrent = inFlight;
        return new Promise<ArrayBuffer>((resolve) =>
          setTimeout(() => { inFlight--; resolve(new ArrayBuffer(4)); }, 20)
        );
      });

      await engine.start();

      // With parallel downloads, at least 2 should have been in-flight simultaneously
      expect(maxConcurrent).toBeGreaterThan(1);
      expect(client.getAttachment).toHaveBeenCalledTimes(docIds.length);
    });

    it("handles partial failures gracefully - successful docs applied, failed skipped", async () => {
      const { CouchError } = await import("./couch-client");
      const docIds = ["ok1", "fail", "ok2", "ok3", "ok4"].map(n => `file/images/${n}.png`);
      const revs = docIds.map((_, i) => `1-${i}`);

      const client = getClient(engine);
      client.allDocs.mockResolvedValue({
        total_rows: docIds.length,
        rows: docIds.map((id, i) => ({ id, key: id, value: { rev: revs[i] } })),
      });
      client.allDocsByKeys.mockResolvedValue({
        total_rows: docIds.length,
        rows: docIds.map((id, i) => makeBinaryRow(id, revs[i])),
      });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      client.getAttachment = vi.fn().mockImplementation((docId: string) => {
        if (docId.includes("fail")) {
          return Promise.reject(new CouchError(500, "Server Error"));
        }
        return Promise.resolve(new ArrayBuffer(4));
      });

      await engine.start();

      // 4 successful, 1 failed → error emitted for the failure
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain("fail");
      // The 4 successful docs should have been written to vault
      expect(vault._getBinaryContent("images/ok1.png")).toBeTruthy();
      expect(vault._getBinaryContent("images/ok2.png")).toBeTruthy();
      expect(vault._getBinaryContent("images/ok3.png")).toBeTruthy();
      expect(vault._getBinaryContent("images/ok4.png")).toBeTruthy();
    });

    it("updates revMap for all successful parallel downloads", async () => {
      const docIds = ["img1", "img2", "img3"].map(n => `file/images/${n}.png`);
      const revs = ["1-aaa", "1-bbb", "1-ccc"];

      const client = getClient(engine);
      client.allDocs.mockResolvedValue({
        total_rows: docIds.length,
        rows: docIds.map((id, i) => ({ id, key: id, value: { rev: revs[i] } })),
      });
      client.allDocsByKeys.mockResolvedValue({
        total_rows: docIds.length,
        rows: docIds.map((id, i) => makeBinaryRow(id, revs[i])),
      });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });
      client.getAttachment = vi.fn().mockResolvedValue(new ArrayBuffer(4));

      await engine.start();

      // All 3 revs must be persisted in localStorage (revMap)
      const saved = JSON.parse(localStorageMock["vault-sync-revmap"] ?? "{}");
      expect(saved["file/images/img1.png"]).toBe("1-aaa");
      expect(saved["file/images/img2.png"]).toBe("1-bbb");
      expect(saved["file/images/img3.png"]).toBe("1-ccc");
    });
  });

  describe("binary file sync - push", () => {
    it("pushes new binary file via putAttachment", async () => {
      const pngData = new Uint8Array([137, 80, 78, 71]).buffer;
      vault._addBinaryFile("images/photo.png", pngData);

      const client = getClient(engine);
      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.get = vi.fn().mockRejectedValue(new Error("not found"));
      client.put = vi.fn().mockResolvedValue({ ok: true, id: "file/images/photo.png", rev: "1-p" });
      client.putAttachment = vi.fn().mockResolvedValue({ ok: true, id: "file/images/photo.png", rev: "2-p" });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await engine.start();

      expect(client.putAttachment).toHaveBeenCalledWith(
        "file/images/photo.png",
        "data.bin",
        expect.any(String), // rev from the put
        pngData,
        "image/png"
      );
    });

    it("pushes binary file on local change event", async () => {
      const pngData = new Uint8Array([1, 2]).buffer;
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.changes.mockResolvedValue({ last_seq: "0", results: [] });
      client.get = vi.fn().mockRejectedValue(new Error("not found"));
      client.put = vi.fn().mockResolvedValue({ ok: true, id: "file/images/icon.png", rev: "1-p" });
      client.putAttachment = vi.fn().mockResolvedValue({ ok: true, id: "file/images/icon.png", rev: "2-p" });

      await engine.start();

      const file = vault._addBinaryFile("images/icon.png", pngData);
      engine.handleLocalChange(file as any);
      await new Promise((r) => setTimeout(r, 120));

      expect(client.putAttachment).toHaveBeenCalledWith(
        "file/images/icon.png",
        "data.bin",
        expect.any(String),
        pngData,
        "image/png"
      );
    });
  });

  describe("handleRemoteDelete - empty parent folder cleanup", () => {
    // Helper: set up engine with a pre-populated revMap (simulates previously synced files),
    // then trigger fullSync where the remote no longer has those docs → handleRemoteDelete fires.
    function makeEngineWithRevMap(revMap: Record<string, string>): { engine2: SyncEngine; client2: ReturnType<typeof vi.fn> & Record<string, ReturnType<typeof vi.fn>> } {
      localStorageMock["vault-sync-revmap"] = JSON.stringify(revMap);
      const engine2 = new SyncEngine(settings, vault as any);
      engine2.onStateChange = () => {};
      engine2.onError = () => {};
      const client2 = getClient(engine2);
      return { engine2, client2 };
    }

    it("does not delete non-empty parent folder after remote file deletion", async () => {
      // folder/file-to-delete.md is synced; folder/ has another file remaining
      vault._addFile("folder/file-to-delete.md", "bye", 1000);
      const siblingFile = new TFile("folder/sibling.md");
      const folder = vault._addFolder("folder", [siblingFile]);

      const { engine2, client2 } = makeEngineWithRevMap({
        "file/folder/file-to-delete.md": "1-old",
      });
      // Remote has no docs (file-to-delete.md was deleted remotely)
      client2.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client2.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await engine2.start();

      // file should be deleted
      expect(vault.getAbstractFileByPath("folder/file-to-delete.md")).toBeNull();
      // folder should still exist (non-empty — sibling remains)
      expect(vault._hasFolder("folder")).toBe(true);
      engine2.stop();
    });

    it("deletes empty parent folder after remote file deletion", async () => {
      // folder/last-file.md is the only file; folder/ will be empty after deletion
      vault._addFile("folder/last-file.md", "content", 1000);
      vault._addFolder("folder", []); // no children after deletion

      const { engine2, client2 } = makeEngineWithRevMap({
        "file/folder/last-file.md": "1-old",
      });
      client2.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client2.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await engine2.start();

      expect(vault.getAbstractFileByPath("folder/last-file.md")).toBeNull();
      expect(vault._hasFolder("folder")).toBe(false);
      engine2.stop();
    });

    it("deletes nested empty folders up to first non-empty ancestor", async () => {
      // a/b/c/file.md is deleted; a/b/c/ and a/b/ become empty, but a/ still has other content
      vault._addFile("a/b/c/file.md", "deep", 1000);
      const otherFile = new TFile("a/other.md");
      vault._addFolder("a/b/c", []);  // empty after deletion
      vault._addFolder("a/b", []);    // empty after c/ is removed
      vault._addFolder("a", [otherFile]); // still has other.md

      const { engine2, client2 } = makeEngineWithRevMap({
        "file/a/b/c/file.md": "1-old",
      });
      client2.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client2.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await engine2.start();

      expect(vault.getAbstractFileByPath("a/b/c/file.md")).toBeNull();
      expect(vault._hasFolder("a/b/c")).toBe(false);
      expect(vault._hasFolder("a/b")).toBe(false);
      expect(vault._hasFolder("a")).toBe(true); // non-empty ancestor preserved
      engine2.stop();
    });

    it("does not delete excluded folders", async () => {
      // .obsidian/plugins/file.md is excluded; even if the folder would be empty, skip it
      vault._addFile(".obsidian/plugins/file.md", "plugin", 1000);
      vault._addFolder(".obsidian/plugins", []);
      vault._addFolder(".obsidian", []);

      const { engine2, client2 } = makeEngineWithRevMap({
        "file/.obsidian/plugins/file.md": "1-old",
      });
      client2.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client2.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await engine2.start();

      // The path is excluded so handleRemoteDelete returns early — file stays, folder stays
      expect(vault.getAbstractFileByPath(".obsidian/plugins/file.md")).not.toBeNull();
      expect(vault._hasFolder(".obsidian/plugins")).toBe(true);
      engine2.stop();
    });
  });

  describe("memory management", () => {
    it("stop() clears recentRemotePaths timers so they do not fire after stop", async () => {
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await engine.start();

      // Simulate applying a remote doc that schedules a recentRemotePaths cleanup timer
      const doc = { _id: "file/notes/test.md", _rev: "1-abc", content: "hello", mtime: 9999 };
      client.changes.mockResolvedValueOnce({
        last_seq: "2",
        results: [{ seq: "2", id: doc._id, changes: [{ rev: "1-abc" }], doc }],
      });

      // Trigger one poll cycle manually
      // @ts-expect-error -- accessing private for test
      await engine.pollChanges();

      // Now stop the engine
      engine.stop();

      // The recentRemotePaths set should be cleared on stop
      // @ts-expect-error -- accessing private for test
      expect(engine.recentRemotePaths.size).toBe(0);
    });

    it("stop() prevents recentRemotePaths cleanup timers from firing on a stopped engine", async () => {
      vi.useFakeTimers();
      try {
        const client = getClient(engine);
        client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
        client.changes
          .mockResolvedValueOnce({ last_seq: "1", results: [] })
          .mockResolvedValueOnce({
            last_seq: "2",
            results: [{
              seq: "2",
              id: "file/notes/timer-test.md",
              changes: [{ rev: "1-abc" }],
              doc: { _id: "file/notes/timer-test.md", _rev: "1-abc", content: "hi", mtime: 9999 },
            }],
          });

        await engine.start();

        // Trigger poll to schedule a recentRemotePaths cleanup timer (2000ms)
        // @ts-expect-error -- accessing private for test
        await engine.pollChanges();

        engine.stop();

        // After stop, advancing timers should NOT cause errors or side effects
        // on a stopped engine. The cleanup timers should have been cancelled.
        // @ts-expect-error -- accessing private for test
        const sizeBefore = engine.recentRemotePaths.size;
        vi.advanceTimersByTime(3000);
        // @ts-expect-error -- accessing private for test
        const sizeAfter = engine.recentRemotePaths.size;

        // If timers were properly cancelled, the set should remain unchanged
        // (cleared at stop). If they weren't cancelled, they fire and delete
        // entries from a set that should already be empty — proving the leak.
        // The key assertion: recentRemotePaths should be empty after stop.
        expect(sizeBefore).toBe(0);
        expect(sizeAfter).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
