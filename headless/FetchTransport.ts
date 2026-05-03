import type { HttpTransport, HttpResponse } from "../src/types";

/**
 * Native fetch-based HttpTransport for the headless daemon (Node 18+).
 */
export class FetchTransport implements HttpTransport {
  async request(options: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | ArrayBuffer;
  }): Promise<HttpResponse> {
    const init: RequestInit = {
      method: options.method || "GET",
      headers: options.headers,
    };

    if (options.body !== undefined) {
      init.body = options.body instanceof ArrayBuffer
        ? options.body
        : options.body;
    }

    const resp = await fetch(options.url, init);

    return {
      status: resp.status,
      text: () => resp.text(),
      json: <T>() => resp.json() as Promise<T>,
      arrayBuffer: () => resp.arrayBuffer(),
    };
  }
}
