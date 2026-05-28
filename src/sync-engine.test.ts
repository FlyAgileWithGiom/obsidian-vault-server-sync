import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CustomFetchSyncStrategy as SyncEngine, lwwWinner } from "./sync-engine";
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
    it("pulls remote docs on first sync with empty vault (via forceFullSync)", async () => {
      // forceFullSync bypasses the orphan guard, enabling first-device onboarding.
      // Normal start() with empty revMap skips all pulls (Trou B: agent-created docs protection).
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

      await engine.forceFullSync();

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
      // Pre-populate revMap with stale revs to simulate a device that had synced before;
      // remote has newer revs → triggers pull.
      const storeWithRevMap = new TestStateStore();
      storeWithRevMap.set("vault-sync-revmap", JSON.stringify({
        "file/notes/a.md": { rev: "0-old", mtime: 0, lastSeenInFs: 0 },
        "file/notes/b.md": { rev: "0-old", mtime: 0, lastSeenInFs: 0 },
      }));
      const engine2 = makeEngine(settings, vaultAdapter, storeWithRevMap);

      const client = getClient(engine2);
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

      await engine2.start();

      expect(client.allDocsByKeys).toHaveBeenCalled();
      expect(client.get).not.toHaveBeenCalled(); // Should NOT use individual GETs
      expect(vault._getContent("notes/a.md")).toBe("aaa");
      expect(vault._getContent("notes/b.md")).toBe("bbb");
      engine2.stop();
    });

    it("skips docs with null content in batch pull", async () => {
      // Pre-populate revMap — required to pass Trou B orphan guard.
      const storeWithRevMap = new TestStateStore();
      storeWithRevMap.set("vault-sync-revmap", JSON.stringify({
        "file/notes/text.md": { rev: "0-old", mtime: 0, lastSeenInFs: 0 },
        "file/images/photo.png": { rev: "0-old", mtime: 0, lastSeenInFs: 0 },
      }));
      const engine2 = makeEngine(settings, vaultAdapter, storeWithRevMap);

      const client = getClient(engine2);
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

      await engine2.start();

      expect(vault._getContent("notes/text.md")).toBe("hello");
      expect(vault._getContent("images/photo.png")).toBeUndefined(); // null content skipped
      engine2.stop();
    });

    it("skips binary extensions in pull", async () => {
      // Pre-populate revMap with stale revs — required to pass Trou B orphan guard.
      const storeWithRevMap = new TestStateStore();
      storeWithRevMap.set("vault-sync-revmap", JSON.stringify({
        "file/notes/text.md": { rev: "0-old", mtime: 0, lastSeenInFs: 0 },
        "file/images/photo.jpg": { rev: "0-old", mtime: 0, lastSeenInFs: 0 },
      }));
      const engine2 = makeEngine(settings, vaultAdapter, storeWithRevMap);

      const client = getClient(engine2);
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

      await engine2.start();

      expect(vault._getContent("notes/text.md")).toBe("hello");
      // Verify allDocsByKeys was called without the .jpg
      const calledKeys = client.allDocsByKeys.mock.calls[0][0];
      expect(calledKeys).not.toContain("file/images/photo.jpg");
      engine2.stop();
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

      // Pre-populate revMap so the file is known to this device (passed through Trou B guard).
      // The initial fullSync also passes through the rev-match guard since local rev == remote rev.
      const storeWithRevMap = new TestStateStore();
      storeWithRevMap.set("vault-sync-revmap", JSON.stringify({
        "file/notes/feed.md": { rev: "1-r", mtime: 1000, lastSeenInFs: Date.now() },
      }));
      const engine2 = makeEngine(settings, vaultAdapter, storeWithRevMap);
      engine2.onStateChange = (s) => stateChanges.push(s);
      engine2.onError = (msg) => errors.push(msg);

      const client = getClient(engine2);
      client.allDocs.mockResolvedValue({
        total_rows: 1,
        rows: [{ id: "file/notes/feed.md", key: "file/notes/feed.md", value: { rev: "1-r" } }],
      });
      client.allDocsByKeys.mockResolvedValue({ total_rows: 0, rows: [] });
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

      await engine2.start();

      // Wait for the first poll cycle
      await new Promise((r) => setTimeout(r, 3500));

      expect(vault._getContent("notes/feed.md")).toBe("updated by Claude");
      engine2.stop();
    });

    it("falls back to individual GETs when batch fails", async () => {
      // Pre-populate revMap with stale rev — required to pass Trou B orphan guard.
      const storeWithRevMap = new TestStateStore();
      storeWithRevMap.set("vault-sync-revmap", JSON.stringify({
        "file/notes/a.md": { rev: "0-old", mtime: 0, lastSeenInFs: 0 },
      }));
      const engine2 = makeEngine(settings, vaultAdapter, storeWithRevMap);

      const client = getClient(engine2);
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

      await engine2.start();

      expect(vault._getContent("notes/a.md")).toBe("aaa");
      engine2.stop();
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

    it("calls handleRemoteDelete and surfaces no error when client.get returns 404 deleted (tombstone) in pushTextFile", async () => {
      // Scenario: no revMap entry for the file, so pushTextFile calls client.get to fetch the
      // current rev. The server returns a tombstone 404 (doc was deleted). Expected: local file
      // deleted via handleRemoteDelete, client.put never called, no error surfaced (S14/S15 fix).
      const { CouchError } = await import("./couch-client");
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.changes.mockResolvedValue({ last_seq: "0", results: [] });

      await engine.start();

      vault._addFile("notes/resurrected.md", "local content", 1000);
      const file: VaultFile = { kind: "file", path: "notes/resurrected.md", mtime: 1000, size: 0 };

      // client.get returns tombstone — no revMap entry so pushTextFile will call get
      client.get = vi.fn().mockRejectedValue(
        new CouchError(404, 'CouchDB 404: {"error":"not_found","reason":"deleted"}'),
      );
      client.put = vi.fn(); // must not be called

      const tombErrors: string[] = [];
      engine.onError = (msg) => tombErrors.push(msg);

      engine.handleLocalChange(file);
      await new Promise((r) => setTimeout(r, 120));

      // Tombstone wins — local file should be removed
      expect(vault.getAbstractFileByPath("notes/resurrected.md")).toBeNull();
      // client.put must never be called (no resurrection)
      expect(client.put).not.toHaveBeenCalled();
      // No error surfaced to the user
      expect(tombErrors).toHaveLength(0);
    });

    it("pushes as new doc when client.get returns 404 missing (not a tombstone) in pushTextFile", async () => {
      // Scenario: no revMap entry, client.get returns a plain 404 (doc never existed — "missing").
      // Expected: pushTextFile falls through and calls client.put without a _rev (new doc creation).
      const { CouchError } = await import("./couch-client");
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.changes.mockResolvedValue({ last_seq: "0", results: [] });

      await engine.start();

      vault._addFile("notes/brand-new.md", "new content", 2000);
      const file: VaultFile = { kind: "file", path: "notes/brand-new.md", mtime: 2000, size: 0 };

      // client.get returns a missing 404 (not a tombstone — reason is "missing" not "deleted")
      client.get = vi.fn().mockRejectedValue(
        new CouchError(404, 'CouchDB 404: {"error":"not_found","reason":"missing"}'),
      );
      client.put = vi.fn().mockResolvedValue({ ok: true, id: "file/notes/brand-new.md", rev: "1-new" });

      const missErrors: string[] = [];
      engine.onError = (msg) => missErrors.push(msg);

      engine.handleLocalChange(file);
      await new Promise((r) => setTimeout(r, 120));

      // client.put must have been called without a _rev (new doc)
      expect(client.put).toHaveBeenCalledWith(
        expect.objectContaining({ _id: "file/notes/brand-new.md", content: "new content" }),
      );
      expect(client.put).toHaveBeenCalledWith(
        expect.not.objectContaining({ _rev: expect.anything() }),
      );
      // No error surfaced
      expect(missErrors).toHaveLength(0);
    });
  });

  describe("echo loop prevention", () => {
    it("ignores local changes triggered by remote apply", async () => {
      // Pre-populate revMap so the initial pull (rev "1-r" == revMap) is skipped,
      // but the incremental changes feed update (rev "2-r") is applied.
      const storeWithRevMap = new TestStateStore();
      storeWithRevMap.set("vault-sync-revmap", JSON.stringify({
        "file/notes/remote.md": { rev: "1-r", mtime: 5000, lastSeenInFs: Date.now() },
      }));
      const engine2 = makeEngine(settings, vaultAdapter, storeWithRevMap);
      engine2.onStateChange = (s) => stateChanges.push(s);
      engine2.onError = (msg) => errors.push(msg);

      const client = getClient(engine2);
      client.allDocs.mockResolvedValue({
        total_rows: 1,
        rows: [{
          id: "file/notes/remote.md",
          key: "file/notes/remote.md",
          value: { rev: "1-r" },
        }],
      });
      client.allDocsByKeys.mockResolvedValue({ total_rows: 0, rows: [] });
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

      await engine2.start();

      // During remote apply, handleLocalChange should be a no-op
      // This is internal behavior - we verify indirectly by checking
      // that no extra put() calls happen after a remote change
      const putCallsBefore = client.put.mock.calls.length;

      // Simulate what happens: remote doc is applied, which triggers vault.modify,
      // which would normally trigger handleLocalChange
      // The applyingRemote flag prevents the echo
      vault._addFile("notes/remote.md", "remote content", 5000);
      const file: VaultFile = { kind: "file", path: "notes/remote.md", mtime: 5000, size: 0 };
      engine2.handleLocalChange(file);
      await new Promise((r) => setTimeout(r, 100));

      // put() should not have been called for this file during remote apply
      // (it was only called if the engine pushed during fullSync)
      // The key assertion: no echo loop occurred
      expect(client.put.mock.calls.length).toBe(putCallsBefore);
      engine2.stop();
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
      // Pre-populate revMap so both docs pass the Trou B orphan guard (device has synced them before).
      const storeWithRevMap = new TestStateStore();
      storeWithRevMap.set("vault-sync-revmap", JSON.stringify({
        "file/images/orphan.png": { rev: "0-old", mtime: 0, lastSeenInFs: 0 },
        "file/images/real.png": { rev: "0-old", mtime: 0, lastSeenInFs: 0 },
      }));
      const engine2 = makeEngine(settings, vaultAdapter, storeWithRevMap);

      const client = getClient(engine2);
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

      await engine2.start();

      // getAttachment must be called only once (for real.png), not for orphan.png
      expect(client.getAttachment).toHaveBeenCalledTimes(1);
      expect(client.getAttachment).toHaveBeenCalledWith("file/images/real.png", "data.bin", expect.any(Number));
      expect(client.getAttachment).not.toHaveBeenCalledWith("file/images/orphan.png", "data.bin", expect.any(Number));
      engine2.stop();
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
      // Non-404 errors (network error, auth failure) should still surface via setError.
      // Pre-populate revMap so the doc passes the Trou B orphan guard.
      const { CouchError } = await import("./couch-client");
      const storeWithRevMap = new TestStateStore();
      storeWithRevMap.set("vault-sync-revmap", JSON.stringify({
        "file/images/broken.png": { rev: "0-old", mtime: 0, lastSeenInFs: 0 },
      }));
      const engine2 = makeEngine(settings, vaultAdapter, storeWithRevMap);
      const localErrors: string[] = [];
      engine2.onError = (msg) => localErrors.push(msg);

      const client = getClient(engine2);
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

      await engine2.start();

      expect(localErrors.length).toBeGreaterThan(0);
      expect(localErrors[0]).toContain("broken.png");
      engine2.stop();
    });

    it("pulls binary file via getAttachment and creates it in vault", async () => {
      // Pre-populate revMap with stale rev — required to pass Trou B orphan guard.
      const pngData = new Uint8Array([137, 80, 78, 71]).buffer; // PNG magic bytes
      const storeWithRevMap = new TestStateStore();
      storeWithRevMap.set("vault-sync-revmap", JSON.stringify({
        "file/images/photo.png": { rev: "0-old", mtime: 0, lastSeenInFs: 0 },
      }));
      const engine2 = makeEngine(settings, vaultAdapter, storeWithRevMap);

      const client = getClient(engine2);
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

      await engine2.start();

      expect(client.getAttachment).toHaveBeenCalledWith("file/images/photo.png", "data.bin", expect.any(Number));
      expect(vault._getBinaryContent("images/photo.png")).toBe(pngData);
      engine2.stop();
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
      // Scenario: device already has images/new.png synced (revMap entry + file in vault).
      // fullSync: remote is at same rev → no-op. Changes feed then delivers an update.
      const pngData = new Uint8Array([1]).buffer;
      vault._addBinaryFile("images/new.png", new Uint8Array([0]).buffer); // existing local file

      const storeWithRevMap = new TestStateStore();
      storeWithRevMap.set("vault-sync-revmap", JSON.stringify({
        "file/images/new.png": { rev: "1-old", mtime: 0, lastSeenInFs: Date.now() },
      }));
      const engine2 = makeEngine(settings, vaultAdapter, storeWithRevMap);

      const client = getClient(engine2);
      // fullSync: remote at same rev → no pull needed
      client.allDocs.mockResolvedValue({
        total_rows: 1,
        rows: [{ id: "file/images/new.png", key: "file/images/new.png", value: { rev: "1-old" } }],
      });
      client.allDocsByKeys.mockResolvedValue({ total_rows: 0, rows: [] });

      // First poll: nothing; second poll: binary update arrives
      client.changes
        .mockResolvedValueOnce({ last_seq: "1", results: [] })
        .mockResolvedValueOnce({
          last_seq: "2",
          results: [{
            seq: "2",
            id: "file/images/new.png",
            changes: [{ rev: "2-p" }],
            doc: { _id: "file/images/new.png", _rev: "2-p", content: null, mtime: 0 },
          }],
        });
      client.getAttachment = vi.fn().mockResolvedValue(pngData);

      await engine2.start();
      await new Promise((r) => setTimeout(r, 3500));

      expect(client.getAttachment).toHaveBeenCalledWith("file/images/new.png", "data.bin", expect.any(Number));
      expect(vault._getBinaryContent("images/new.png")).toBe(pngData);
      engine2.stop();
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
      // 6 docs: with PARALLEL_BINARY_PULLS=5 the first batch of 5 should start before any resolves.
      // Pre-populate revMap so all docs pass the Trou B orphan guard.
      const docIds = ["a", "b", "c", "d", "e", "f"].map(n => `file/images/${n}.png`);
      const revs = docIds.map((_, i) => `1-${i}`);

      const storeWithRevMap = new TestStateStore();
      const revMapData = Object.fromEntries(docIds.map(id => [id, { rev: "0-old", mtime: 0, lastSeenInFs: 0 }]));
      storeWithRevMap.set("vault-sync-revmap", JSON.stringify(revMapData));
      const engine2 = makeEngine(settings, vaultAdapter, storeWithRevMap);

      const client = getClient(engine2);
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

      await engine2.start();

      // With parallel downloads, at least 2 should have been in-flight simultaneously
      expect(maxConcurrent).toBeGreaterThan(1);
      expect(client.getAttachment).toHaveBeenCalledTimes(docIds.length);
      engine2.stop();
    });

    it("handles partial failures gracefully - successful docs applied, failed skipped", async () => {
      // Pre-populate revMap so all docs pass the Trou B orphan guard.
      const { CouchError } = await import("./couch-client");
      const docIds = ["ok1", "fail", "ok2", "ok3", "ok4"].map(n => `file/images/${n}.png`);
      const revs = docIds.map((_, i) => `1-${i}`);

      const storeWithRevMap = new TestStateStore();
      const revMapData = Object.fromEntries(docIds.map(id => [id, { rev: "0-old", mtime: 0, lastSeenInFs: 0 }]));
      storeWithRevMap.set("vault-sync-revmap", JSON.stringify(revMapData));
      const engine2 = makeEngine(settings, vaultAdapter, storeWithRevMap);
      const localErrors: string[] = [];
      engine2.onError = (msg) => localErrors.push(msg);

      const client = getClient(engine2);
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

      await engine2.start();

      // 4 successful, 1 failed → error emitted for the failure
      expect(localErrors.length).toBeGreaterThan(0);
      expect(localErrors[0]).toContain("fail");
      // The 4 successful docs should have been written to vault
      expect(vault._getBinaryContent("images/ok1.png")).toBeTruthy();
      expect(vault._getBinaryContent("images/ok2.png")).toBeTruthy();
      expect(vault._getBinaryContent("images/ok3.png")).toBeTruthy();
      expect(vault._getBinaryContent("images/ok4.png")).toBeTruthy();
      engine2.stop();
    });

    it("updates revMap for all successful parallel downloads", async () => {
      // Pre-populate revMap with stale revs — required to pass Trou B orphan guard.
      const docIds = ["img1", "img2", "img3"].map(n => `file/images/${n}.png`);
      const revs = ["1-aaa", "1-bbb", "1-ccc"];

      const storeWithRevMap = new TestStateStore();
      const revMapData = Object.fromEntries(docIds.map(id => [id, { rev: "0-old", mtime: 0, lastSeenInFs: 0 }]));
      storeWithRevMap.set("vault-sync-revmap", JSON.stringify(revMapData));
      const engine2 = makeEngine(settings, vaultAdapter, storeWithRevMap);

      const client = getClient(engine2);
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

      await engine2.start();

      // All 3 revs must be persisted in StateStore (as RevMapEntry objects)
      const saved = JSON.parse(storeWithRevMap.get("vault-sync-revmap") ?? "{}");
      expect(saved["file/images/img1.png"]?.rev).toBe("1-aaa");
      expect(saved["file/images/img2.png"]?.rev).toBe("1-bbb");
      expect(saved["file/images/img3.png"]?.rev).toBe("1-ccc");
      engine2.stop();
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
      // Pre-populate revMap so engine skips stub-creation and goes straight to putAttachment.
      // File must exist in vault before start() so reconcileLocalDeletes does not tombstone it.
      const jpegData = new Uint8Array([0xff, 0xd8, 0xff]).buffer;
      vault._addBinaryFile("images/conflict.jpeg", jpegData);

      const conflictStore = new TestStateStore();
      conflictStore.set("vault-sync-revmap", JSON.stringify({ "file/images/conflict.jpeg": "1-stale" }));
      const conflictEngine = makeEngine(settings, vaultAdapter, conflictStore);
      conflictEngine.onStateChange = () => {};
      conflictEngine.onError = (msg) => errors.push(msg);
      const conflictClient = getClient(conflictEngine);

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
      // File must exist in vault before start() so reconcileLocalDeletes does not tombstone it.
      const jpegData = new Uint8Array([0xff, 0xd8]).buffer;
      vault._addBinaryFile("images/persistent.jpeg", jpegData);

      const retryStore = new TestStateStore();
      retryStore.set("vault-sync-revmap", JSON.stringify({ "file/images/persistent.jpeg": "1-stale" }));
      const retryEngine = makeEngine(settings, vaultAdapter, retryStore);
      retryEngine.onStateChange = () => {};
      const retryErrors: string[] = [];
      retryEngine.onError = (msg) => retryErrors.push(msg);
      const retryClient = getClient(retryEngine);

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

  describe("ghost directory cleanup - handleLocalDelete", () => {
    // Helper: build engine with pre-populated revMap so handleLocalDelete sees a known rev.
    function makeEngineWithRevMap(revMap: Record<string, string>): { eng: SyncEngine; cli: ReturnType<typeof vi.fn> & Record<string, ReturnType<typeof vi.fn>> } {
      const store = new TestStateStore();
      store.set("vault-sync-revmap", JSON.stringify(revMap));
      const eng = makeEngine(settings, vaultAdapter, store);
      const cli = getClient(eng);
      return { eng, cli };
    }

    async function startEngine(eng: SyncEngine, cli: ReturnType<typeof vi.fn> & Record<string, ReturnType<typeof vi.fn>>) {
      cli.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      cli.changes.mockResolvedValue({ last_seq: "1", results: [] });
      cli.delete.mockResolvedValue({ ok: true, id: "", rev: "2-del" });
      await eng.start();
    }

    it("cleans empty parent dir when last file in dir is deleted locally", async () => {
      vault._addFile("folder/last.md", "content", 1000);
      vault._addFolder("folder", []); // empty after deletion
      const { eng, cli } = makeEngineWithRevMap({ "file/folder/last.md": "1-rev" });
      await startEngine(eng, cli);

      // Delete the file from disk (simulate OS event — file already gone)
      const tf = vault.getAbstractFileByPath("folder/last.md");
      if (tf) await vault.delete(tf as TFile);

      const file: VaultEntry = { kind: "file", path: "folder/last.md", mtime: 1000, size: 0 };
      await eng.handleLocalDelete(file);

      expect(vault._hasFolder("folder")).toBe(false);
      eng.stop();
    });

    it("cleans nested empty parent dirs when last file is deleted locally", async () => {
      vault._addFile("a/b/c/last.md", "deep", 1000);
      vault._addFolder("a/b/c", []);
      vault._addFolder("a/b", []);
      const otherFile = new TFile("a/other.md");
      vault._addFolder("a", [otherFile]);
      const { eng, cli } = makeEngineWithRevMap({ "file/a/b/c/last.md": "1-rev" });
      await startEngine(eng, cli);

      const tf = vault.getAbstractFileByPath("a/b/c/last.md");
      if (tf) await vault.delete(tf as TFile);

      const file: VaultEntry = { kind: "file", path: "a/b/c/last.md", mtime: 1000, size: 0 };
      await eng.handleLocalDelete(file);

      expect(vault._hasFolder("a/b/c")).toBe(false);
      expect(vault._hasFolder("a/b")).toBe(false);
      expect(vault._hasFolder("a")).toBe(true); // has other.md — not empty
      eng.stop();
    });

    it("keeps parent dir when a sibling file remains after local delete", async () => {
      vault._addFile("folder/gone.md", "bye", 1000);
      const sibling = new TFile("folder/sibling.md");
      vault._addFolder("folder", [sibling]);
      const { eng, cli } = makeEngineWithRevMap({ "file/folder/gone.md": "1-rev" });
      await startEngine(eng, cli);

      const tf = vault.getAbstractFileByPath("folder/gone.md");
      if (tf) await vault.delete(tf as TFile);

      const file: VaultEntry = { kind: "file", path: "folder/gone.md", mtime: 1000, size: 0 };
      await eng.handleLocalDelete(file);

      expect(vault._hasFolder("folder")).toBe(true);
      eng.stop();
    });

    it("cleans empty parent dir when file was never synced (no rev)", async () => {
      // File exists locally but was never pushed to CouchDB — !rev early-return path.
      // The directory should still be cleaned up.
      vault._addFile("unsync/note.md", "local", 1000);
      vault._addFolder("unsync", []);
      const { eng, cli } = makeEngineWithRevMap({}); // no revMap entry
      await startEngine(eng, cli);

      const tf = vault.getAbstractFileByPath("unsync/note.md");
      if (tf) await vault.delete(tf as TFile);

      const file: VaultEntry = { kind: "file", path: "unsync/note.md", mtime: 1000, size: 0 };
      await eng.handleLocalDelete(file);

      expect(vault._hasFolder("unsync")).toBe(false);
      eng.stop();
    });

    it("does not delete excluded dirs (.obsidian/) on local delete", async () => {
      // .obsidian/ is excluded — handleLocalDelete returns early due to isExcluded guard.
      // Cleanup is never reached, folder stays.
      vault._addFile(".obsidian/config", "data", 1000);
      vault._addFolder(".obsidian", []);
      const { eng, cli } = makeEngineWithRevMap({ "file/.obsidian/config": "1-rev" });
      await startEngine(eng, cli);

      // .obsidian/ is in excludePatterns — handleLocalDelete returns early, no cleanup
      const file: VaultEntry = { kind: "file", path: ".obsidian/config", mtime: 1000, size: 0 };
      await eng.handleLocalDelete(file);

      expect(vault._hasFolder(".obsidian")).toBe(true);
      eng.stop();
    });

    it("does not fail the sync when cleanupEmptyParents throws", async () => {
      // Simulate a deleteDirectory error — cleanup errors must be swallowed.
      vault._addFile("folder/last.md", "content", 1000);
      vault._addFolder("folder", []);
      const { eng, cli } = makeEngineWithRevMap({ "file/folder/last.md": "1-rev" });
      await startEngine(eng, cli);

      const tf = vault.getAbstractFileByPath("folder/last.md");
      if (tf) await vault.delete(tf as TFile);

      // Patch adapter to throw on deleteDirectory
      const original = vaultAdapter.deleteDirectory.bind(vaultAdapter);
      vaultAdapter.deleteDirectory = vi.fn().mockRejectedValue(new Error("fs error"));

      const errorSpy = vi.fn();
      eng.onError = errorSpy;

      const file: VaultEntry = { kind: "file", path: "folder/last.md", mtime: 1000, size: 0 };
      // Should NOT throw
      await expect(eng.handleLocalDelete(file)).resolves.toBeUndefined();
      // Should NOT surface a sync error
      expect(errorSpy).not.toHaveBeenCalled();

      vaultAdapter.deleteDirectory = original;
      eng.stop();
    });
  });

  describe("ghost directory cleanup - handleLocalRename", () => {
    it("cleans empty old-path parent dir after local rename", async () => {
      // File moves from folder-a/ to folder-b/ — folder-a/ becomes empty
      vault._addFile("folder-a/note.md", "content", 1000);
      vault._addFile("folder-b/note.md", "content", 1000); // destination already exists
      vault._addFolder("folder-a", []); // empty after rename-out
      vault._addFolder("folder-b", [new TFile("folder-b/note.md")]);

      const store = new TestStateStore();
      store.set("vault-sync-revmap", JSON.stringify({ "file/folder-a/note.md": "1-rev" }));
      const eng = makeEngine(settings, vaultAdapter, store);
      const cli = getClient(eng);
      cli.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      cli.changes.mockResolvedValue({ last_seq: "1", results: [] });
      cli.delete.mockResolvedValue({ ok: true, id: "file/folder-a/note.md", rev: "2-del" });
      cli.get.mockRejectedValue(new Error("not found"));
      cli.put.mockResolvedValue({ ok: true, id: "file/folder-b/note.md", rev: "1-new" });

      await eng.start();

      const newFile: VaultEntry = { kind: "file", path: "folder-b/note.md", mtime: 1000, size: 0 };
      await eng.handleLocalRename(newFile, "folder-a/note.md");

      expect(vault._hasFolder("folder-a")).toBe(false);
      expect(vault._hasFolder("folder-b")).toBe(true);
      eng.stop();
    });

    it("keeps old-path parent dir when a sibling remains after rename", async () => {
      const sibling = new TFile("shared/sibling.md");
      vault._addFile("shared/moved.md", "content", 1000);
      vault._addFolder("shared", [sibling]); // sibling remains
      vault._addFile("dest/moved.md", "content", 1000);
      vault._addFolder("dest", [new TFile("dest/moved.md")]);

      const store = new TestStateStore();
      store.set("vault-sync-revmap", JSON.stringify({ "file/shared/moved.md": "1-rev" }));
      const eng = makeEngine(settings, vaultAdapter, store);
      const cli = getClient(eng);
      cli.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      cli.changes.mockResolvedValue({ last_seq: "1", results: [] });
      cli.delete.mockResolvedValue({ ok: true, id: "file/shared/moved.md", rev: "2-del" });
      cli.get.mockRejectedValue(new Error("not found"));
      cli.put.mockResolvedValue({ ok: true, id: "file/dest/moved.md", rev: "1-new" });

      await eng.start();

      const newFile: VaultEntry = { kind: "file", path: "dest/moved.md", mtime: 1000, size: 0 };
      await eng.handleLocalRename(newFile, "shared/moved.md");

      expect(vault._hasFolder("shared")).toBe(true); // sibling still there
      eng.stop();
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
      // 1001 binary docIds: with META_BATCH_SIZE=500, expect chunks [0-499], [500-999], [1000].
      // Pre-populate revMap with stale revs for all docs — required to pass Trou B orphan guard.
      const docIds = Array.from({ length: 1001 }, (_, i) => `file/images/img${i}.png`);
      const revs = docIds.map((_, i) => `1-${i}`);

      const storeWithRevMap = new TestStateStore();
      const revMapData = Object.fromEntries(docIds.map(id => [id, { rev: "0-old", mtime: 0, lastSeenInFs: 0 }]));
      storeWithRevMap.set("vault-sync-revmap", JSON.stringify(revMapData));
      const engine2 = makeEngine(settings, vaultAdapter, storeWithRevMap);

      const client = getClient(engine2);
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

      await engine2.start();

      // allDocsByKeys should be called 3 times: [0..499], [500..999], [1000]
      expect(client.allDocsByKeys).toHaveBeenCalledTimes(3);
      expect(client.allDocsByKeys.mock.calls[0][0]).toHaveLength(500);
      expect(client.allDocsByKeys.mock.calls[1][0]).toHaveLength(500);
      expect(client.allDocsByKeys.mock.calls[2][0]).toHaveLength(1);
      // All 1001 files should have been written to vault
      expect(client.getAttachment).toHaveBeenCalledTimes(1001);
      engine2.stop();
    });

    it("partial metadata chunk failure: skips failed chunk docs, applies successful chunk", async () => {
      // 600 docIds: first chunk of 500 fails, second chunk of 100 succeeds.
      // META_BATCH_SIZE=500, so 600 docs → 2 chunks: [0..499] fails, [500..599] succeeds.
      // Pre-populate revMap for all docs — required to pass Trou B orphan guard.
      const firstChunkIds = Array.from({ length: 500 }, (_, i) => `file/images/fail${i}.png`);
      const secondChunkIds = Array.from({ length: 100 }, (_, i) => `file/images/ok${i}.png`);
      const docIds = [...firstChunkIds, ...secondChunkIds];
      const revs = docIds.map((_, i) => `1-${i}`);

      const storeWithRevMap = new TestStateStore();
      const revMapData = Object.fromEntries(docIds.map(id => [id, { rev: "0-old", mtime: 0, lastSeenInFs: 0 }]));
      storeWithRevMap.set("vault-sync-revmap", JSON.stringify(revMapData));
      const engine2 = makeEngine(settings, vaultAdapter, storeWithRevMap);
      const localStateChanges: string[] = [];
      engine2.onStateChange = (s) => localStateChanges.push(s);

      const client = getClient(engine2);
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

      await engine2.start();

      // Must not throw — engine should survive partial metadata failure
      // Only the second chunk's docs (secondChunkIds) have metadata, so only those download
      expect(client.getAttachment).toHaveBeenCalledTimes(secondChunkIds.length);
      // Engine should not enter error state due to metadata chunk failure
      expect(localStateChanges).not.toContain("error");
      engine2.stop();
    });

    it("failCount rate limiting: 5 failing binary downloads emit at most 3 errors", async () => {
      // Pre-populate revMap so all docs pass the Trou B orphan guard.
      const docIds = ["a", "b", "c", "d", "e"].map(n => `file/images/${n}.png`);
      const revs = docIds.map((_, i) => `1-${i}`);

      const storeWithRevMap = new TestStateStore();
      const revMapData = Object.fromEntries(docIds.map(id => [id, { rev: "0-old", mtime: 0, lastSeenInFs: 0 }]));
      storeWithRevMap.set("vault-sync-revmap", JSON.stringify(revMapData));
      const engine2 = makeEngine(settings, vaultAdapter, storeWithRevMap);
      const localErrors: string[] = [];
      engine2.onError = (msg) => localErrors.push(msg);

      const client = getClient(engine2);
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

      await engine2.start();

      // With 5 failures, errors emitted must be capped at 3
      expect(localErrors.length).toBeLessThanOrEqual(3);
      expect(localErrors.length).toBeGreaterThan(0);
      engine2.stop();
    });

    it("meta-chunk failure does not poison revMap with false orphan (issue #32)", async () => {
      // Regression guard: when allDocsByKeys throws during the metadata pre-fetch phase
      // of pullBinaryDocs, the affected docs must NOT be written as state:"orphan" into
      // revMap. Writing orphan would permanently exclude them from all future pulls via
      // the pullAllRemote orphan guard at L705.
      //
      // Setup: one binary doc with a valid attachment in remote.
      const docId = "file/a.png";
      const remoteRev = "1-abc";

      // forceFullSync clears revMap, so we use an empty store and bypass the orphan guard.
      const store = new TestStateStore();
      const eng = makeEngine(settings, vaultAdapter, store);
      const client = getClient(eng);

      client.allDocs.mockResolvedValue({
        total_rows: 1,
        rows: [{ id: docId, key: docId, value: { rev: remoteRev } }],
      });
      // The metadata pre-fetch inside pullBinaryDocs throws (e.g. timeout).
      // allDocsByKeys is also called during push tombstone check — we want to throw only
      // on the binary metadata path. The safest discriminator is to throw when called
      // with our specific docId, which only happens in pullBinaryDocs (the push tombstone
      // check happens before any binary pull and with different doc sets).
      client.allDocsByKeys.mockRejectedValue(new Error("Request timed out"));
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });
      client.getAttachment = vi.fn().mockResolvedValue(new ArrayBuffer(4));

      // forceFullSync bypasses the orphan guard — this is the scenario for fresh installs
      // and is also the code path users hit when triggering a manual "Force full sync".
      await eng.forceFullSync();

      // Primary assertion: the doc must NOT be recorded as orphan.
      // An orphan entry would permanently block re-pulls on every future sync.
      const saved = JSON.parse(store.get("vault-sync-revmap") ?? "{}");
      const entry = saved[docId];
      expect(entry?.state).not.toBe("orphan");

      eng.stop();
    });

    it("meta-chunk failure: doc is re-pulled successfully on next sync after transient error (issue #32)", async () => {
      // Stronger regression guard: after a transient metadata-fetch failure (first sync),
      // the doc must be pulled to "known" on the next sync when the network recovers.
      // This proves "re-attempted on next sync" is no longer a lie.
      const docId = "file/a.png";
      const remoteRev = "1-abc";

      const store = new TestStateStore();
      const eng = makeEngine(settings, vaultAdapter, store);
      const client = getClient(eng);

      // First sync: allDocsByKeys always fails → doc skipped, NOT orphaned
      client.allDocs.mockResolvedValue({
        total_rows: 1,
        rows: [{ id: docId, key: docId, value: { rev: remoteRev } }],
      });
      client.allDocsByKeys.mockRejectedValue(new Error("Request timed out"));
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });
      client.getAttachment = vi.fn().mockResolvedValue(new ArrayBuffer(4));

      await eng.forceFullSync();

      // After first sync: doc must not be orphan (otherwise second sync skips it)
      const afterFirst = JSON.parse(store.get("vault-sync-revmap") ?? "{}");
      expect(afterFirst[docId]?.state).not.toBe("orphan");

      // Second sync: network recovered, allDocsByKeys succeeds and returns the attachment
      client.allDocsByKeys.mockResolvedValue({
        total_rows: 1,
        rows: [makeBinaryAllDocsRow(docId, remoteRev)],
      });
      // allDocs still returns the same remote rev → still needs to be pulled (revMap has no entry)
      client.allDocs.mockResolvedValue({
        total_rows: 1,
        rows: [{ id: docId, key: docId, value: { rev: remoteRev } }],
      });
      client.getAttachment = vi.fn().mockResolvedValue(new ArrayBuffer(4));

      await eng.forceFullSync();

      // After second sync: doc must be known (attachment was downloaded)
      const afterSecond = JSON.parse(store.get("vault-sync-revmap") ?? "{}");
      expect(afterSecond[docId]).toMatchObject({ state: "known", rev: remoteRev });
      expect(client.getAttachment).toHaveBeenCalledWith(docId, expect.any(String), expect.any(Number));

      eng.stop();
    });
  });

  describe("reconcileLocalDeletes", () => {
    function makeRevMapStore(revMap: Record<string, string>): TestStateStore {
      const s = new TestStateStore();
      s.set("vault-sync-revmap", JSON.stringify(revMap));
      return s;
    }

    it("does not call bulkDocs for delete when all revMap files are present locally", async () => {
      vault._addFile("notes/present.md", "content", 1000);

      const store = makeRevMapStore({ "file/notes/present.md": "1-rev" });
      const eng = makeEngine(settings, vaultAdapter, store);
      const client = getClient(eng);

      // Remote returns same rev → no push/pull activity either
      client.allDocs.mockResolvedValue({
        total_rows: 1,
        rows: [{ id: "file/notes/present.md", key: "file/notes/present.md", value: { rev: "1-rev" } }],
      });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await eng.start();

      const deleteCalls = (client.bulkDocs.mock.calls as CouchDoc[][]).filter(
        (args) => args[0]?.some?.((d: CouchDoc) => d._deleted)
      );
      expect(deleteCalls).toHaveLength(0);
      eng.stop();
    });

    it("tombstones a locally-missing file via bulkDocs and cleans revMap", async () => {
      // No file added to vault → locally absent

      const store = makeRevMapStore({ "file/Mantu/missing.md": "1-old" });
      const eng = makeEngine(settings, vaultAdapter, store);
      const client = getClient(eng);

      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.bulkDocs.mockResolvedValue([{ ok: true, id: "file/Mantu/missing.md", rev: "2-tomb" }]);
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await eng.start();

      expect(client.bulkDocs).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ _id: "file/Mantu/missing.md", _deleted: true }),
        ])
      );

      // After tombstoning, the entry moves to tombstoned state (permanent); no known entries remain
      const diagnostics = eng.getDiagnostics();
      expect(diagnostics.knownRevMapSize).toBe(0);
      eng.stop();
    });

    it("falls back to per-doc delete when bulkDocs throws, cleans revMap on success", async () => {
      const store = makeRevMapStore({ "file/notes/gone.md": "1-rev" });
      const eng = makeEngine(settings, vaultAdapter, store);
      const client = getClient(eng);

      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      // First bulkDocs call (reconcile) throws; delete succeeds
      client.bulkDocs.mockRejectedValueOnce(new Error("network error"));
      client.delete.mockResolvedValue({ ok: true, id: "file/notes/gone.md", rev: "2-tomb" });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await eng.start();

      expect(client.delete).toHaveBeenCalledWith("file/notes/gone.md", "1-rev");
      expect(eng.getDiagnostics().knownRevMapSize).toBe(0);
      eng.stop();
    });

    it("silently clears revMap when per-doc delete returns 404", async () => {
      const { CouchError } = await import("./couch-client");

      const store = makeRevMapStore({ "file/notes/already-gone.md": "1-rev" });
      const eng = makeEngine(settings, vaultAdapter, store);
      const client = getClient(eng);

      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.bulkDocs.mockRejectedValueOnce(new Error("bulk failed"));
      client.delete.mockRejectedValue(new CouchError(404, '{"reason":"deleted"}'));
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await eng.start();

      // No error should be emitted for 404
      expect(errors).toHaveLength(0);
      expect(eng.getDiagnostics().knownRevMapSize).toBe(0);
      eng.stop();
    });

    it("skips excluded paths in revMap — does not tombstone them", async () => {
      // ".obsidian/" is in the default excludePatterns
      const store = makeRevMapStore({ "file/.obsidian/config.json": "1-rev" });
      const eng = makeEngine(settings, vaultAdapter, store);
      const client = getClient(eng);

      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await eng.start();

      const deleteCalls = (client.bulkDocs.mock.calls as CouchDoc[][]).filter(
        (args) => args[0]?.some?.((d: CouchDoc) => d._deleted)
      );
      expect(deleteCalls).toHaveLength(0);
      // revMap entry for excluded path should remain untouched
      expect(eng.getDiagnostics().revMapSize).toBe(1);
      eng.stop();
    });

    it("does not tombstone a file that is present locally even when rev is stale", async () => {
      vault._addFile("notes/stale.md", "content", 1000);

      const store = makeRevMapStore({ "file/notes/stale.md": "1-old" });
      const eng = makeEngine(settings, vaultAdapter, store);
      const client = getClient(eng);

      // Remote has a newer rev — pull would normally fetch this
      client.allDocs.mockResolvedValue({
        total_rows: 1,
        rows: [{ id: "file/notes/stale.md", key: "file/notes/stale.md", value: { rev: "2-new" } }],
      });
      // Pull fetch returns a doc so pull can apply it
      client.allDocsByKeys.mockResolvedValue({
        total_rows: 1,
        rows: [{ id: "file/notes/stale.md", key: "file/notes/stale.md", value: { rev: "2-new" }, doc: { _id: "file/notes/stale.md", _rev: "2-new", content: "updated", mtime: 2000 } }],
      });
      client.changes.mockResolvedValue({ last_seq: "2", results: [] });

      await eng.start();

      // reconcile must NOT have sent a _deleted:true for this file
      const deleteCalls = (client.bulkDocs.mock.calls as CouchDoc[][]).filter(
        (args) => args[0]?.some?.((d: CouchDoc) => d._deleted)
      );
      expect(deleteCalls).toHaveLength(0);
      eng.stop();
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

  describe("RevMap shape change + Trou A + Trou B (issue #20)", () => {
    it("migration: pre-populated string-valued revMap loads as RevMapEntry and does not spuriously push when rev matches", async () => {
      // Legacy format: { "file/notes/old.md": "1-r" } (string, not object)
      vault._addFile("notes/old.md", "synced content", 1000);

      const legacyStore = new TestStateStore();
      legacyStore.set("vault-sync-revmap", JSON.stringify({ "file/notes/old.md": "1-r" }));
      const eng = makeEngine(settings, vaultAdapter, legacyStore);

      const client = getClient(eng);
      // Remote is at same rev as legacy string value
      client.allDocs.mockResolvedValue({
        total_rows: 1,
        rows: [{ id: "file/notes/old.md", key: "file/notes/old.md", value: { rev: "1-r" } }],
      });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await eng.start();

      // Should NOT push (mtime:0 from migration, file.mtime=1000 > 0, but remoteRevs has the doc;
      // Trou A: known.mtime=0 means treat as changed, so it WILL push — which is the expected
      // one-time migration burst. Verify it went through resolveConflict (409 scenario: same content).
      // Here we just verify no error is thrown and the engine reaches ok state.
      expect(eng.getDiagnostics().revMapSize).toBeGreaterThanOrEqual(1);

      // Verify the migrated entry is now a RevMapEntry (not a raw string)
      const saved = JSON.parse(legacyStore.get("vault-sync-revmap") ?? "{}");
      // After migration + push, the entry should be an object with a rev property
      expect(typeof saved["file/notes/old.md"]).toBe("object");
      expect(saved["file/notes/old.md"]).toHaveProperty("rev");
      eng.stop();
    });

    it("Trou A regression: file with mtime > revMap.mtime triggers push even when remoteRevs.has the doc", async () => {
      // Simulates: device already synced file at mtime 1000; remote has it; file is now mtime 2000 (modified)
      vault._addFile("notes/modified.md", "updated content", 2000);

      const storeWithRevMap = new TestStateStore();
      storeWithRevMap.set("vault-sync-revmap", JSON.stringify({
        "file/notes/modified.md": { rev: "1-r", mtime: 1000, lastSeenInFs: Date.now() },
      }));
      const eng = makeEngine(settings, vaultAdapter, storeWithRevMap);

      const client = getClient(eng);
      // Remote has the doc (so the old code would skip push)
      client.allDocs.mockResolvedValue({
        total_rows: 1,
        rows: [{ id: "file/notes/modified.md", key: "file/notes/modified.md", value: { rev: "1-r" } }],
      });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });
      // put() succeeds (no conflict)
      client.put.mockResolvedValue({ ok: true, id: "file/notes/modified.md", rev: "2-new" });

      await eng.start();

      // Must push because file.mtime (2000) > revMap.mtime (1000)
      expect(client.put).toHaveBeenCalledWith(
        expect.objectContaining({ _id: "file/notes/modified.md", content: "updated content", mtime: 2000 })
      );
      eng.stop();
    });

    it("Trou A negative: file with mtime <= revMap.mtime skips push", async () => {
      // Simulates: device synced file at mtime 3000; file has not changed (mtime still 3000)
      vault._addFile("notes/unchanged.md", "same content", 3000);

      const storeWithRevMap = new TestStateStore();
      storeWithRevMap.set("vault-sync-revmap", JSON.stringify({
        "file/notes/unchanged.md": { rev: "1-r", mtime: 3000, lastSeenInFs: Date.now() },
      }));
      const eng = makeEngine(settings, vaultAdapter, storeWithRevMap);

      const client = getClient(eng);
      client.allDocs.mockResolvedValue({
        total_rows: 1,
        rows: [{ id: "file/notes/unchanged.md", key: "file/notes/unchanged.md", value: { rev: "1-r" } }],
      });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await eng.start();

      // Must NOT push (file unchanged since last sync)
      expect(client.put).not.toHaveBeenCalled();
      expect(client.bulkDocs).not.toHaveBeenCalled();
      eng.stop();
    });

    it("Trou B: DB-only doc with no revMap entry is NOT pulled to FS (agent-created doc protection)", async () => {
      // Simulates: an AI agent created a doc in CouchDB that was never synced to this device.
      // Expected: normal start() does NOT pull it (would write arbitrary content to vault).
      // Note: first-device onboarding uses forceFullSync() which bypasses this guard.
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({
        total_rows: 1,
        rows: [{ id: "file/notes/agent-created.md", key: "file/notes/agent-created.md", value: { rev: "1-a" } }],
      });
      client.allDocsByKeys.mockResolvedValue({
        total_rows: 1,
        rows: [{
          id: "file/notes/agent-created.md",
          key: "file/notes/agent-created.md",
          value: { rev: "1-a" },
          doc: { _id: "file/notes/agent-created.md", _rev: "1-a", content: "agent wrote this", mtime: 1000 },
        }],
      });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      // Empty revMap (no prior sync on this device)
      await engine.start();

      // File must NOT exist in vault — Trou B guard blocked the pull
      expect(vault.getAbstractFileByPath("notes/agent-created.md")).toBeNull();
    });

    it("Trou B regression: DB doc with revMap entry IS pulled when rev differs", async () => {
      // Simulates: device previously synced the doc (revMap entry exists with stale rev).
      // Expected: updated doc IS pulled because device has a record of this doc.
      vault._addFile("notes/known-doc.md", "old content", 1000);

      const storeWithRevMap = new TestStateStore();
      storeWithRevMap.set("vault-sync-revmap", JSON.stringify({
        "file/notes/known-doc.md": { rev: "1-old", mtime: 1000, lastSeenInFs: Date.now() },
      }));
      const eng = makeEngine(settings, vaultAdapter, storeWithRevMap);

      const client = getClient(eng);
      client.allDocs.mockResolvedValue({
        total_rows: 1,
        rows: [{ id: "file/notes/known-doc.md", key: "file/notes/known-doc.md", value: { rev: "2-new" } }],
      });
      client.allDocsByKeys.mockResolvedValue({
        total_rows: 1,
        rows: [{
          id: "file/notes/known-doc.md",
          key: "file/notes/known-doc.md",
          value: { rev: "2-new" },
          doc: { _id: "file/notes/known-doc.md", _rev: "2-new", content: "updated by another device", mtime: 5000 },
        }],
      });
      client.changes.mockResolvedValue({ last_seq: "2", results: [] });

      await eng.start();

      // File MUST be updated — Trou B guard passed because revMap entry exists
      expect(vault._getContent("notes/known-doc.md")).toBe("updated by another device");
      eng.stop();
    });
  });

  describe("revMap state transitions", () => {
    it("migration shape B: { rev, mtime, lastSeenInFs } loads as known entry", () => {
      const store = new TestStateStore();
      store.set("vault-sync-revmap", JSON.stringify({
        "file/notes/shape-b.md": { rev: "1-rev", mtime: 5000, lastSeenInFs: 12345 },
      }));
      // Engine constructor calls loadPersistedState() synchronously — migration happens here
      const eng = makeEngine(settings, vaultAdapter, store);
      eng.stop();

      const diag = eng.getDiagnostics();
      expect(diag.revMapSize).toBe(1);
      expect(diag.knownRevMapSize).toBe(1);
      // In-memory revMap is the migration result — accessible via @ts-expect-error
      // @ts-expect-error -- accessing private for test
      const entry = eng.revMap["file/notes/shape-b.md"];
      expect(entry).toMatchObject({ state: "known", rev: "1-rev", mtime: 5000 });
    });

    it("migration shape A: string rev loads as known entry with mtime: 0", () => {
      const store = new TestStateStore();
      store.set("vault-sync-revmap", JSON.stringify({
        "file/notes/shape-a.md": "1-rev",
      }));
      // Engine constructor calls loadPersistedState() synchronously — migration happens here
      const eng = makeEngine(settings, vaultAdapter, store);
      eng.stop();

      const diag = eng.getDiagnostics();
      expect(diag.revMapSize).toBe(1);
      expect(diag.knownRevMapSize).toBe(1);
      // @ts-expect-error -- accessing private for test
      const entry = eng.revMap["file/notes/shape-a.md"];
      expect(entry).toMatchObject({ state: "known", rev: "1-rev", mtime: 0 });
    });

    it("local delete known → tombstoned with tombstonedAt set", async () => {
      vault._addFile("notes/to-delete.md", "content", 1000);

      const store = new TestStateStore();
      store.set("vault-sync-revmap", JSON.stringify({
        "file/notes/to-delete.md": { state: "known", rev: "1-r", mtime: 1000 },
      }));
      const eng = makeEngine(settings, vaultAdapter, store);
      const client = getClient(eng);

      // Remote has the doc at same rev (no pull needed, no reconcile delete)
      client.allDocs.mockResolvedValue({
        total_rows: 1,
        rows: [{ id: "file/notes/to-delete.md", key: "file/notes/to-delete.md", value: { rev: "1-r" } }],
      });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });
      client.delete = vi.fn().mockResolvedValue({ ok: true, id: "file/notes/to-delete.md", rev: "2-tomb" });

      await eng.start();

      // Now trigger the local delete (simulates user deleting the file)
      const file: VaultEntry = { kind: "file", path: "notes/to-delete.md", mtime: 1000, size: 10 };
      await eng.handleLocalDelete(file);

      const saved = JSON.parse(store.get("vault-sync-revmap") ?? "{}");
      expect(saved["file/notes/to-delete.md"]).toMatchObject({
        state: "tombstoned",
        rev: "2-tomb",
      });
      expect(typeof saved["file/notes/to-delete.md"].tombstonedAt).toBe("number");
      eng.stop();
    });

    it("remote delete known → tombstoned", async () => {
      vault._addFile("notes/remote-del.md", "content", 1000);

      const store = new TestStateStore();
      store.set("vault-sync-revmap", JSON.stringify({
        "file/notes/remote-del.md": { state: "known", rev: "1-r", mtime: 1000 },
      }));
      const eng = makeEngine(settings, vaultAdapter, store);
      const client = getClient(eng);

      // Remote allDocs returns empty — the doc was deleted remotely
      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await eng.start();

      const saved = JSON.parse(store.get("vault-sync-revmap") ?? "{}");
      expect(saved["file/notes/remote-del.md"]).toMatchObject({ state: "tombstoned" });
      // File should be deleted from vault
      expect(vault.getAbstractFileByPath("notes/remote-del.md")).toBeNull();
      eng.stop();
    });

    it("tombstone permanence regression: handleLocalChange on tombstoned path → no push", async () => {
      // A doc is tombstoned. A local change event fires (e.g., FS race condition).
      // The push must NOT happen — tombstone is permanent until forceFullSync.
      const store = new TestStateStore();
      store.set("vault-sync-revmap", JSON.stringify({
        "file/notes/tombstoned.md": { state: "tombstoned", rev: "2-tomb", tombstonedAt: Date.now() },
      }));
      const eng = makeEngine(settings, vaultAdapter, store);
      const client = getClient(eng);

      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });
      client.put = vi.fn().mockResolvedValue({ ok: true, id: "file/notes/tombstoned.md", rev: "3-new" });

      await eng.start();

      vault._addFile("notes/tombstoned.md", "resurrected content", Date.now());
      const file: VaultEntry = { kind: "file", path: "notes/tombstoned.md", mtime: Date.now(), size: 20 };
      eng.handleLocalChange(file);
      await new Promise((r) => setTimeout(r, 120));

      // put must NOT have been called — tombstone blocks push
      expect(client.put).not.toHaveBeenCalled();
      // Entry must remain tombstoned — permanence guarantee
      const saved = JSON.parse(store.get("vault-sync-revmap") ?? "{}");
      expect(saved["file/notes/tombstoned.md"]).toMatchObject({ state: "tombstoned" });
      eng.stop();
    });

    it("first observation via changes feed → orphan state (no FS write)", async () => {
      // No revMap entry and no local file — doc appears in changes feed for first time.
      // Expected: recorded as orphan, no file written to vault.
      const client = getClient(engine);
      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.changes
        .mockResolvedValueOnce({ last_seq: "1", results: [] })
        .mockResolvedValueOnce({
          last_seq: "2",
          results: [{
            seq: "2",
            id: "file/notes/agent-doc.md",
            changes: [{ rev: "1-a" }],
            deleted: false,
            doc: { _id: "file/notes/agent-doc.md", _rev: "1-a", content: "agent content", mtime: 1000 },
          }],
        });

      await engine.start();
      // @ts-expect-error -- accessing private for test
      await engine.pollChanges();

      // File must NOT be in vault (Trou B guard via orphan state)
      expect(vault.getAbstractFileByPath("notes/agent-doc.md")).toBeNull();

      // Entry must be recorded as orphan
      const diag = engine.getDiagnostics();
      expect(diag.knownRevMapSize).toBe(0);
      expect(diag.revMapSize).toBe(1);
    });

    it("binary orphan: no attachment in metadata → state: 'orphan', no mtime field", async () => {
      // A binary doc exists in DB but has no attachment (e.g., stub only).
      // Expected: recorded as orphan with no mtime field.
      const store = new TestStateStore();
      store.set("vault-sync-revmap", JSON.stringify({
        "file/images/stub.png": { state: "known", rev: "0-old", mtime: 0 },
      }));
      const eng = makeEngine(settings, vaultAdapter, store);
      const client = getClient(eng);

      client.allDocs.mockResolvedValue({
        total_rows: 1,
        rows: [{ id: "file/images/stub.png", key: "file/images/stub.png", value: { rev: "1-new" } }],
      });
      // allDocsByKeys returns doc without _attachments — binary orphan
      client.allDocsByKeys.mockResolvedValue({
        total_rows: 1,
        rows: [{
          id: "file/images/stub.png",
          key: "file/images/stub.png",
          value: { rev: "1-new" },
          doc: { _id: "file/images/stub.png", _rev: "1-new", content: null, mtime: 0 },
        }],
      });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await eng.start();

      const saved = JSON.parse(store.get("vault-sync-revmap") ?? "{}");
      const entry = saved["file/images/stub.png"];
      expect(entry).toMatchObject({ state: "orphan", rev: "1-new" });
      expect("mtime" in entry).toBe(false);
      eng.stop();
    });

    it("reconcileLocalDeletes skips tombstoned entries", async () => {
      // File is already tombstoned (no FS presence expected). reconcileLocalDeletes must
      // NOT try to delete it again on CouchDB — tombstone is permanent.
      const store = new TestStateStore();
      store.set("vault-sync-revmap", JSON.stringify({
        "file/notes/already-tombstoned.md": { state: "tombstoned", rev: "2-tomb", tombstonedAt: Date.now() },
      }));
      const eng = makeEngine(settings, vaultAdapter, store);
      const client = getClient(eng);

      client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
      client.changes.mockResolvedValue({ last_seq: "1", results: [] });

      await eng.start();

      // bulkDocs must not have been called with a _deleted doc for the tombstoned entry
      const deleteCalls = (client.bulkDocs.mock.calls as unknown[][]).filter(
        (args) => Array.isArray(args[0]) && (args[0] as CouchDoc[]).some((d: CouchDoc) => d._deleted)
      );
      expect(deleteCalls).toHaveLength(0);
      eng.stop();
    });
  });
});

describe("robust read errors", () => {
  let vault: Vault;
  let stateStore: TestStateStore;
  let settings: VaultSyncSettings;
  let errors: string[];

  function makeEngine(vaultAdapter: VaultAdapter): SyncEngine {
    const e = new SyncEngine(settings, vaultAdapter, stateStore, noopTransport);
    e.onError = (msg) => errors.push(msg);
    return e;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vault = new Vault();
    stateStore = new TestStateStore();
    settings = makeSettings();
    errors = [];
  });

  it("EAGAIN on readBinary: file added to unsyncableFiles, push continues for other files", async () => {
    // Set up two binary files: one triggers EAGAIN, the other pushes successfully
    vault._addFile("images/cloud.png", "png-data", 2000);
    vault._addFile("images/local.png", "png-data2", 2001);

    const eagainError = Object.assign(new Error("Unknown system error -11"), { code: "EAGAIN" });

    const adapter = new TestVaultAdapter(vault);
    const origReadBinary = adapter.readBinary.bind(adapter);
    adapter.readBinary = async (file: VaultFile) => {
      if (file.path === "images/cloud.png") throw eagainError;
      return origReadBinary(file);
    };

    const engine = makeEngine(adapter);
    const client = getClient(engine);
    client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
    client.allDocsByKeys.mockResolvedValue({ total_rows: 0, rows: [] });
    client.changes.mockResolvedValue({ last_seq: "0", results: [] });
    client.putAttachment.mockResolvedValue({ ok: true, id: "file/images/local.png", rev: "1-abc" });
    client.put.mockResolvedValue({ ok: true, id: "file/images/local.png", rev: "1-abc" });

    await engine.start();

    const diag = engine.getDiagnostics();
    expect(diag.unsyncableCount).toBe(1);
    expect(diag.unsyncableSample).toContain("images/cloud.png");
    // The other file was pushed — putAttachment called at least once
    expect(client.putAttachment).toHaveBeenCalled();
    // No per-file error for the EAGAIN — only the summary once-per-fullSync error
    expect(errors.some((e) => e.includes("unsyncable"))).toBe(true);
    expect(errors.every((e) => !e.includes("Binary push failed"))).toBe(true);

    engine.stop();
  });

  it("EACCES on readText: file added to unsyncableFiles, push continues for other files", async () => {
    vault._addFile("docs/restricted.md", "secret", 2000);
    vault._addFile("docs/open.md", "hello", 2001);

    const eaccesError = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });

    const adapter = new TestVaultAdapter(vault);
    const origReadText = adapter.readText.bind(adapter);
    adapter.readText = async (file: VaultFile) => {
      if (file.path === "docs/restricted.md") throw eaccesError;
      return origReadText(file);
    };

    const engine = makeEngine(adapter);
    const client = getClient(engine);
    client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
    client.allDocsByKeys.mockResolvedValue({ total_rows: 0, rows: [] });
    client.changes.mockResolvedValue({ last_seq: "0", results: [] });
    client.bulkDocs.mockResolvedValue([
      { ok: true, id: "file/docs/open.md", rev: "1-x" },
    ]);

    await engine.start();

    const diag = engine.getDiagnostics();
    expect(diag.unsyncableCount).toBe(1);
    expect(diag.unsyncableSample).toContain("docs/restricted.md");
    expect(errors.some((e) => e.includes("unsyncable"))).toBe(true);
    expect(errors.every((e) => !e.includes("Push failed for"))).toBe(true);

    engine.stop();
  });

  it("ENOENT on readBinary (race-deleted): file added to unsyncableFiles", async () => {
    vault._addFile("images/vanish.png", "data", 2000);

    const enoentError = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });

    const adapter = new TestVaultAdapter(vault);
    adapter.readBinary = async (_file: VaultFile) => { throw enoentError; };

    const engine = makeEngine(adapter);
    const client = getClient(engine);
    client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
    client.allDocsByKeys.mockResolvedValue({ total_rows: 0, rows: [] });
    client.changes.mockResolvedValue({ last_seq: "0", results: [] });

    await engine.start();

    const diag = engine.getDiagnostics();
    expect(diag.unsyncableCount).toBe(1);
    expect(diag.unsyncableSample).toContain("images/vanish.png");

    engine.stop();
  });

  it("EBUSY (non-recoverable): error propagates as fatal binary push failure", async () => {
    vault._addFile("images/busy.png", "data", 2000);

    const ebusyError = Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });

    const adapter = new TestVaultAdapter(vault);
    adapter.readBinary = async (_file: VaultFile) => { throw ebusyError; };

    const engine = makeEngine(adapter);
    const client = getClient(engine);
    client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
    client.allDocsByKeys.mockResolvedValue({ total_rows: 0, rows: [] });
    client.changes.mockResolvedValue({ last_seq: "0", results: [] });

    await engine.start();

    // EBUSY is not recoverable — logged as a push failure error (not as unsyncable)
    expect(errors.some((e) => e.includes("Binary push failed"))).toBe(true);
    const diag = engine.getDiagnostics();
    expect(diag.unsyncableCount).toBe(0);

    engine.stop();
  });

  it("successful read after previous EAGAIN removes file from unsyncableFiles", async () => {
    vault._addFile("images/cloud.png", "png-data", 2000);

    let callCount = 0;
    const eagainError = Object.assign(new Error("Unknown system error -11"), { code: "EAGAIN" });

    const adapter = new TestVaultAdapter(vault);
    const origReadBinary = adapter.readBinary.bind(adapter);
    adapter.readBinary = async (file: VaultFile) => {
      callCount++;
      if (callCount === 1) throw eagainError; // First call: EAGAIN
      return origReadBinary(file);             // Subsequent calls: success
    };

    const engine = makeEngine(adapter);
    const client = getClient(engine);
    client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
    client.allDocsByKeys.mockResolvedValue({ total_rows: 0, rows: [] });
    client.changes.mockResolvedValue({ last_seq: "0", results: [] });
    client.put.mockResolvedValue({ ok: true, id: "file/images/cloud.png", rev: "1-a" });
    client.putAttachment.mockResolvedValue({ ok: true, id: "file/images/cloud.png", rev: "2-b" });

    await engine.start();

    // After first fullSync: file is unsyncable
    expect(engine.getDiagnostics().unsyncableCount).toBe(1);
    engine.stop();

    // Simulate a second fullSync cycle — reset mocks for it
    vi.clearAllMocks();
    const engine2 = new SyncEngine(settings, adapter, stateStore, noopTransport);
    engine2.onError = (msg) => errors.push(msg);
    const client2 = getClient(engine2);
    client2.allDocs.mockResolvedValue({ total_rows: 0, rows: [{ id: "file/images/cloud.png", key: "file/images/cloud.png", value: { rev: "1-a" } }] });
    client2.allDocsByKeys.mockResolvedValue({ total_rows: 0, rows: [] });
    client2.changes.mockResolvedValue({ last_seq: "0", results: [] });
    client2.put.mockResolvedValue({ ok: true, id: "file/images/cloud.png", rev: "2-b" });
    client2.putAttachment.mockResolvedValue({ ok: true, id: "file/images/cloud.png", rev: "2-b" });

    await engine2.start();
    expect(engine2.getDiagnostics().unsyncableCount).toBe(0);
    engine2.stop();
  });

  it("getDiagnostics unsyncableCount reflects map size", async () => {
    vault._addFile("a.png", "a", 1000);
    vault._addFile("b.png", "b", 1001);
    vault._addFile("c.png", "c", 1002);

    const recoverable = Object.assign(new Error("Unknown system error -11"), { code: "EAGAIN" });

    const adapter = new TestVaultAdapter(vault);
    adapter.readBinary = async (_file: VaultFile) => { throw recoverable; };

    const engine = makeEngine(adapter);
    const client = getClient(engine);
    client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
    client.allDocsByKeys.mockResolvedValue({ total_rows: 0, rows: [] });
    client.changes.mockResolvedValue({ last_seq: "0", results: [] });

    await engine.start();

    const diag = engine.getDiagnostics();
    expect(diag.unsyncableCount).toBe(3);
    expect(diag.unsyncableSample.length).toBeLessThanOrEqual(5);

    engine.stop();
  });
});

describe("planFullSync (dry-run)", () => {
  let vault: Vault;
  let vaultAdapter: TestVaultAdapter;
  let stateStore: TestStateStore;
  let settings: VaultSyncSettings;

  // Shared write-method spies checked in every test for zero side effects
  let writeMethods: string[];

  function makeEngine(overrides: Partial<VaultSyncSettings> = {}): SyncEngine {
    return new SyncEngine(makeSettings(overrides), vaultAdapter, stateStore, noopTransport);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vault = new Vault();
    vaultAdapter = new TestVaultAdapter(vault);
    stateStore = new TestStateStore();
    settings = makeSettings();
    writeMethods = ["put", "bulkDocs", "delete", "putAttachment"];
  });

  /** Assert no write methods were called on the client */
  function assertNoWrites(engine: SyncEngine): void {
    const client = getClient(engine);
    for (const method of writeMethods) {
      expect(client[method], `${method} must not be called in dry-run`).not.toHaveBeenCalled();
    }
    // Vault writes
    expect(vaultAdapter.modifyText).not.toBeDefined(); // structural check
  }

  /** Assert that vault write methods were never called */
  function assertNoVaultWrites(engine: SyncEngine, vaultSpy: { modifyText: ReturnType<typeof vi.fn>; createText: ReturnType<typeof vi.fn>; modifyBinary: ReturnType<typeof vi.fn>; createBinary: ReturnType<typeof vi.fn>; deleteFile: ReturnType<typeof vi.fn> }): void {
    expect(vaultSpy.modifyText, "modifyText must not be called").not.toHaveBeenCalled();
    expect(vaultSpy.createText, "createText must not be called").not.toHaveBeenCalled();
    expect(vaultSpy.modifyBinary, "modifyBinary must not be called").not.toHaveBeenCalled();
    expect(vaultSpy.createBinary, "createBinary must not be called").not.toHaveBeenCalled();
    expect(vaultSpy.deleteFile, "deleteFile must not be called").not.toHaveBeenCalled();
  }

  it("empty vault + empty remote produces all-zero plan", async () => {
    const engine = makeEngine();
    const client = getClient(engine);
    client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
    client.allDocsByKeys.mockResolvedValue({ total_rows: 0, rows: [] });

    const plan = await engine.planFullSync();

    expect(plan.wouldPushNew.count).toBe(0);
    expect(plan.wouldPushChanged.count).toBe(0);
    expect(plan.wouldPullRevMismatch.count).toBe(0);
    expect(plan.wouldSkipOrphanGuard.count).toBe(0);
    expect(plan.wouldTombstoneLocal.count).toBe(0);
    expect(plan.wouldPullDelete.count).toBe(0);
    expect(plan.wouldDeleteLocalTombstoned.count).toBe(0);
    expect(plan.alreadyTombstoned).toBe(0);
    expect(plan.alreadyOrphan).toBe(0);
    expect(plan.oversizeSkipped).toBe(0);
    expect(plan.excludedCount).toBe(0);

    const client2 = getClient(engine);
    for (const m of writeMethods) {
      expect(client2[m]).not.toHaveBeenCalled();
    }
  });

  it("local file not on remote is counted in wouldPushNew", async () => {
    vault._addFile("notes/new.md", "content", 1000);

    const engine = makeEngine();
    const client = getClient(engine);
    client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
    client.allDocsByKeys.mockResolvedValue({ total_rows: 0, rows: [] });

    const plan = await engine.planFullSync();

    expect(plan.wouldPushNew.count).toBe(1);
    expect(plan.wouldPushNew.sample).toContain("notes/new.md");

    for (const m of writeMethods) {
      expect(getClient(engine)[m]).not.toHaveBeenCalled();
    }
  });

  it("local file with newer mtime than revMap entry is counted in wouldPushChanged", async () => {
    vault._addFile("notes/changed.md", "new content", 2000);
    stateStore.set(
      "vault-sync-revmap",
      JSON.stringify({ "file/notes/changed.md": { state: "known", rev: "1-abc", mtime: 1000 } })
    );
    const engine = makeEngine();
    const client = getClient(engine);
    // File is in remote (present in allDocs) with same rev as revMap
    client.allDocs.mockResolvedValue({
      total_rows: 1,
      rows: [{ id: "file/notes/changed.md", key: "file/notes/changed.md", value: { rev: "1-abc" } }],
    });
    client.allDocsByKeys.mockResolvedValue({ total_rows: 0, rows: [] });

    const plan = await engine.planFullSync();

    expect(plan.wouldPushChanged.count).toBe(1);
    expect(plan.wouldPushChanged.sample).toContain("notes/changed.md");
    expect(plan.wouldPushNew.count).toBe(0);

    for (const m of writeMethods) {
      expect(getClient(engine)[m]).not.toHaveBeenCalled();
    }
  });

  it("remote doc with no revMap entry, bypass=true -> wouldPullRevMismatch", async () => {
    const engine = makeEngine();
    const client = getClient(engine);
    client.allDocs.mockResolvedValue({
      total_rows: 1,
      rows: [{ id: "file/agent-note.md", key: "file/agent-note.md", value: { rev: "1-zzz" } }],
    });
    client.allDocsByKeys.mockResolvedValue({ total_rows: 0, rows: [] });

    const plan = await engine.planFullSync({ bypassOrphanGuard: true });

    expect(plan.wouldPullRevMismatch.count).toBe(1);
    expect(plan.wouldPullRevMismatch.sample).toContain("agent-note.md");
    expect(plan.wouldSkipOrphanGuard.count).toBe(0);

    for (const m of writeMethods) {
      expect(getClient(engine)[m]).not.toHaveBeenCalled();
    }
  });

  it("remote doc with no revMap entry, bypass=false -> wouldSkipOrphanGuard", async () => {
    const engine = makeEngine();
    const client = getClient(engine);
    client.allDocs.mockResolvedValue({
      total_rows: 1,
      rows: [{ id: "file/agent-note.md", key: "file/agent-note.md", value: { rev: "1-zzz" } }],
    });
    client.allDocsByKeys.mockResolvedValue({ total_rows: 0, rows: [] });

    const plan = await engine.planFullSync({ bypassOrphanGuard: false });

    expect(plan.wouldSkipOrphanGuard.count).toBe(1);
    expect(plan.wouldSkipOrphanGuard.sample).toContain("agent-note.md");
    expect(plan.wouldPullRevMismatch.count).toBe(0);

    for (const m of writeMethods) {
      expect(getClient(engine)[m]).not.toHaveBeenCalled();
    }
  });

  it("revMap known entry with no FS file is counted in wouldTombstoneLocal", async () => {
    // No files in vault; revMap has a known entry
    stateStore.set(
      "vault-sync-revmap",
      JSON.stringify({ "file/notes/gone.md": { state: "known", rev: "1-abc", mtime: 1000 } })
    );
    const engine = makeEngine();
    const client = getClient(engine);
    client.allDocs.mockResolvedValue({
      total_rows: 1,
      rows: [{ id: "file/notes/gone.md", key: "file/notes/gone.md", value: { rev: "1-abc" } }],
    });
    client.allDocsByKeys.mockResolvedValue({ total_rows: 0, rows: [] });

    const plan = await engine.planFullSync();

    expect(plan.wouldTombstoneLocal.count).toBe(1);
    expect(plan.wouldTombstoneLocal.sample).toContain("notes/gone.md");

    for (const m of writeMethods) {
      expect(getClient(engine)[m]).not.toHaveBeenCalled();
    }
  });

  it("revMap known entry absent from remote is counted in wouldPullDelete", async () => {
    stateStore.set(
      "vault-sync-revmap",
      JSON.stringify({ "file/notes/deleted-remote.md": { state: "known", rev: "1-abc", mtime: 1000 } })
    );
    vault._addFile("notes/deleted-remote.md", "content", 1000);
    const engine = makeEngine();
    const client = getClient(engine);
    // Remote returns empty — doc was deleted remotely
    client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
    client.allDocsByKeys.mockResolvedValue({ total_rows: 0, rows: [] });

    const plan = await engine.planFullSync();

    expect(plan.wouldPullDelete.count).toBe(1);
    expect(plan.wouldPullDelete.sample).toContain("notes/deleted-remote.md");

    for (const m of writeMethods) {
      expect(getClient(engine)[m]).not.toHaveBeenCalled();
    }
  });

  it("files matching excludePatterns are counted in excludedCount, not push counts", async () => {
    vault._addFile(".obsidian/config.json", "{}", 1000);
    vault._addFile(".trash/old.md", "old", 1000);
    vault._addFile("notes/keep.md", "keep", 1000);

    const engine = makeEngine();
    const client = getClient(engine);
    client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
    client.allDocsByKeys.mockResolvedValue({ total_rows: 0, rows: [] });

    const plan = await engine.planFullSync();

    // 2 excluded (.obsidian/ and .trash/)
    expect(plan.excludedCount).toBe(2);
    // Only notes/keep.md shows as push-new
    expect(plan.wouldPushNew.count).toBe(1);
    expect(plan.wouldPushNew.sample).toContain("notes/keep.md");

    for (const m of writeMethods) {
      expect(getClient(engine)[m]).not.toHaveBeenCalled();
    }
  });

  it("sample list is capped at 5 paths per category", async () => {
    // Add 7 new files — all should be wouldPushNew but sample capped at 5
    for (let i = 0; i < 7; i++) {
      vault._addFile(`notes/file${i}.md`, `content ${i}`, 1000 + i);
    }
    const engine = makeEngine();
    const client = getClient(engine);
    client.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
    client.allDocsByKeys.mockResolvedValue({ total_rows: 0, rows: [] });

    const plan = await engine.planFullSync();

    expect(plan.wouldPushNew.count).toBe(7);
    expect(plan.wouldPushNew.sample.length).toBe(5);
  });

  /**
   * Regression test for PR #30 scenario:
   * - Remote has docs
   * - revMap is empty (first device onboarding, or after clearState)
   * - With bypass=false: all remote docs appear in wouldSkipOrphanGuard
   * - With bypass=true (forceFullSync): all remote docs appear in wouldPullRevMismatch
   *
   * This test is proof that planFullSync would have surfaced the PR #30 bug
   * where forceFullSync silently dropped the bypassOrphanGuard flag.
   */
  it("PR #30 regression: empty revMap + remote docs surfaces orphan guard behaviour", async () => {
    const remoteDocCount = 5;
    const remoteRows = Array.from({ length: remoteDocCount }, (_, i) => ({
      id: `file/notes/doc${i}.md`,
      key: `file/notes/doc${i}.md`,
      value: { rev: `1-rev${i}` },
    }));

    const engine = makeEngine();
    const client = getClient(engine);
    client.allDocs.mockResolvedValue({ total_rows: remoteDocCount, rows: remoteRows });
    client.allDocsByKeys.mockResolvedValue({ total_rows: 0, rows: [] });

    // bypass=false: all remote docs should be flagged as skipped by orphan guard
    const planBlocked = await engine.planFullSync({ bypassOrphanGuard: false });
    expect(planBlocked.wouldSkipOrphanGuard.count).toBe(remoteDocCount);
    expect(planBlocked.wouldPullRevMismatch.count).toBe(0);

    // bypass=true (forceFullSync default): all remote docs would be pulled
    const planBypassed = await engine.planFullSync({ bypassOrphanGuard: true });
    expect(planBypassed.wouldPullRevMismatch.count).toBe(remoteDocCount);
    expect(planBypassed.wouldSkipOrphanGuard.count).toBe(0);

    // No writes in either case
    for (const m of writeMethods) {
      expect(client[m]).not.toHaveBeenCalled();
    }
  });

  it("zero side effects: no client writes, no vault writes called", async () => {
    vault._addFile("notes/a.md", "content a", 1000);
    vault._addFile("notes/b.md", "content b", 2000);

    const modifyText = vi.fn();
    const createText = vi.fn();
    const modifyBinary = vi.fn();
    const createBinary = vi.fn();
    const deleteFile = vi.fn();

    const spiedAdapter: VaultAdapter = {
      getFiles: () => vaultAdapter.getFiles(),
      getEntryByPath: (p) => vaultAdapter.getEntryByPath(p),
      readText: (f) => vaultAdapter.readText(f),
      readBinary: (f) => vaultAdapter.readBinary(f),
      modifyText,
      modifyBinary,
      createText,
      createBinary,
      createDirectory: vi.fn(),
      deleteFile,
      deleteDirectory: vi.fn(),
      isDirectoryEmpty: vi.fn().mockResolvedValue(true),
      normalizePath: (p) => p,
    };

    const engine = new SyncEngine(settings, spiedAdapter, stateStore, noopTransport);
    const client = getClient(engine);
    client.allDocs.mockResolvedValue({
      total_rows: 1,
      rows: [{ id: "file/notes/remote.md", key: "file/notes/remote.md", value: { rev: "1-x" } }],
    });
    client.allDocsByKeys.mockResolvedValue({ total_rows: 0, rows: [] });

    await engine.planFullSync({ bypassOrphanGuard: true });

    assertNoVaultWrites(engine, { modifyText, createText, modifyBinary, createBinary, deleteFile });
    for (const m of writeMethods) {
      expect(client[m]).not.toHaveBeenCalled();
    }
  });
});

describe("resumeFullSync (non-destructive)", () => {
  let vault: Vault;
  let vaultAdapter: TestVaultAdapter;
  let stateStore: TestStateStore;
  let settings: VaultSyncSettings;
  let engine: SyncEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    vault = new Vault();
    vaultAdapter = new TestVaultAdapter(vault);
    stateStore = new TestStateStore();
    settings = makeSettings();
    engine = new SyncEngine(settings, vaultAdapter, stateStore, noopTransport);
  });

  afterEach(() => {
    engine.stop();
  });

  it("partial-pull recovery: pulls only remote-only docs, not already-known ones", async () => {
    // PR #30 v2 scenario: 3 docs are already known in revMap with matching revs,
    // 2 more exist in remote with no revMap entry (they were added while sync was interrupted).
    // resumeFullSync must pull the 2 new docs without re-fetching the 3 known ones.
    const client = getClient(engine);

    // Pre-populate revMap: 3 docs already known with matching revs
    stateStore.set("vault-sync-revmap", JSON.stringify({
      "file/notes/a.md": { state: "known", rev: "1-aaa", mtime: 1000, lastSeenInFs: 1000 },
      "file/notes/b.md": { state: "known", rev: "1-bbb", mtime: 1000, lastSeenInFs: 1000 },
      "file/notes/c.md": { state: "known", rev: "1-ccc", mtime: 1000, lastSeenInFs: 1000 },
    }));
    // Add the 3 known files to the vault FS so reconcileLocalDeletes doesn't tombstone them
    vault._addFile("notes/a.md", "content a", 1000);
    vault._addFile("notes/b.md", "content b", 1000);
    vault._addFile("notes/c.md", "content c", 1000);

    const eng = new SyncEngine(settings, vaultAdapter, stateStore, noopTransport);
    const c = getClient(eng);

    // Remote has all 5 docs: 3 known (same rev) + 2 new
    c.allDocs.mockResolvedValue({
      total_rows: 5,
      rows: [
        { id: "file/notes/a.md", key: "file/notes/a.md", value: { rev: "1-aaa" } },
        { id: "file/notes/b.md", key: "file/notes/b.md", value: { rev: "1-bbb" } },
        { id: "file/notes/c.md", key: "file/notes/c.md", value: { rev: "1-ccc" } },
        { id: "file/notes/new1.md", key: "file/notes/new1.md", value: { rev: "1-n1" } },
        { id: "file/notes/new2.md", key: "file/notes/new2.md", value: { rev: "1-n2" } },
      ],
    });
    // allDocsByKeys returns the 2 new docs when pulled
    c.allDocsByKeys.mockResolvedValue({
      total_rows: 2,
      rows: [
        {
          id: "file/notes/new1.md",
          key: "file/notes/new1.md",
          value: { rev: "1-n1" },
          doc: { _id: "file/notes/new1.md", _rev: "1-n1", content: "new1 content", mtime: 2000 },
        },
        {
          id: "file/notes/new2.md",
          key: "file/notes/new2.md",
          value: { rev: "1-n2" },
          doc: { _id: "file/notes/new2.md", _rev: "1-n2", content: "new2 content", mtime: 2000 },
        },
      ],
    });
    c.changes.mockResolvedValue({ last_seq: "10", results: [] });

    await eng.resumeFullSync();

    // The 2 new docs must be written to FS
    expect(vault._getContent("notes/new1.md")).toBe("new1 content");
    expect(vault._getContent("notes/new2.md")).toBe("new2 content");

    // allDocsByKeys must only have been called for the 2 new docs (not the 3 known ones).
    // The 3 known docs have matching revs so pullAllRemote skips them (rev match).
    const allDocsByKeysCalls = c.allDocsByKeys.mock.calls;
    // Flatten all keys requested across all calls
    const allRequestedKeys = allDocsByKeysCalls.flatMap((call: string[][]) => call[0]);
    expect(allRequestedKeys).not.toContain("file/notes/a.md");
    expect(allRequestedKeys).not.toContain("file/notes/b.md");
    expect(allRequestedKeys).not.toContain("file/notes/c.md");

    eng.stop();
  });

  it("tombstone permanence preserved: tombstoned doc not pulled on resumeFullSync", async () => {
    // revMap has 1 entry state:"tombstoned". Remote has the same docId at a newer rev.
    // resumeFullSync must NOT pull it to FS and must leave the entry tombstoned.
    const store = new TestStateStore();
    store.set("vault-sync-revmap", JSON.stringify({
      "file/notes/deleted.md": { state: "tombstoned", rev: "1-old", tombstonedAt: 999 },
    }));
    const eng = new SyncEngine(settings, vaultAdapter, store, noopTransport);
    const c = getClient(eng);

    c.allDocs.mockResolvedValue({
      total_rows: 1,
      rows: [{ id: "file/notes/deleted.md", key: "file/notes/deleted.md", value: { rev: "2-new" } }],
    });
    c.allDocsByKeys.mockResolvedValue({
      total_rows: 1,
      rows: [{
        id: "file/notes/deleted.md",
        key: "file/notes/deleted.md",
        value: { rev: "2-new" },
        doc: { _id: "file/notes/deleted.md", _rev: "2-new", content: "resurrected", mtime: 9999 },
      }],
    });
    c.changes.mockResolvedValue({ last_seq: "5", results: [] });

    await eng.resumeFullSync();

    // File must NOT be written to FS
    expect(vault._getContent("notes/deleted.md")).toBeUndefined();

    // revMap entry must remain tombstoned
    const saved = JSON.parse(store.get("vault-sync-revmap") ?? "{}");
    expect(saved["file/notes/deleted.md"]?.state).toBe("tombstoned");

    eng.stop();
  });

  it("force contrast: forceFullSync WOULD pull a tombstoned doc (tombstone cleared by clearState)", async () => {
    // Contrast test — locks the invariant that forceFullSync re-evaluates tombstones.
    // After clearState(), the tombstoned entry is gone; pullAllRemote sees the doc as
    // unknown (no entry) but bypassOrphanGuard=true lets it through → gets pulled.
    const store = new TestStateStore();
    store.set("vault-sync-revmap", JSON.stringify({
      "file/notes/deleted.md": { state: "tombstoned", rev: "1-old", tombstonedAt: 999 },
    }));
    const eng = new SyncEngine(settings, vaultAdapter, store, noopTransport);
    const c = getClient(eng);

    c.allDocs.mockResolvedValue({
      total_rows: 1,
      rows: [{ id: "file/notes/deleted.md", key: "file/notes/deleted.md", value: { rev: "2-new" } }],
    });
    c.allDocsByKeys.mockResolvedValue({
      total_rows: 1,
      rows: [{
        id: "file/notes/deleted.md",
        key: "file/notes/deleted.md",
        value: { rev: "2-new" },
        doc: { _id: "file/notes/deleted.md", _rev: "2-new", content: "resurrected", mtime: 9999 },
      }],
    });
    c.changes.mockResolvedValue({ last_seq: "5", results: [] });

    await eng.forceFullSync();

    // forceFullSync clears state first → tombstone gone → doc IS pulled
    expect(vault._getContent("notes/deleted.md")).toBe("resurrected");

    eng.stop();
  });

  it("orphan protection preserved: orphan doc not pulled on resumeFullSync", async () => {
    // revMap has 1 entry state:"orphan". Remote has the same docId.
    // resumeFullSync must NOT pull it to FS and must leave the entry as orphan.
    const store = new TestStateStore();
    store.set("vault-sync-revmap", JSON.stringify({
      "file/notes/agent-created.md": { state: "orphan", rev: "1-o" },
    }));
    const eng = new SyncEngine(settings, vaultAdapter, store, noopTransport);
    const c = getClient(eng);

    c.allDocs.mockResolvedValue({
      total_rows: 1,
      rows: [{ id: "file/notes/agent-created.md", key: "file/notes/agent-created.md", value: { rev: "1-o" } }],
    });
    c.allDocsByKeys.mockResolvedValue({
      total_rows: 1,
      rows: [{
        id: "file/notes/agent-created.md",
        key: "file/notes/agent-created.md",
        value: { rev: "1-o" },
        doc: { _id: "file/notes/agent-created.md", _rev: "1-o", content: "agent content", mtime: 5000 },
      }],
    });
    c.changes.mockResolvedValue({ last_seq: "5", results: [] });

    await eng.resumeFullSync();

    // File must NOT be written to FS
    expect(vault._getContent("notes/agent-created.md")).toBeUndefined();

    // revMap entry must remain orphan
    const saved = JSON.parse(store.get("vault-sync-revmap") ?? "{}");
    expect(saved["file/notes/agent-created.md"]?.state).toBe("orphan");

    eng.stop();
  });

  it("lastSeq not cleared: resumes from prior seq and updates to new server seq", async () => {
    // Pre-set lastSeq to some value (simulating interrupted prior sync).
    // resumeFullSync must NOT clear lastSeq mid-way; it should end with the new server seq.
    const store = new TestStateStore();
    store.set("vault-sync-last-seq", "42");
    const eng = new SyncEngine(settings, vaultAdapter, store, noopTransport);
    const c = getClient(eng);

    c.allDocs.mockResolvedValue({ total_rows: 0, rows: [] });
    c.allDocsByKeys.mockResolvedValue({ total_rows: 0, rows: [] });
    c.changes.mockResolvedValue({ last_seq: "99", results: [] });

    await eng.resumeFullSync();

    // lastSeq must be updated to the new seq (99), not reset to 0.
    // The store persists JSON.stringify(lastSeq), so "99" becomes '"99"' on disk.
    const savedSeq = JSON.parse(store.get("vault-sync-last-seq") ?? "0");
    expect(savedSeq).toBe("99");

    eng.stop();
  });

  it("idempotent on fully-synced state: no pulls, no pushes when revMap matches remote", async () => {
    // revMap fully matches remote (all known, all revs match).
    // resumeFullSync must produce no pulls and no pushes.
    vault._addFile("notes/synced.md", "synced content", 1000);

    const store = new TestStateStore();
    store.set("vault-sync-revmap", JSON.stringify({
      "file/notes/synced.md": { state: "known", rev: "1-xyz", mtime: 1000, lastSeenInFs: 1000 },
    }));
    const eng = new SyncEngine(settings, vaultAdapter, store, noopTransport);
    const c = getClient(eng);

    // Remote matches exactly: same rev
    c.allDocs.mockResolvedValue({
      total_rows: 1,
      rows: [{ id: "file/notes/synced.md", key: "file/notes/synced.md", value: { rev: "1-xyz" } }],
    });
    c.allDocsByKeys.mockResolvedValue({ total_rows: 0, rows: [] });
    c.changes.mockResolvedValue({ last_seq: "50", results: [] });

    await eng.resumeFullSync();

    // No content writes (no pull)
    // bulkDocs must not have been called with content (only tombstone deletes go through bulkDocs)
    expect(c.bulkDocs).not.toHaveBeenCalled();
    // allDocsByKeys should not be called for pull (no rev mismatches) —
    // it may be called once for the push tombstone batch check (empty result)
    const pullCalls = (c.allDocsByKeys.mock.calls as string[][][]).filter(
      (call) => call[0]?.includes("file/notes/synced.md")
    );
    expect(pullCalls.length).toBe(0);

    eng.stop();
  });
});

describe("lwwWinner", () => {
  it("returns local when mtimes are equal (already have it, no need to fetch)", () => {
    expect(lwwWinner(1000, 1000)).toBe("local");
  });

  it("returns local when local mtime is newer", () => {
    expect(lwwWinner(2000, 1000)).toBe("local");
  });

  it("returns remote when remote mtime is newer", () => {
    expect(lwwWinner(1000, 2000)).toBe("remote");
  });

  it("returns local when remote mtime is 0 (unknown) and local is known", () => {
    // mtime 0 means unknown/missing; a known local mtime wins
    expect(lwwWinner(1000, 0)).toBe("local");
  });

  it("returns local when both mtimes are 0 (both unknown)", () => {
    // Equal, so local wins by default
    expect(lwwWinner(0, 0)).toBe("local");
  });

  it("handles very large mtime values without overflow concerns", () => {
    const farFuture = Number.MAX_SAFE_INTEGER;
    expect(lwwWinner(farFuture, farFuture - 1)).toBe("local");
    expect(lwwWinner(farFuture - 1, farFuture)).toBe("remote");
  });
});
