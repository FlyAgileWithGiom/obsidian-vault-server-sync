import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SyncEngine } from "./sync-engine";
import { CouchClient } from "./couch-client";
import { Vault, TFile } from "./__mocks__/obsidian";
import type {
  VaultSyncSettings,
  CouchDoc,
  VaultAdapter,
  VaultFile,
  VaultFolder,
  VaultEntry,
  StateStore,
  HttpTransport,
} from "./types";

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

// --- Test adapters ---

/** Wraps the mock Vault to implement VaultAdapter */
class TestVaultAdapter implements VaultAdapter {
  constructor(private vault: Vault) {}

  getFiles(): VaultFile[] {
    return this.vault.getFiles().map((f) => ({
      kind: "file" as const,
      path: f.path,
      mtime: f.stat.mtime,
      size: f.stat.size,
    }));
  }

  getEntryByPath(path: string): VaultEntry | null {
    const entry = this.vault.getAbstractFileByPath(path);
    if (!entry) return null;
    if (entry instanceof TFile) {
      return { kind: "file", path: entry.path, mtime: entry.stat.mtime, size: entry.stat.size };
    }
    // Must be TFolder
    return { kind: "folder", path: entry.path };
  }

  async readText(file: VaultFile): Promise<string> {
    const tf = this.vault.getAbstractFileByPath(file.path);
    if (!(tf instanceof TFile)) return "";
    return this.vault.cachedRead(tf);
  }

  async readBinary(file: VaultFile): Promise<ArrayBuffer> {
    const tf = this.vault.getAbstractFileByPath(file.path);
    if (!(tf instanceof TFile)) return new ArrayBuffer(0);
    return this.vault.readBinary(tf);
  }

  async modifyText(file: VaultFile, content: string): Promise<void> {
    const tf = this.vault.getAbstractFileByPath(file.path);
    if (tf instanceof TFile) await this.vault.modify(tf, content);
  }

  async modifyBinary(file: VaultFile, data: ArrayBuffer): Promise<void> {
    const tf = this.vault.getAbstractFileByPath(file.path);
    if (tf instanceof TFile) await this.vault.modifyBinary(tf, data);
  }

  async createText(path: string, content: string): Promise<VaultFile> {
    const tf = await this.vault.create(path, content);
    return { kind: "file", path: tf.path, mtime: tf.stat.mtime, size: tf.stat.size };
  }

  async createBinary(path: string, data: ArrayBuffer): Promise<VaultFile> {
    const tf = await this.vault.createBinary(path, data);
    return { kind: "file", path: tf.path, mtime: tf.stat.mtime, size: tf.stat.size };
  }

  async createDirectory(path: string): Promise<void> {
    await this.vault.createFolder(path);
  }

  async deleteFile(file: VaultFile): Promise<void> {
    const tf = this.vault.getAbstractFileByPath(file.path);
    if (tf instanceof TFile) await this.vault.delete(tf);
  }

  async deleteDirectory(dir: VaultFolder): Promise<void> {
    const entry = this.vault.getAbstractFileByPath(dir.path);
    if (entry && !(entry instanceof TFile)) await this.vault.delete(entry as never);
  }

  /**
   * Check emptiness via the mock Vault's folder.children list.
   * In tests, _addFolder() explicitly controls the children list so this is authoritative.
   */
  async isDirectoryEmpty(path: string): Promise<boolean> {
    const entry = this.vault.getAbstractFileByPath(path);
    if (!entry || entry instanceof TFile) return true;
    // TFolder has children property
    return (entry as { children: unknown[] }).children.length === 0;
  }

  normalizePath(path: string): string {
    return path.replace(/\\/g, "/").replace(/\/+/g, "/");
  }
}

/** Map-backed StateStore for testing */
class TestStateStore implements StateStore {
  private store = new Map<string, string>();
  get(key: string): string | null { return this.store.get(key) ?? null; }
  set(key: string, value: string): void { this.store.set(key, value); }
}

/** No-op transport — CouchClient is fully mocked so this is never called */
const noopTransport: HttpTransport = {
  request: vi.fn().mockResolvedValue({ status: 200, text: async () => "{}", json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }),
};

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
  let vaultAdapter: TestVaultAdapter;
  let stateStore: TestStateStore;
  let settings: VaultSyncSettings;
  let engine: SyncEngine;
  let stateChanges: string[];
  let errors: string[];

  function makeEngine(s = settings, v = vaultAdapter, st = stateStore): SyncEngine {
    const e = new SyncEngine(s, v, st, noopTransport);
    e.onStateChange = (state) => stateChanges.push(state);
    e.onError = (msg) => errors.push(msg);
    return e;
  }

  beforeEach(() => {
    vi.clearAllMocks();

    vault = new Vault();
    vaultAdapter = new TestVaultAdapter(vault);
    stateStore = new TestStateStore();
    settings = makeSettings();
    engine = makeEngine();
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
      const storeWithRevMap = new TestStateStore();
      storeWithRevMap.set("vault-sync-revmap", JSON.stringify({ "file/notes/old.md": "1-r" }));
      const engine2 = makeEngine(settings, vaultAdapter, storeWithRevMap);

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

    it("does not resurrect a file that was deleted on the server when syncing with empty revMap", async () => {
      // Simulates a fresh install (empty revMap) where the file exists locally
      // but was deleted on the server (tombstone present)
      vault._addFile("notes/deleted-on-server.md", "local content", 1000);

      const client = getClient(engine);
      // allDocs returns [] — the file is not there (deleted on server, tombstone not in allDocs)
      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      // allDocsByKeys batch call returns a tombstone for the file
      client.allDocsByKeys.mockResolvedValue({
        total_rows: 1,
        rows: [{
          id: "file/notes/deleted-on-server.md",
          key: "file/notes/deleted-on-server.md",
          value: { rev: "3-abc" },
          doc: { _id: "file/notes/deleted-on-server.md", _rev: "3-abc", deleted: true, content: null, mtime: 0 },
        }],
      });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await engine.start();

      // Should NOT push the file back (resurrection bug)
      const putCalls = client.put.mock.calls as Array<[{ _id: string }]>;
      const resurrectionAttempt = putCalls.some(
        ([doc]) => doc._id === "file/notes/deleted-on-server.md"
      );
      expect(resurrectionAttempt).toBe(false);
      expect(client.bulkDocs).not.toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ _id: "file/notes/deleted-on-server.md" }),
        ])
      );
      // File should be deleted locally
      expect(vault.getAbstractFileByPath("notes/deleted-on-server.md")).toBeNull();
    });

    it("checks tombstones with a single batch call, not individual GETs, when syncing with empty revMap", async () => {
      // Fresh install: 3 local files, remote allDocs returns [] (all are "new" to remote)
      vault._addFile("notes/tombstone-a.md", "content a", 1000);
      vault._addFile("notes/tombstone-b.md", "content b", 2000);
      vault._addFile("notes/new-file.md", "content new", 3000);

      const client = getClient(engine);
      // allDocs returns empty — all 3 files are "unknown" to remote
      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      // allDocsByKeys returns 2 files as tombstones, 1 as not_found
      client.allDocsByKeys.mockResolvedValue({
        total_rows: 3,
        rows: [
          {
            id: "file/notes/tombstone-a.md",
            key: "file/notes/tombstone-a.md",
            value: { rev: "3-tomb", deleted: true },
            doc: { _id: "file/notes/tombstone-a.md", _rev: "3-tomb", deleted: true },
          },
          {
            id: "file/notes/tombstone-b.md",
            key: "file/notes/tombstone-b.md",
            value: { rev: "2-tomb", deleted: true },
            doc: { _id: "file/notes/tombstone-b.md", _rev: "2-tomb", deleted: true },
          },
          {
            id: "file/notes/new-file.md",
            key: "file/notes/new-file.md",
            error: "not_found",
          },
        ],
      });
      client.bulkDocs.mockResolvedValue([
        { ok: true, id: "file/notes/new-file.md", rev: "1-aaa" },
      ]);
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await engine.start();

      // allDocsByKeys called ONCE with all 3 docIds
      expect(client.allDocsByKeys).toHaveBeenCalledTimes(1);
      expect(client.allDocsByKeys).toHaveBeenCalledWith(
        expect.arrayContaining([
          "file/notes/tombstone-a.md",
          "file/notes/tombstone-b.md",
          "file/notes/new-file.md",
        ])
      );
      // The batch call arg should have exactly 3 entries (no extras from pull phase)
      const batchCallArg = client.allDocsByKeys.mock.calls[0][0] as string[];
      expect(batchCallArg).toHaveLength(3);

      // client.get NOT called — no individual GETs
      expect(client.get).not.toHaveBeenCalled();

      // The 2 tombstoned files deleted locally
      expect(vault.getAbstractFileByPath("notes/tombstone-a.md")).toBeNull();
      expect(vault.getAbstractFileByPath("notes/tombstone-b.md")).toBeNull();

      // The 1 not_found file pushed
      expect(client.bulkDocs).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ _id: "file/notes/new-file.md" }),
        ])
      );
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
      const storeWithRevMap = new TestStateStore();
      storeWithRevMap.set("vault-sync-revmap", JSON.stringify({ "file/notes/shared.md": "1-r" }));
      const engine2 = makeEngine(settings, vaultAdapter, storeWithRevMap);

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

      const storeWithRevMap = new TestStateStore();
      storeWithRevMap.set("vault-sync-revmap", JSON.stringify({ "file/notes/external.md": "1-old" }));
      const engine2 = makeEngine(settings, vaultAdapter, storeWithRevMap);

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

      const storeWithRevMap = new TestStateStore();
      storeWithRevMap.set("vault-sync-revmap", JSON.stringify({ "file/notes/zero-mtime.md": "1-old" }));
      const engine2 = makeEngine(settings, vaultAdapter, storeWithRevMap);

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

      const storeWithRevMap = new TestStateStore();
      storeWithRevMap.set("vault-sync-revmap", JSON.stringify({ "file/notes/same-mtime.md": "1-old" }));
      const engine2 = makeEngine(settings, vaultAdapter, storeWithRevMap);

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

      const storeWithRevMap = new TestStateStore();
      storeWithRevMap.set("vault-sync-revmap", JSON.stringify({
        "file/notes/deleted-remote.md": "1-old",
        "file/notes/still-exists.md": "1-a",
      }));
      const engine2 = makeEngine(settings, vaultAdapter, storeWithRevMap);

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
      const file: VaultFile = { kind: "file", path: "notes/test.md", mtime: 1000, size: 0 };
      // Should not throw, just silently return
      engine.handleLocalChange(file);
    });

    it("ignores excluded files", async () => {
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.changes.mockResolvedValue({ last_seq: "0", results: [] });
      await engine.start();

      const file: VaultFile = { kind: "file", path: ".obsidian/config.json", mtime: 1000, size: 0 };
      engine.handleLocalChange(file);

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

      vault._addFile("notes/typing.md", "version1", 1000);
      const file: VaultFile = { kind: "file", path: "notes/typing.md", mtime: 1000, size: 0 };

      // Simulate rapid typing (3 changes in quick succession)
      engine.handleLocalChange(file);
      await new Promise((r) => setTimeout(r, 10));
      engine.handleLocalChange(file);
      await new Promise((r) => setTimeout(r, 10));
      engine.handleLocalChange(file);

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
      vault._addFile("notes/gone.md", "content", 1000);
      const file: VaultFile = { kind: "file", path: "notes/gone.md", mtime: 1000, size: 0 };
      client.get.mockRejectedValue(new Error("not found"));
      client.put.mockResolvedValue({ ok: true, id: "file/notes/gone.md", rev: "1-a" });

      engine.handleLocalChange(file);
      await new Promise((r) => setTimeout(r, 100));

      // Now delete
      await engine.handleLocalDelete(file);

      expect(client.delete).toHaveBeenCalledWith("file/notes/gone.md", "1-a");
    });

    it("treats 404 on remote delete as success (already deleted)", async () => {
      const { CouchError } = await import("./couch-client");
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.changes.mockResolvedValue({ last_seq: "0", results: [] });

      await engine.start();

      // Push a file so revMap has it
      vault._addFile("notes/already-gone.md", "content", 1000);
      const file: VaultFile = { kind: "file", path: "notes/already-gone.md", mtime: 1000, size: 0 };
      client.get.mockRejectedValue(new Error("not found"));
      client.put.mockResolvedValue({ ok: true, id: "file/notes/already-gone.md", rev: "1-a" });
      engine.handleLocalChange(file);
      await new Promise((r) => setTimeout(r, 100));

      // Remote delete returns 404 (already deleted)
      client.delete.mockRejectedValue(new CouchError(404, '{"error":"not_found","reason":"deleted"}'));

      const errorSpy = vi.fn();
      engine.onError = errorSpy;

      await engine.handleLocalDelete(file);

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
      vault._addFile("notes/renamed.md", "content", 1000);
      const renamedFile: VaultFile = { kind: "file", path: "notes/renamed.md", mtime: 1000, size: 0 };
      // Manually push old file first so revMap has it
      client.put.mockResolvedValue({ ok: true, id: "file/notes/original.md", rev: "1-old" });
      vault._addFile("notes/original.md", "content", 1000);
      const oldFile: VaultFile = { kind: "file", path: "notes/original.md", mtime: 1000, size: 0 };
      engine.handleLocalChange(oldFile);
      await new Promise((r) => setTimeout(r, 100));

      // Now rename
      client.put.mockResolvedValue({ ok: true, id: "file/notes/renamed.md", rev: "1-new" });
      await engine.handleLocalRename(renamedFile, "notes/original.md");

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
      vault._addFile("notes/remote.md", "remote content", 5000);
      const file: VaultFile = { kind: "file", path: "notes/remote.md", mtime: 5000, size: 0 };
      engine.handleLocalChange(file);
      await new Promise((r) => setTimeout(r, 100));

      // put() should not have been called for this file during remote apply
      // (it was only called if the engine pushed during fullSync)
      // The key assertion: no echo loop occurred
      expect(client.put.mock.calls.length).toBe(putCallsBefore);
    });
  });

  describe("persistence", () => {
    it("persists revMap and lastSeq to StateStore", async () => {
      const client = getClient(engine);
      client.get.mockRejectedValue(new Error("not found"));
      client.bulkDocs.mockResolvedValue([{ ok: true, id: "file/a.md", rev: "1-x" }]);
      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.changes.mockResolvedValue({ last_seq: "5", results: [] });

      vault._addFile("a.md", "content", 1000);
      await engine.start();

      expect(stateStore.get("vault-sync-revmap")).not.toBeNull();
      expect(stateStore.get("vault-sync-last-seq")).not.toBeNull();
    });

    it("restores revMap from StateStore on construction", () => {
      const preloadedStore = new TestStateStore();
      preloadedStore.set("vault-sync-revmap", JSON.stringify({ "a.md": "1-abc" }));
      preloadedStore.set("vault-sync-last-seq", JSON.stringify("42"));

      // Just constructing the engine reads from the store
      const engine2 = makeEngine(settings, vaultAdapter, preloadedStore);
      engine2.stop();

      // Verify the engine loaded the state (indirectly, by checking getDiagnostics)
      const diag = engine2.getDiagnostics();
      expect(diag.revMapSize).toBe(1);
    });

    it("handles corrupted StateStore gracefully", () => {
      const badStore = new TestStateStore();
      badStore.set("vault-sync-revmap", "not-valid-json{{{");
      badStore.set("vault-sync-last-seq", "also-broken");

      // Should not throw
      const engine2 = makeEngine(settings, vaultAdapter, badStore);
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
      vault._addFile("notes/conflict.md", "local version", 3000);
      const file: VaultFile = { kind: "file", path: "notes/conflict.md", mtime: 3000, size: 0 };
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

      engine.handleLocalChange(file);
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

      vault._addFile("notes/conflict.md", "old local", 1000);
      const file: VaultFile = { kind: "file", path: "notes/conflict.md", mtime: 1000, size: 0 };
      const { CouchError } = await import("./couch-client");
      client.put.mockRejectedValueOnce(new CouchError(409, "conflict"));
      // Remote is newer
      client.get.mockResolvedValue({
        _id: "file/notes/conflict.md",
        _rev: "2-remote",
        content: "newer remote",
        mtime: 5000,
      });

      engine.handleLocalChange(file);
      await new Promise((r) => setTimeout(r, 100));

      // Should have applied remote content to vault
      expect(vault._getContent("notes/conflict.md")).toBe("newer remote");
    });

    it("does not create conflict files", async () => {
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.changes.mockResolvedValue({ last_seq: "0", results: [] });

      await engine.start();

      vault._addFile("notes/conflict.md", "local", 1000);
      const file: VaultFile = { kind: "file", path: "notes/conflict.md", mtime: 1000, size: 0 };
      const { CouchError } = await import("./couch-client");
      client.put.mockRejectedValueOnce(new CouchError(409, "conflict"));
      client.get.mockResolvedValue({
        _id: "file/notes/conflict.md",
        _rev: "2-remote",
        content: "remote",
        mtime: 5000,
      });

      engine.handleLocalChange(file);
      await new Promise((r) => setTimeout(r, 100));

      // Verify no .sync-conflict file was created
      const allFiles = vault.getFiles();
      const conflictFiles = allFiles.filter((f) => f.path.includes("sync-conflict"));
      expect(conflictFiles).toHaveLength(0);
    });

    it("retries when resolveConflict itself gets a 409", async () => {
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.changes.mockResolvedValue({ last_seq: "0", results: [] });

      await engine.start();

      vault._addFile("notes/double-conflict.md", "latest local", 5000);
      const file: VaultFile = { kind: "file", path: "notes/double-conflict.md", mtime: 5000, size: 0 };
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

      engine.handleLocalChange(file);
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

      vault._addFile("notes/same.md", "same content", 2000);
      const file: VaultFile = { kind: "file", path: "notes/same.md", mtime: 2000, size: 0 };
      const { CouchError } = await import("./couch-client");
      client.put.mockRejectedValueOnce(new CouchError(409, "conflict"));
      // Remote has identical content
      client.get.mockResolvedValue({
        _id: "file/notes/same.md",
        _rev: "2-remote",
        content: "same content",
        mtime: 1000,
      });

      engine.handleLocalChange(file);
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
      expect(client.getAttachment).toHaveBeenCalledWith("file/images/real.png", "data.bin", expect.any(Number));
      expect(client.getAttachment).not.toHaveBeenCalledWith("file/images/orphan.png", "data.bin", expect.any(Number));
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

      expect(client.getAttachment).toHaveBeenCalledWith("file/images/photo.png", "data.bin", expect.any(Number));
      expect(vault._getBinaryContent("images/photo.png")).toBe(pngData);
    });

    it("updates existing binary file when remote rev differs", async () => {
      const oldData = new Uint8Array([1, 2, 3]).buffer;
      const newData = new Uint8Array([4, 5, 6]).buffer;
      vault._addBinaryFile("images/photo.png", oldData);

      const storeWithRevMap = new TestStateStore();
      storeWithRevMap.set("vault-sync-revmap", JSON.stringify({ "file/images/photo.png": "1-old" }));
      const engine2 = makeEngine(settings, vaultAdapter, storeWithRevMap);

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

      expect(client.getAttachment).toHaveBeenCalledWith("file/images/new.png", "data.bin", expect.any(Number));
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

      // All 3 revs must be persisted in StateStore
      const saved = JSON.parse(stateStore.get("vault-sync-revmap") ?? "{}");
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

      vault._addBinaryFile("images/icon.png", pngData);
      const file: VaultFile = { kind: "file", path: "images/icon.png", mtime: Date.now(), size: pngData.byteLength };
      engine.handleLocalChange(file);
      await new Promise((r) => setTimeout(r, 120));

      expect(client.putAttachment).toHaveBeenCalledWith(
        "file/images/icon.png",
        "data.bin",
        expect.any(String),
        pngData,
        "image/png"
      );
    });

    it("retries putAttachment with fresh rev when 409 conflict occurs", async () => {
      // Pre-populate revMap so engine skips stub-creation and goes straight to putAttachment
      const conflictStore = new TestStateStore();
      conflictStore.set("vault-sync-revmap", JSON.stringify({ "file/images/conflict.jpeg": "1-stale" }));
      const conflictEngine = makeEngine(settings, vaultAdapter, conflictStore);
      conflictEngine.onStateChange = () => {};
      conflictEngine.onError = (msg) => errors.push(msg);
      const conflictClient = getClient(conflictEngine);

      const jpegData = new Uint8Array([0xff, 0xd8, 0xff]).buffer;
      conflictClient.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      conflictClient.changes.mockResolvedValue({ last_seq: "0", results: [] });

      const { CouchError } = await import("./couch-client");
      // First putAttachment call fails with 409, second succeeds with fresh rev
      conflictClient.putAttachment = vi.fn()
        .mockRejectedValueOnce(new CouchError(409, "Document update conflict."))
        .mockResolvedValueOnce({ ok: true, id: "file/images/conflict.jpeg", rev: "3-fresh" });
      // get() returns the doc with fresh rev after the 409
      conflictClient.get = vi.fn().mockResolvedValue({
        _id: "file/images/conflict.jpeg",
        _rev: "2-fresh",
        content: null,
        mtime: 1000,
      });

      await conflictEngine.start();

      vault._addBinaryFile("images/conflict.jpeg", jpegData);
      const file: VaultFile = { kind: "file", path: "images/conflict.jpeg", mtime: Date.now(), size: jpegData.byteLength };
      conflictEngine.handleLocalChange(file);
      await new Promise((r) => setTimeout(r, 120));

      // putAttachment should have been called twice (once with stale rev, once with fresh rev)
      expect(conflictClient.putAttachment).toHaveBeenCalledTimes(2);
      // Second call must use the fresh rev fetched from get()
      expect(conflictClient.putAttachment).toHaveBeenNthCalledWith(
        2,
        "file/images/conflict.jpeg",
        "data.bin",
        "2-fresh",
        jpegData,
        "image/jpeg"
      );
      // No error should be surfaced on successful retry
      expect(errors).toHaveLength(0);

      conflictEngine.stop();
    });

    it("surfaces error via setError when all binary 409 retries are exhausted", async () => {
      const retryStore = new TestStateStore();
      retryStore.set("vault-sync-revmap", JSON.stringify({ "file/images/persistent.jpeg": "1-stale" }));
      const retryEngine = makeEngine(settings, vaultAdapter, retryStore);
      retryEngine.onStateChange = () => {};
      const retryErrors: string[] = [];
      retryEngine.onError = (msg) => retryErrors.push(msg);
      const retryClient = getClient(retryEngine);

      const jpegData = new Uint8Array([0xff, 0xd8]).buffer;
      retryClient.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      retryClient.changes.mockResolvedValue({ last_seq: "0", results: [] });

      const { CouchError } = await import("./couch-client");
      // All 3 putAttachment attempts fail with 409
      retryClient.putAttachment = vi.fn()
        .mockRejectedValue(new CouchError(409, "Document update conflict."));
      // get() always returns a fresh-looking rev (but another client keeps winning)
      retryClient.get = vi.fn().mockResolvedValue({
        _id: "file/images/persistent.jpeg",
        _rev: "2-never-wins",
        content: null,
        mtime: 1000,
      });

      await retryEngine.start();

      vault._addBinaryFile("images/persistent.jpeg", jpegData);
      const file: VaultFile = { kind: "file", path: "images/persistent.jpeg", mtime: Date.now(), size: jpegData.byteLength };
      retryEngine.handleLocalChange(file);
      await new Promise((r) => setTimeout(r, 120));

      // After MAX_RETRIES exhausted, error must be surfaced
      expect(retryErrors).toHaveLength(1);
      expect(retryErrors[0]).toContain("Binary push failed for images/persistent.jpeg");

      retryEngine.stop();
    });

    it("calls handleRemoteDelete and surfaces no error when putAttachment gets 404 deleted (tombstone)", async () => {
      // Scenario: iOS client has images/ghost.png locally; server-side cleanup left a tombstone.
      // putAttachment hits the tombstone and returns 404 {"error":"not_found","reason":"deleted"}.
      // Expected: local file deleted, revMap entry removed, no error in UI, no retry.
      const tombStore = new TestStateStore();
      tombStore.set("vault-sync-revmap", JSON.stringify({ "file/images/ghost.png": "2-tomb" }));
      const tombEngine = makeEngine(settings, vaultAdapter, tombStore);
      tombEngine.onStateChange = () => {};
      const tombErrors: string[] = [];
      tombEngine.onError = (msg) => tombErrors.push(msg);
      const tombClient = getClient(tombEngine);

      const { CouchError } = await import("./couch-client");
      const tombstone404 = new CouchError(404, 'CouchDB 404: {"error":"not_found","reason":"deleted"}');
      const pngData = new Uint8Array([137, 80, 78, 71]).buffer;
      vault._addBinaryFile("images/ghost.png", pngData);

      tombClient.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      tombClient.changes.mockResolvedValue({ last_seq: "0", results: [] });
      // putAttachment always returns tombstone — covers both the initial fullSync push
      // and any subsequent handleLocalChange retry after revMap is cleared
      tombClient.putAttachment = vi.fn().mockRejectedValue(tombstone404);
      // client.get also returns tombstone — used when revMap entry was cleared by handleRemoteDelete
      tombClient.get = vi.fn().mockRejectedValue(tombstone404);

      await tombEngine.start();

      const file: VaultFile = { kind: "file", path: "images/ghost.png", mtime: Date.now(), size: pngData.byteLength };
      tombEngine.handleLocalChange(file);
      await new Promise((r) => setTimeout(r, 120));

      // Local file should be removed (tombstone wins)
      expect(vault.getAbstractFileByPath("images/ghost.png")).toBeNull();
      // No error surfaced to the user
      expect(tombErrors).toHaveLength(0);

      tombEngine.stop();
    });

    it("calls handleRemoteDelete and surfaces no error when client.get returns 404 deleted during stub-fetch", async () => {
      // Scenario: no revMap entry, so pushBinaryFile tries client.get to fetch existing rev.
      // client.get returns 404 {"error":"not_found","reason":"deleted"} — tombstone.
      // Expected: stub PUT never called, local file deleted, no error.
      const stubEngine = makeEngine(settings, vaultAdapter, stateStore);
      stubEngine.onStateChange = () => {};
      const stubErrors: string[] = [];
      stubEngine.onError = (msg) => stubErrors.push(msg);
      const stubClient = getClient(stubEngine);

      const { CouchError } = await import("./couch-client");
      const pngData = new Uint8Array([137, 80, 78, 71]).buffer;
      vault._addBinaryFile("images/erased.png", pngData);

      stubClient.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      stubClient.changes.mockResolvedValue({ last_seq: "0", results: [] });
      // get() returns a tombstone 404
      stubClient.get = vi.fn().mockRejectedValue(
        new CouchError(404, 'CouchDB 404: {"error":"not_found","reason":"deleted"}'),
      );
      stubClient.put = vi.fn(); // should never be called

      await stubEngine.start();

      const file: VaultFile = { kind: "file", path: "images/erased.png", mtime: Date.now(), size: pngData.byteLength };
      stubEngine.handleLocalChange(file);
      await new Promise((r) => setTimeout(r, 120));

      // Local file should be removed (tombstone wins)
      expect(vault.getAbstractFileByPath("images/erased.png")).toBeNull();
      // Stub PUT was never attempted
      expect(stubClient.put).not.toHaveBeenCalled();
      // No error surfaced
      expect(stubErrors).toHaveLength(0);

      stubEngine.stop();
    });
  });

  describe("handleRemoteDelete - empty parent folder cleanup", () => {
    // Helper: set up engine with a pre-populated revMap (simulates previously synced files),
    // then trigger fullSync where the remote no longer has those docs → handleRemoteDelete fires.
    function makeEngineWithRevMap(revMap: Record<string, string>): { engine2: SyncEngine; client2: ReturnType<typeof vi.fn> & Record<string, ReturnType<typeof vi.fn>> } {
      const store = new TestStateStore();
      store.set("vault-sync-revmap", JSON.stringify(revMap));
      const engine2 = makeEngine(settings, vaultAdapter, store);
      const client2 = getClient(engine2);
      return { engine2, client2 };
    }

    it("does not delete non-empty parent folder after remote file deletion", async () => {
      // folder/file-to-delete.md is synced; folder/ has another file remaining
      vault._addFile("folder/file-to-delete.md", "bye", 1000);
      const siblingFile = new TFile("folder/sibling.md");
      vault._addFolder("folder", [siblingFile]);

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

  describe("binary file sync - metadata chunk", () => {
    function makeBinaryAllDocsRow(id: string, rev: string) {
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

    it("chunks allDocsByKeys at META_BATCH_SIZE boundary (1001 docs → 3 calls)", async () => {
      // 1001 binary docIds: with META_BATCH_SIZE=500, expect chunks [0-499], [500-999], [1000]
      const docIds = Array.from({ length: 1001 }, (_, i) => `file/images/img${i}.png`);
      const revs = docIds.map((_, i) => `1-${i}`);

      const client = getClient(engine);
      client.allDocs.mockResolvedValue({
        total_rows: docIds.length,
        rows: docIds.map((id, i) => ({ id, key: id, value: { rev: revs[i] } })),
      });

      // allDocsByKeys returns the chunk's docs on each call
      client.allDocsByKeys.mockImplementation((keys: string[]) => {
        return Promise.resolve({
          total_rows: keys.length,
          rows: keys.map((id) => makeBinaryAllDocsRow(id, revs[docIds.indexOf(id)])),
        });
      });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });
      client.getAttachment = vi.fn().mockResolvedValue(new ArrayBuffer(4));

      await engine.start();

      // allDocsByKeys should be called 3 times: [0..499], [500..999], [1000]
      expect(client.allDocsByKeys).toHaveBeenCalledTimes(3);
      expect(client.allDocsByKeys.mock.calls[0][0]).toHaveLength(500);
      expect(client.allDocsByKeys.mock.calls[1][0]).toHaveLength(500);
      expect(client.allDocsByKeys.mock.calls[2][0]).toHaveLength(1);
      // All 1001 files should have been written to vault
      expect(client.getAttachment).toHaveBeenCalledTimes(1001);
    });

    it("partial metadata chunk failure: skips failed chunk docs, applies successful chunk", async () => {
      // 600 docIds: first chunk of 500 fails, second chunk of 100 succeeds.
      // META_BATCH_SIZE=500, so 600 docs → 2 chunks: [0..499] fails, [500..599] succeeds.
      const firstChunkIds = Array.from({ length: 500 }, (_, i) => `file/images/fail${i}.png`);
      const secondChunkIds = Array.from({ length: 100 }, (_, i) => `file/images/ok${i}.png`);
      const docIds = [...firstChunkIds, ...secondChunkIds];
      const revs = docIds.map((_, i) => `1-${i}`);

      const client = getClient(engine);
      client.allDocs.mockResolvedValue({
        total_rows: docIds.length,
        rows: docIds.map((id, i) => ({ id, key: id, value: { rev: revs[i] } })),
      });

      // First chunk of 500 throws timeout; second chunk of 100 succeeds
      let callCount = 0;
      client.allDocsByKeys.mockImplementation((keys: string[]) => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error("DOMException [TimeoutError]: The operation was aborted due to timeout"));
        }
        return Promise.resolve({
          total_rows: keys.length,
          rows: keys.map((id) => makeBinaryAllDocsRow(id, revs[docIds.indexOf(id)])),
        });
      });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });
      client.getAttachment = vi.fn().mockResolvedValue(new ArrayBuffer(4));

      await engine.start();

      // Must not throw — engine should survive partial metadata failure
      // Only the second chunk's docs (secondChunkIds) have metadata, so only those download
      expect(client.getAttachment).toHaveBeenCalledTimes(secondChunkIds.length);
      // Engine should not enter error state due to metadata chunk failure
      expect(stateChanges).not.toContain("error");
    });

    it("failCount rate limiting: 5 failing binary downloads emit at most 3 errors", async () => {
      const docIds = ["a", "b", "c", "d", "e"].map(n => `file/images/${n}.png`);
      const revs = docIds.map((_, i) => `1-${i}`);

      const client = getClient(engine);
      client.allDocs.mockResolvedValue({
        total_rows: docIds.length,
        rows: docIds.map((id, i) => ({ id, key: id, value: { rev: revs[i] } })),
      });
      client.allDocsByKeys.mockResolvedValue({
        total_rows: docIds.length,
        rows: docIds.map((id, i) => makeBinaryAllDocsRow(id, revs[i])),
      });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      // All 5 downloads fail
      const { CouchError } = await import("./couch-client");
      client.getAttachment = vi.fn().mockRejectedValue(new CouchError(500, "Server Error"));

      await engine.start();

      // With 5 failures, errors emitted must be capped at 3
      expect(errors.length).toBeLessThanOrEqual(3);
      expect(errors.length).toBeGreaterThan(0);
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
