import { requestUrl } from "obsidian";
import type { HttpTransport, HttpResponse } from "./types";

/**
 * Wraps Obsidian's requestUrl API to implement HttpTransport.
 * requestUrl bypasses CORS restrictions in Electron/Capacitor (mobile).
 */
export class ObsidianTransport implements HttpTransport {
  async request(options: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | ArrayBuffer;
    timeoutMs?: number;
  }): Promise<HttpResponse> {
    const resp = await requestUrl({
      url: options.url,
      method: options.method || "GET",
      headers: options.headers,
      body: options.body as string | undefined,
      throw: false,
      ...(options.timeoutMs !== undefined && { timeout: options.timeoutMs }),
    });

    return {
      status: resp.status,
      text: async () => resp.text,
      json: async <T>() => resp.json as T,
      arrayBuffer: async () => resp.arrayBuffer,
    };
  }
}
