/**
 * Obsidian-specific fetch adapter backed by requestUrl().
 *
 * WHY THIS EXISTS:
 * On iOS Obsidian, the WKWebView enforces CORS on all globalThis.fetch() calls.
 * The gateway's /register and /token endpoints return no CORS headers (they are
 * intentionally upstream of the CORS middleware), so every fetch() call fails
 * with a CORS error on iOS — the login button always shows "Error".
 *
 * Obsidian's requestUrl() bypasses the WKWebView CORS enforcement. This adapter
 * wraps requestUrl() in a minimal fetch-compatible signature so it can be injected
 * into TokenManagerOpts.fetch, startPluginLogin.fetch, and completePluginLogin.fetch.
 *
 * PLUGIN-ONLY CONSTRAINT:
 * This file imports from "obsidian" and MUST be imported ONLY from src/main.ts.
 * The headless daemon runs in Node where "obsidian" does not exist — any import
 * of this file from headless/** would break the daemon build.
 *
 * PouchDB replication (makeGatewayFetch / db.sync) deliberately keeps using
 * globalThis.fetch: streaming _changes requests require a real Response with a
 * ReadableStream body, which requestUrl() does not provide.
 */
import { requestUrl } from "obsidian";

/**
 * Returns a minimal fetch-compatible function backed by Obsidian's requestUrl.
 *
 * The returned function has the same signature as globalThis.fetch but only
 * supports the subset needed by the gateway OAuth endpoints:
 *   - string URL (not Request object)
 *   - method, headers (Record<string,string>), body (string) from RequestInit
 *   - Returns a Response-like object with ok, status, text(), and json()
 *
 * The throw: false option is always passed to requestUrl so non-2xx responses
 * are returned as values rather than thrown errors — matching globalThis.fetch
 * semantics and allowing the caller's error-handling to run.
 */
export function makeObsidianFetch(): typeof globalThis.fetch {
  return async function obsidianFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = init?.headers as Record<string, string> | undefined;
    const body = init?.body as string | undefined;

    const result = await requestUrl({
      url,
      method,
      headers,
      body,
      throw: false,
    });

    const status = result.status;
    const ok = status >= 200 && status < 300;
    const textValue = result.text;

    // Return a minimal Response-like object matching what doTokenExchange,
    // registerClient, and exchangeCode need: ok, status, text(), json().
    return {
      ok,
      status,
      async text() {
        return textValue;
      },
      async json() {
        return JSON.parse(textValue) as unknown;
      },
    } as unknown as Response;
  };
}
