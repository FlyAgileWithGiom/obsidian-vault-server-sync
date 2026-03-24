import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SyncEngine } from "./sync-engine";
import { CouchClient } from "./couch-client";
import { Vault, TFile } from "./__mocks__/obsidian";
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
      bulkDocs: vi.fn().mockResolvedValue([]),
      changes: vi.fn().mockResolvedValue({ last_seq: "0", results: [] }),
      cancelChanges: vi.fn(),
      updateSettings: vi.fn(),
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

    it("skips push when remote has newer mtime", async () => {
      vault._addFile("notes/old.md", "local content", 1000);

      const client = getClient(engine);
      // Remote doc is newer
      client.get.mockResolvedValue({ _id: "file/notes/old.md", _rev: "1-r", content: "remote", mtime: 2000 });
      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await engine.start();

      // bulkDocs should not be called (nothing to push)
      expect(client.bulkDocs).not.toHaveBeenCalled();
    });

    it("includes _rev when updating existing remote doc", async () => {
      vault._addFile("notes/newer.md", "updated", 3000);

      const client = getClient(engine);
      client.get.mockResolvedValue({ _id: "file/notes/newer.md", _rev: "1-old", content: "old", mtime: 1000 });
      client.bulkDocs.mockResolvedValue([{ ok: true, id: "file/notes/newer.md", rev: "2-new" }]);
      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await engine.start();

      expect(client.bulkDocs).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ _id: "file/notes/newer.md", _rev: "1-old" }),
        ])
      );
    });
  });

  describe("fullSync - pull", () => {
    it("creates local files from remote docs", async () => {
      const client = getClient(engine);
      client.get.mockRejectedValue(new Error("not found")); // No local files to push
      client.allDocs.mockResolvedValue({
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

      const client = getClient(engine);
      client.get.mockResolvedValue({ _id: "file/notes/shared.md", _rev: "1-r", content: "old remote", mtime: 2000 });
      // Remote is even newer during pull
      client.allDocs.mockResolvedValue({
        total_rows: 1,
        rows: [{
          id: "file/notes/shared.md",
          key: "file/notes/shared.md",
          value: { rev: "2-r" },
          doc: { _id: "file/notes/shared.md", _rev: "2-r", content: "newer remote", mtime: 5000 },
        }],
      });
      client.changes.mockResolvedValue({ last_seq: "2", results: [] });

      await engine.start();

      expect(vault._getContent("notes/shared.md")).toBe("newer remote");
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
});
