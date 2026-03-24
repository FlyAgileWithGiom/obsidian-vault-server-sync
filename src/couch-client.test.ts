import { describe, it, expect, vi, beforeEach } from "vitest";
import { CouchClient, CouchError } from "./couch-client";
import type { VaultSyncSettings } from "./types";

// Mock the obsidian module's requestUrl
vi.mock("obsidian", () => ({
  requestUrl: vi.fn(),
}));

import { requestUrl as mockedRequestUrl } from "obsidian";
const mockRequestUrl = vi.mocked(mockedRequestUrl);

function makeSettings(overrides: Partial<VaultSyncSettings> = {}): VaultSyncSettings {
  return {
    couchDbUrl: "https://couch.example.com",
    couchDbName: "test-vault",
    couchDbUser: "admin",
    couchDbPassword: "secret",
    syncDebounceMs: 500,
    excludePatterns: [],
    ...overrides,
  };
}

function mockOk(body: unknown): void {
  mockRequestUrl.mockResolvedValue({ status: 200, json: body, text: JSON.stringify(body), headers: {}, arrayBuffer: new ArrayBuffer(0) } as any);
}

function mockError(status: number, body = ""): void {
  mockRequestUrl.mockResolvedValue({ status, json: {}, text: body, headers: {}, arrayBuffer: new ArrayBuffer(0) } as any);
}

describe("CouchClient", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("constructor", () => {
    it("builds base URL from settings", async () => {
      mockOk({ db_name: "test-vault" });
      const client = new CouchClient(makeSettings());
      await client.ping();
      expect(mockRequestUrl).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining("https://couch.example.com/test-vault") }));
    });

    it("strips trailing slashes from URL", async () => {
      mockOk({ db_name: "test-vault" });
      const client = new CouchClient(makeSettings({ couchDbUrl: "https://couch.example.com///" }));
      await client.ping();
      expect(mockRequestUrl).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining("https://couch.example.com/test-vault") }));
    });

    it("sets Basic auth header when credentials provided", async () => {
      mockOk({ db_name: "test-vault" });
      await new CouchClient(makeSettings()).ping();
      expect(mockRequestUrl.mock.calls[0][0].headers?.["Authorization"]).toBe(`Basic ${btoa("admin:secret")}`);
    });

    it("omits auth header when no credentials", async () => {
      mockOk({ db_name: "test-vault" });
      await new CouchClient(makeSettings({ couchDbUser: "", couchDbPassword: "" })).ping();
      expect(mockRequestUrl.mock.calls[0][0].headers?.["Authorization"]).toBeUndefined();
    });
  });

  describe("isConfigured", () => {
    it("returns true when URL and DB name are set", () => {
      expect(new CouchClient(makeSettings()).isConfigured()).toBe(true);
    });
    it("returns false when URL is empty", () => {
      expect(new CouchClient(makeSettings({ couchDbUrl: "" })).isConfigured()).toBe(false);
    });
    it("returns false when DB name is empty", () => {
      expect(new CouchClient(makeSettings({ couchDbName: "" })).isConfigured()).toBe(false);
    });
  });

  describe("ping", () => {
    it("returns true when DB is reachable", async () => {
      mockOk({ db_name: "test-vault" });
      expect(await new CouchClient(makeSettings()).ping()).toBe(true);
    });
    it("returns false when DB is unreachable", async () => {
      mockError(500);
      expect(await new CouchClient(makeSettings()).ping()).toBe(false);
    });
    it("returns false on network error", async () => {
      mockRequestUrl.mockRejectedValue(new Error("Network error"));
      expect(await new CouchClient(makeSettings()).ping()).toBe(false);
    });
  });

  describe("ensureDb", () => {
    it("does nothing when DB already exists", async () => {
      mockOk({ db_name: "test-vault" });
      await expect(new CouchClient(makeSettings()).ensureDb()).resolves.toBeUndefined();
      expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    });
    it("creates DB when 404 returned", async () => {
      mockRequestUrl
        .mockResolvedValueOnce({ status: 404, json: {}, text: "not found", headers: {}, arrayBuffer: new ArrayBuffer(0) } as any)
        .mockResolvedValueOnce({ status: 201, json: { ok: true }, text: "", headers: {}, arrayBuffer: new ArrayBuffer(0) } as any);
      await new CouchClient(makeSettings()).ensureDb();
      expect(mockRequestUrl).toHaveBeenCalledTimes(2);
      expect(mockRequestUrl.mock.calls[1][0].method).toBe("PUT");
    });
    it("throws on non-404 errors", async () => {
      mockError(500);
      await expect(new CouchClient(makeSettings()).ensureDb()).rejects.toThrow(CouchError);
    });
  });

  describe("get", () => {
    it("fetches document by ID", async () => {
      const doc = { _id: "notes/hello.md", _rev: "1-abc", content: "hello", mtime: 1000 };
      mockOk(doc);
      expect(await new CouchClient(makeSettings()).get("notes/hello.md")).toEqual(doc);
      expect(mockRequestUrl).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining("/notes%2Fhello.md") }));
    });
    it("throws CouchError on 404", async () => {
      mockError(404);
      await expect(new CouchClient(makeSettings()).get("missing.md")).rejects.toThrow(CouchError);
    });
  });

  describe("put", () => {
    it("sends PUT with document body", async () => {
      mockOk({ ok: true, id: "test.md", rev: "1-abc" });
      const doc = { _id: "test.md", content: "hello", mtime: 1000 };
      await new CouchClient(makeSettings()).put(doc);
      const call = mockRequestUrl.mock.calls[0][0];
      expect(call.method).toBe("PUT");
      expect(JSON.parse(call.body!)).toEqual(doc);
    });
  });

  describe("delete", () => {
    it("sends DELETE with rev as query param", async () => {
      mockOk({ ok: true, id: "test.md", rev: "2-def" });
      await new CouchClient(makeSettings()).delete("test.md", "1-abc");
      const call = mockRequestUrl.mock.calls[0][0];
      expect(call.url).toContain("rev=1-abc");
      expect(call.method).toBe("DELETE");
    });
  });

  describe("allDocs", () => {
    it("fetches all docs with default params", async () => {
      mockOk({ total_rows: 0, rows: [] });
      await new CouchClient(makeSettings()).allDocs();
      expect(mockRequestUrl).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining("/_all_docs") }));
    });
    it("passes query params correctly", async () => {
      mockOk({ total_rows: 0, rows: [] });
      await new CouchClient(makeSettings()).allDocs({ startkey: "file/", endkey: "file/\uffff", include_docs: true, limit: 10 });
      const url = mockRequestUrl.mock.calls[0][0].url;
      expect(url).toContain("include_docs=true");
      expect(url).toContain("limit=10");
    });
  });

  describe("bulkDocs", () => {
    it("sends POST with docs wrapped in { docs }", async () => {
      mockOk([{ ok: true, id: "a.md", rev: "1-x" }]);
      const docs = [{ _id: "a.md", content: "a", mtime: 1 }];
      await new CouchClient(makeSettings()).bulkDocs(docs);
      expect(JSON.parse(mockRequestUrl.mock.calls[0][0].body!)).toEqual({ docs });
    });
  });

  describe("updateSettings", () => {
    it("updates base URL and auth headers", async () => {
      const client = new CouchClient(makeSettings());
      client.updateSettings(makeSettings({ couchDbUrl: "https://new-host.com", couchDbName: "new-db", couchDbUser: "newuser", couchDbPassword: "newpass" }));
      mockOk({ db_name: "new-db" });
      await client.ping();
      const call = mockRequestUrl.mock.calls[0][0];
      expect(call.url).toContain("https://new-host.com/new-db");
      expect(call.headers?.["Authorization"]).toBe(`Basic ${btoa("newuser:newpass")}`);
    });
  });

  describe("CouchError", () => {
    it("preserves status code and message", () => {
      const error = new CouchError(409, "Conflict");
      expect(error.status).toBe(409);
      expect(error.message).toBe("Conflict");
      expect(error).toBeInstanceOf(Error);
    });
  });
});
