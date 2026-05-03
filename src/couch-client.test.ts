import { describe, it, expect, vi, beforeEach } from "vitest";
import { CouchClient, CouchError } from "./couch-client";
import type { VaultSyncSettings, HttpTransport, HttpResponse } from "./types";

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

function makeTransport(status = 200, body: unknown = {}, arrayBuffer = new ArrayBuffer(0)): {
  transport: HttpTransport;
  mock: ReturnType<typeof vi.fn>;
} {
  const bodyText = typeof body === "string" ? body : JSON.stringify(body);
  const response: HttpResponse = {
    status,
    text: async () => bodyText,
    json: async <T>() => body as T,
    arrayBuffer: async () => arrayBuffer,
  };
  const mock = vi.fn().mockResolvedValue(response);
  const transport: HttpTransport = { request: mock };
  return { transport, mock };
}

describe("CouchClient", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("constructor", () => {
    it("builds base URL from settings", async () => {
      const { transport, mock } = makeTransport(200, { db_name: "test-vault" });
      const client = new CouchClient(makeSettings(), transport);
      await client.ping();
      expect(mock).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining("https://couch.example.com/test-vault") }));
    });

    it("strips trailing slashes from URL", async () => {
      const { transport, mock } = makeTransport(200, { db_name: "test-vault" });
      const client = new CouchClient(makeSettings({ couchDbUrl: "https://couch.example.com///" }), transport);
      await client.ping();
      expect(mock).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining("https://couch.example.com/test-vault") }));
    });

    it("sets Basic auth header when credentials provided", async () => {
      const { transport, mock } = makeTransport(200, { db_name: "test-vault" });
      await new CouchClient(makeSettings(), transport).ping();
      expect(mock.mock.calls[0][0].headers?.["Authorization"]).toBe(`Basic ${btoa("admin:secret")}`);
    });

    it("omits auth header when no credentials", async () => {
      const { transport, mock } = makeTransport(200, { db_name: "test-vault" });
      await new CouchClient(makeSettings({ couchDbUser: "", couchDbPassword: "" }), transport).ping();
      expect(mock.mock.calls[0][0].headers?.["Authorization"]).toBeUndefined();
    });
  });

  describe("isConfigured", () => {
    it("returns true when URL and DB name are set", () => {
      const { transport } = makeTransport();
      expect(new CouchClient(makeSettings(), transport).isConfigured()).toBe(true);
    });
    it("returns false when URL is empty", () => {
      const { transport } = makeTransport();
      expect(new CouchClient(makeSettings({ couchDbUrl: "" }), transport).isConfigured()).toBe(false);
    });
    it("returns false when DB name is empty", () => {
      const { transport } = makeTransport();
      expect(new CouchClient(makeSettings({ couchDbName: "" }), transport).isConfigured()).toBe(false);
    });
  });

  describe("ping", () => {
    it("returns true when DB is reachable", async () => {
      const { transport } = makeTransport(200, { db_name: "test-vault" });
      expect(await new CouchClient(makeSettings(), transport).ping()).toBe(true);
    });
    it("returns false when DB is unreachable", async () => {
      const { transport } = makeTransport(500);
      expect(await new CouchClient(makeSettings(), transport).ping()).toBe(false);
    });
    it("returns false on network error", async () => {
      const transport: HttpTransport = { request: vi.fn().mockRejectedValue(new Error("Network error")) };
      expect(await new CouchClient(makeSettings(), transport).ping()).toBe(false);
    });
  });

  describe("ensureDb", () => {
    it("does nothing when DB already exists", async () => {
      const { transport, mock } = makeTransport(200, { db_name: "test-vault" });
      await expect(new CouchClient(makeSettings(), transport).ensureDb()).resolves.toBeUndefined();
      expect(mock).toHaveBeenCalledTimes(1);
    });
    it("creates DB when 404 returned", async () => {
      const mock = vi.fn()
        .mockResolvedValueOnce({ status: 404, text: async () => "not found", json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) } as HttpResponse)
        .mockResolvedValueOnce({ status: 201, text: async () => "", json: async () => ({ ok: true }), arrayBuffer: async () => new ArrayBuffer(0) } as HttpResponse);
      const transport: HttpTransport = { request: mock };
      await new CouchClient(makeSettings(), transport).ensureDb();
      expect(mock).toHaveBeenCalledTimes(2);
      expect(mock.mock.calls[1][0].method).toBe("PUT");
    });
    it("throws on non-404 errors", async () => {
      const { transport } = makeTransport(500);
      await expect(new CouchClient(makeSettings(), transport).ensureDb()).rejects.toThrow(CouchError);
    });
  });

  describe("get", () => {
    it("fetches document by ID", async () => {
      const doc = { _id: "notes/hello.md", _rev: "1-abc", content: "hello", mtime: 1000 };
      const { transport, mock } = makeTransport(200, doc);
      expect(await new CouchClient(makeSettings(), transport).get("notes/hello.md")).toEqual(doc);
      expect(mock).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining("/notes%2Fhello.md") }));
    });
    it("throws CouchError on 404", async () => {
      const { transport } = makeTransport(404);
      await expect(new CouchClient(makeSettings(), transport).get("missing.md")).rejects.toThrow(CouchError);
    });
  });

  describe("put", () => {
    it("sends PUT with document body", async () => {
      const { transport, mock } = makeTransport(200, { ok: true, id: "test.md", rev: "1-abc" });
      const doc = { _id: "test.md", content: "hello", mtime: 1000 };
      await new CouchClient(makeSettings(), transport).put(doc);
      const call = mock.mock.calls[0][0];
      expect(call.method).toBe("PUT");
      expect(JSON.parse(call.body!)).toEqual(doc);
    });
  });

  describe("delete", () => {
    it("sends DELETE with rev as query param", async () => {
      const { transport, mock } = makeTransport(200, { ok: true, id: "test.md", rev: "2-def" });
      await new CouchClient(makeSettings(), transport).delete("test.md", "1-abc");
      const call = mock.mock.calls[0][0];
      expect(call.url).toContain("rev=1-abc");
      expect(call.method).toBe("DELETE");
    });
  });

  describe("allDocs", () => {
    it("fetches all docs with default params", async () => {
      const { transport, mock } = makeTransport(200, { total_rows: 0, rows: [] });
      await new CouchClient(makeSettings(), transport).allDocs();
      expect(mock).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining("/_all_docs") }));
    });
    it("passes query params correctly", async () => {
      const { transport, mock } = makeTransport(200, { total_rows: 0, rows: [] });
      await new CouchClient(makeSettings(), transport).allDocs({ startkey: "file/", endkey: "file/￿", include_docs: true, limit: 10 });
      const url = mock.mock.calls[0][0].url;
      expect(url).toContain("include_docs=true");
      expect(url).toContain("limit=10");
    });
  });

  describe("bulkDocs", () => {
    it("sends POST with docs wrapped in { docs }", async () => {
      const { transport, mock } = makeTransport(200, [{ ok: true, id: "a.md", rev: "1-x" }]);
      const docs = [{ _id: "a.md", content: "a", mtime: 1 }];
      await new CouchClient(makeSettings(), transport).bulkDocs(docs);
      expect(JSON.parse(mock.mock.calls[0][0].body!)).toEqual({ docs });
    });
  });

  describe("updateSettings", () => {
    it("updates base URL and auth headers", async () => {
      const { transport, mock } = makeTransport(200, { db_name: "new-db" });
      const client = new CouchClient(makeSettings(), transport);
      client.updateSettings(makeSettings({ couchDbUrl: "https://new-host.com", couchDbName: "new-db", couchDbUser: "newuser", couchDbPassword: "newpass" }));
      await client.ping();
      const call = mock.mock.calls[0][0];
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

  describe("getAttachment", () => {
    it("fetches attachment as ArrayBuffer", async () => {
      const buf = new ArrayBuffer(4);
      const { transport, mock } = makeTransport(200, {}, buf);
      const client = new CouchClient(makeSettings(), transport);
      const result = await client.getAttachment("file/image.png", "data");
      expect(result).toBe(buf);
      const call = mock.mock.calls[0][0];
      expect(call.url).toContain("/file%2Fimage.png/data");
      expect(call.method).toBe("GET");
    });

    it("sends auth header in attachment GET", async () => {
      const { transport, mock } = makeTransport(200, {}, new ArrayBuffer(0));
      await new CouchClient(makeSettings(), transport).getAttachment("file/a.png", "data");
      expect(mock.mock.calls[0][0].headers?.["Authorization"]).toBe(`Basic ${btoa("admin:secret")}`);
    });

    it("throws CouchError on 404", async () => {
      const { transport } = makeTransport(404, "not found");
      await expect(new CouchClient(makeSettings(), transport).getAttachment("file/missing.png", "data")).rejects.toThrow(CouchError);
    });
  });

  describe("putAttachment", () => {
    it("PUTs attachment with correct URL, Content-Type, and body", async () => {
      const { transport, mock } = makeTransport(200, { ok: true, id: "file/image.png", rev: "2-xyz" });
      const data = new ArrayBuffer(8);
      const client = new CouchClient(makeSettings(), transport);
      const result = await client.putAttachment("file/image.png", "data", "1-abc", data, "image/png");
      expect(result).toEqual({ ok: true, id: "file/image.png", rev: "2-xyz" });
      const call = mock.mock.calls[0][0];
      expect(call.url).toContain("/file%2Fimage.png/data");
      expect(call.url).toContain("rev=1-abc");
      expect(call.method).toBe("PUT");
      expect(call.headers?.["Content-Type"]).toBe("image/png");
      expect(call.body).toBe(data);
    });

    it("throws CouchError on 409 conflict", async () => {
      const { transport } = makeTransport(409, "conflict");
      const data = new ArrayBuffer(0);
      await expect(new CouchClient(makeSettings(), transport).putAttachment("file/img.png", "data", "1-abc", data, "image/png")).rejects.toThrow(CouchError);
    });
  });
});
