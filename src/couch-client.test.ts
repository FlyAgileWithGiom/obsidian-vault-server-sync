import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CouchClient, CouchError } from "./couch-client";
import type { VaultSyncSettings } from "./types";

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

// Helper to create mock fetch responses
function mockFetchOk(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: true,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function mockFetchError(status: number, body = ""): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(body),
  });
}

describe("CouchClient", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("constructor", () => {
    it("builds base URL from settings", () => {
      const client = new CouchClient(makeSettings());
      // Verify by calling ping which uses baseUrl
      globalThis.fetch = mockFetchOk({ db_name: "test-vault" });
      client.ping();
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("https://couch.example.com/test-vault"),
        expect.anything()
      );
    });

    it("strips trailing slashes from URL", () => {
      const client = new CouchClient(makeSettings({ couchDbUrl: "https://couch.example.com///" }));
      globalThis.fetch = mockFetchOk({ db_name: "test-vault" });
      client.ping();
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("https://couch.example.com/test-vault"),
        expect.anything()
      );
    });

    it("sets Basic auth header when credentials provided", () => {
      const client = new CouchClient(makeSettings());
      globalThis.fetch = mockFetchOk({ db_name: "test-vault" });
      client.ping();
      const callHeaders = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
      const expectedCreds = btoa("admin:secret");
      expect(callHeaders["Authorization"]).toBe(`Basic ${expectedCreds}`);
    });

    it("omits auth header when no credentials", () => {
      const client = new CouchClient(makeSettings({ couchDbUser: "", couchDbPassword: "" }));
      globalThis.fetch = mockFetchOk({ db_name: "test-vault" });
      client.ping();
      const callHeaders = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
      expect(callHeaders["Authorization"]).toBeUndefined();
    });
  });

  describe("isConfigured", () => {
    it("returns true when URL and DB name are set", () => {
      const client = new CouchClient(makeSettings());
      expect(client.isConfigured()).toBe(true);
    });

    it("returns false when URL is empty", () => {
      const client = new CouchClient(makeSettings({ couchDbUrl: "" }));
      expect(client.isConfigured()).toBe(false);
    });

    it("returns false when DB name is empty", () => {
      const client = new CouchClient(makeSettings({ couchDbName: "" }));
      expect(client.isConfigured()).toBe(false);
    });
  });

  describe("ping", () => {
    it("returns true when DB is reachable", async () => {
      globalThis.fetch = mockFetchOk({ db_name: "test-vault" });
      const client = new CouchClient(makeSettings());
      expect(await client.ping()).toBe(true);
    });

    it("returns false when DB is unreachable", async () => {
      globalThis.fetch = mockFetchError(500, "Internal Server Error");
      const client = new CouchClient(makeSettings());
      expect(await client.ping()).toBe(false);
    });

    it("returns false on network error", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));
      const client = new CouchClient(makeSettings());
      expect(await client.ping()).toBe(false);
    });
  });

  describe("ensureDb", () => {
    it("does nothing when DB already exists", async () => {
      globalThis.fetch = mockFetchOk({ db_name: "test-vault" });
      const client = new CouchClient(makeSettings());
      await expect(client.ensureDb()).resolves.toBeUndefined();
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it("creates DB when 404 returned", async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First call: GET db returns 404
          return Promise.resolve({
            ok: false,
            status: 404,
            text: () => Promise.resolve("not found"),
          });
        }
        // Second call: PUT to create db
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve({ ok: true }),
        });
      });

      const client = new CouchClient(makeSettings());
      await client.ensureDb();

      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      const secondCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[1];
      expect(secondCall[1].method).toBe("PUT");
    });

    it("throws on non-404 errors", async () => {
      globalThis.fetch = mockFetchError(500, "Internal Server Error");
      const client = new CouchClient(makeSettings());
      await expect(client.ensureDb()).rejects.toThrow(CouchError);
    });
  });

  describe("get", () => {
    it("fetches document by ID", async () => {
      const doc = { _id: "notes/hello.md", _rev: "1-abc", content: "hello", mtime: 1000 };
      globalThis.fetch = mockFetchOk(doc);
      const client = new CouchClient(makeSettings());
      const result = await client.get("notes/hello.md");
      expect(result).toEqual(doc);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/notes%2Fhello.md"),
        expect.anything()
      );
    });

    it("throws CouchError on 404", async () => {
      globalThis.fetch = mockFetchError(404, "not found");
      const client = new CouchClient(makeSettings());
      await expect(client.get("missing.md")).rejects.toThrow(CouchError);
      await expect(client.get("missing.md")).rejects.toThrow(/404/);
    });
  });

  describe("put", () => {
    it("sends PUT with document body", async () => {
      const result = { ok: true, id: "test.md", rev: "1-abc" };
      globalThis.fetch = mockFetchOk(result);
      const client = new CouchClient(makeSettings());

      const doc = { _id: "test.md", content: "hello", mtime: 1000 };
      const res = await client.put(doc);

      expect(res).toEqual(result);
      const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain("/test.md");
      expect(opts.method).toBe("PUT");
      expect(JSON.parse(opts.body)).toEqual(doc);
    });
  });

  describe("delete", () => {
    it("sends DELETE with rev as query param", async () => {
      globalThis.fetch = mockFetchOk({ ok: true, id: "test.md", rev: "2-def" });
      const client = new CouchClient(makeSettings());

      await client.delete("test.md", "1-abc");

      const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain("rev=1-abc");
      expect(opts.method).toBe("DELETE");
    });
  });

  describe("allDocs", () => {
    it("fetches all docs with default params", async () => {
      const response = { total_rows: 0, rows: [] };
      globalThis.fetch = mockFetchOk(response);
      const client = new CouchClient(makeSettings());

      const result = await client.allDocs();
      expect(result).toEqual(response);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/_all_docs"),
        expect.anything()
      );
    });

    it("passes query params correctly", async () => {
      globalThis.fetch = mockFetchOk({ total_rows: 0, rows: [] });
      const client = new CouchClient(makeSettings());

      await client.allDocs({ startkey: "file/", endkey: "file/\uffff", include_docs: true, limit: 10 });

      const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toContain("include_docs=true");
      expect(url).toContain("limit=10");
      expect(url).toContain("startkey=");
      expect(url).toContain("endkey=");
    });
  });

  describe("bulkDocs", () => {
    it("sends POST with docs array wrapped in { docs }", async () => {
      const results = [{ ok: true, id: "a.md", rev: "1-x" }];
      globalThis.fetch = mockFetchOk(results);
      const client = new CouchClient(makeSettings());

      const docs = [{ _id: "a.md", content: "a", mtime: 1 }];
      const res = await client.bulkDocs(docs);

      expect(res).toEqual(results);
      const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body).toEqual({ docs });
    });
  });

  describe("changes", () => {
    it("sends long-poll request with since parameter", async () => {
      const response = { last_seq: "5", results: [] };
      globalThis.fetch = mockFetchOk(response);
      const client = new CouchClient(makeSettings());

      const result = await client.changes("3");

      expect(result).toEqual(response);
      const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toContain("since=3");
      expect(url).toContain("feed=longpoll");
      expect(url).toContain("include_docs=true");
    });

    it("uses custom timeout", async () => {
      globalThis.fetch = mockFetchOk({ last_seq: "0", results: [] });
      const client = new CouchClient(makeSettings());

      await client.changes(0, { timeout: 10000 });

      const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toContain("timeout=10000");
    });

    it("passes abort signal for cancellation", async () => {
      globalThis.fetch = mockFetchOk({ last_seq: "0", results: [] });
      const client = new CouchClient(makeSettings());

      await client.changes(0);

      const opts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(opts.signal).toBeInstanceOf(AbortSignal);
    });

    it("throws CouchError on HTTP error", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve("Server Error"),
      });
      const client = new CouchClient(makeSettings());
      await expect(client.changes(0)).rejects.toThrow(CouchError);
    });
  });

  describe("cancelChanges", () => {
    it("aborts the in-flight request", async () => {
      // Set up a fetch that never resolves so we can cancel it
      let capturedSignal: AbortSignal | undefined;
      globalThis.fetch = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
        capturedSignal = opts.signal as AbortSignal;
        return new Promise(() => {}); // Never resolves
      });

      const client = new CouchClient(makeSettings());
      // Start a changes request but don't await
      client.changes(0).catch(() => {});

      // Give the promise a tick
      await new Promise((r) => setTimeout(r, 10));

      expect(capturedSignal).toBeDefined();
      expect(capturedSignal!.aborted).toBe(false);

      client.cancelChanges();

      expect(capturedSignal!.aborted).toBe(true);
    });

    it("is safe to call when no request is in flight", () => {
      const client = new CouchClient(makeSettings());
      expect(() => client.cancelChanges()).not.toThrow();
    });
  });

  describe("updateSettings", () => {
    it("updates base URL and auth headers", async () => {
      const client = new CouchClient(makeSettings());

      client.updateSettings(makeSettings({
        couchDbUrl: "https://new-host.com",
        couchDbName: "new-db",
        couchDbUser: "newuser",
        couchDbPassword: "newpass",
      }));

      globalThis.fetch = mockFetchOk({ db_name: "new-db" });
      await client.ping();

      const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain("https://new-host.com/new-db");
      expect(opts.headers["Authorization"]).toBe(`Basic ${btoa("newuser:newpass")}`);
    });
  });

  describe("CouchError", () => {
    it("preserves status code and message", () => {
      const error = new CouchError(409, "Conflict");
      expect(error.status).toBe(409);
      expect(error.message).toBe("Conflict");
      expect(error.name).toBe("CouchError");
      expect(error).toBeInstanceOf(Error);
    });
  });
});
