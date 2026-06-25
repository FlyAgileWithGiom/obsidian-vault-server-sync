/**
 * Tests for the requestUrl-backed fetch adapter (obsidian-fetch.ts).
 *
 * Why this adapter exists:
 * - On iOS Obsidian, the webview enforces CORS on all fetch() calls.
 * - The gateway's /register and /token endpoints return no CORS headers
 *   (they sit before the CORS middleware), so every gateway call fails
 *   with a CORS error on iOS.
 * - Obsidian's requestUrl() bypasses the webview CORS enforcement.
 * - This adapter wraps requestUrl() in a fetch-compatible signature so
 *   it can be injected into TokenManagerOpts.fetch, startPluginLogin.fetch,
 *   and completePluginLogin.fetch without changing any of those modules.
 *
 * Plugin-only constraint:
 * - This module imports from "obsidian" and MUST NOT be imported from
 *   headless/** daemon modules (Node has no "obsidian" module).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeObsidianFetch } from "./obsidian-fetch";

// The adapter module imports requestUrl from "obsidian" — aliased to the mock
// by vitest.config.ts. We override it with a vi.fn() so tests can control its
// return value per-test. The factory function must be inside vi.mock() to avoid
// the "cannot access before initialization" hoisting issue.
vi.mock("obsidian", async () => {
  const actual = await vi.importActual<typeof import("./__mocks__/obsidian")>(
    "./__mocks__/obsidian",
  );
  return {
    ...actual,
    requestUrl: vi.fn(actual.requestUrl),
  };
});

// Re-import the mocked module AFTER vi.mock() so we get the vi.fn() instance.
import * as obsidianModule from "obsidian";

beforeEach(() => {
  vi.mocked(obsidianModule.requestUrl).mockReset();
});

// Convenience alias used in tests below.
function getRequestUrlMock() {
  return vi.mocked(obsidianModule.requestUrl);
}

// ---------------------------------------------------------------------------
// ok / status mapping
// ---------------------------------------------------------------------------

describe("makeObsidianFetch — ok/status mapping", () => {
  it("ok is true for status 200", async () => {
    getRequestUrlMock().mockResolvedValueOnce({ status: 200, json: {}, text: "{}" });
    const fetch = makeObsidianFetch();
    const resp = await fetch("https://example.com/token", {});
    expect(resp.ok).toBe(true);
    expect(resp.status).toBe(200);
  });

  it("ok is true for status 201", async () => {
    getRequestUrlMock().mockResolvedValueOnce({ status: 201, json: {}, text: "{}" });
    const fetch = makeObsidianFetch();
    const resp = await fetch("https://example.com/register", {});
    expect(resp.ok).toBe(true);
    expect(resp.status).toBe(201);
  });

  it("ok is false for status 400", async () => {
    getRequestUrlMock().mockResolvedValueOnce({ status: 400, json: {}, text: '{"error":"bad_request"}' });
    const fetch = makeObsidianFetch();
    const resp = await fetch("https://example.com/token", {});
    expect(resp.ok).toBe(false);
    expect(resp.status).toBe(400);
  });

  it("ok is false for status 401", async () => {
    getRequestUrlMock().mockResolvedValueOnce({ status: 401, json: {}, text: '{"error":"unauthorized"}' });
    const fetch = makeObsidianFetch();
    const resp = await fetch("https://example.com/token", {});
    expect(resp.ok).toBe(false);
    expect(resp.status).toBe(401);
  });

  it("ok is true for status 299 (boundary)", async () => {
    getRequestUrlMock().mockResolvedValueOnce({ status: 299, json: {}, text: "{}" });
    const fetch = makeObsidianFetch();
    const resp = await fetch("https://example.com/token", {});
    expect(resp.ok).toBe(true);
    expect(resp.status).toBe(299);
  });

  it("ok is false for status 300 (boundary)", async () => {
    getRequestUrlMock().mockResolvedValueOnce({ status: 300, json: {}, text: "{}" });
    const fetch = makeObsidianFetch();
    const resp = await fetch("https://example.com/token", {});
    expect(resp.ok).toBe(false);
    expect(resp.status).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// throw: false is always passed (critical — prevents requestUrl from throwing
// on non-2xx responses, which would bypass the error-handling in doTokenExchange)
// ---------------------------------------------------------------------------

describe("makeObsidianFetch — throw:false invariant", () => {
  it("passes throw: false to requestUrl on every call", async () => {
    const mock = getRequestUrlMock();
    mock.mockResolvedValueOnce({ status: 200, json: {}, text: "{}" });
    const fetch = makeObsidianFetch();
    await fetch("https://example.com/token", {});
    expect(mock).toHaveBeenCalledTimes(1);
    const opts = mock.mock.calls[0][0] as { throw?: boolean };
    expect(opts.throw).toBe(false);
  });

  it("passes throw: false even when the response is a 401", async () => {
    const mock = getRequestUrlMock();
    mock.mockResolvedValueOnce({ status: 401, json: {}, text: '{"error":"unauthorized"}' });
    const fetch = makeObsidianFetch();
    await fetch("https://example.com/token", {});
    const opts = mock.mock.calls[0][0] as { throw?: boolean };
    expect(opts.throw).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// text() and json() delegation
// ---------------------------------------------------------------------------

describe("makeObsidianFetch — text() and json()", () => {
  it("resp.text() returns the text field from requestUrl", async () => {
    const body = '{"access_token":"at","refresh_token":"rt","token_type":"Bearer","expires_in":86400}';
    getRequestUrlMock().mockResolvedValueOnce({ status: 200, json: JSON.parse(body) as unknown, text: body });
    const fetch = makeObsidianFetch();
    const resp = await fetch("https://example.com/token", {});
    expect(await resp.text()).toBe(body);
  });

  it("resp.json() parses the text field (returns a real object)", async () => {
    const body = '{"access_token":"at","refresh_token":"rt","token_type":"Bearer","expires_in":86400}';
    getRequestUrlMock().mockResolvedValueOnce({ status: 200, json: JSON.parse(body) as unknown, text: body });
    const fetch = makeObsidianFetch();
    const resp = await fetch("https://example.com/token", {});
    const data = (await resp.json()) as { access_token: string };
    expect(data.access_token).toBe("at");
  });
});

// ---------------------------------------------------------------------------
// Request forwarding — url, method, headers, body
// ---------------------------------------------------------------------------

describe("makeObsidianFetch — request forwarding", () => {
  it("forwards the URL string to requestUrl", async () => {
    const mock = getRequestUrlMock();
    mock.mockResolvedValueOnce({ status: 200, json: {}, text: "{}" });
    const fetch = makeObsidianFetch();
    await fetch("https://mcp.fly-agile.com/token", {});
    expect(mock.mock.calls[0][0]).toMatchObject({ url: "https://mcp.fly-agile.com/token" });
  });

  it("forwards method, headers, and body from RequestInit", async () => {
    const mock = getRequestUrlMock();
    mock.mockResolvedValueOnce({ status: 200, json: {}, text: "{}" });
    const fetch = makeObsidianFetch();
    await fetch("https://mcp.fly-agile.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=refresh_token&refresh_token=rt-abc",
    });
    const opts = mock.mock.calls[0][0] as {
      method: string;
      headers: Record<string, string>;
      body: string;
    };
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(opts.body).toBe("grant_type=refresh_token&refresh_token=rt-abc");
  });
});
