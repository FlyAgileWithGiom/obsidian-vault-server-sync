import type {
  CouchDoc,
  CouchBulkResult,
  CouchChangesResult,
  CouchAllDocsResult,
  VaultSyncSettings,
  HttpTransport,
} from "./types";

function base64(str: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(str, "utf8").toString("base64");
  }
  return btoa(str);
}

/**
 * Lightweight CouchDB client.
 * Transport is injected so this class works in both Obsidian (requestUrl) and Node (fetch).
 */
export class CouchClient {
  private baseUrl: string;
  private authHeader: string | null = null;
  private cancelled = false;

  constructor(
    private settings: VaultSyncSettings,
    private transport: HttpTransport,
  ) {
    this.baseUrl = this.buildBaseUrl(settings);
    this.authHeader = this.buildAuth(settings);
  }

  private buildBaseUrl(s: VaultSyncSettings): string {
    return `${s.couchDbUrl.replace(/\/+$/, "")}/${encodeURIComponent(s.couchDbName)}`;
  }

  private buildAuth(s: VaultSyncSettings): string | null {
    if (s.couchDbUser && s.couchDbPassword) {
      return `Basic ${base64(`${s.couchDbUser}:${s.couchDbPassword}`)}`;
    }
    return null;
  }

  updateSettings(settings: VaultSyncSettings): void {
    this.settings = settings;
    this.baseUrl = this.buildBaseUrl(settings);
    this.authHeader = this.buildAuth(settings);
  }

  private async request<T>(
    path: string,
    options: { method?: string; body?: string; timeoutMs?: number } = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.authHeader) headers["Authorization"] = this.authHeader;

    const resp = await this.transport.request({
      url,
      method: options.method || "GET",
      headers,
      body: options.body,
      timeoutMs: options.timeoutMs,
    });

    if (resp.status >= 400) {
      const text = await resp.text();
      throw new CouchError(resp.status, `CouchDB ${resp.status}: ${text}`);
    }
    return resp.json<T>();
  }

  async ping(): Promise<boolean> {
    try {
      await this.request<{ db_name: string }>("");
      return true;
    } catch {
      return false;
    }
  }

  async ensureDb(): Promise<void> {
    try {
      await this.request("");
    } catch (e) {
      if (e instanceof CouchError && e.status === 404) {
        await this.request("", { method: "PUT" });
      } else {
        throw e;
      }
    }
  }

  async get(docId: string): Promise<CouchDoc> {
    return this.request<CouchDoc>(`/${encodeURIComponent(docId)}`);
  }

  async put(doc: CouchDoc): Promise<CouchBulkResult> {
    return this.request<CouchBulkResult>(`/${encodeURIComponent(doc._id)}`, {
      method: "PUT",
      body: JSON.stringify(doc),
    });
  }

  async delete(docId: string, rev: string): Promise<CouchBulkResult> {
    return this.request<CouchBulkResult>(
      `/${encodeURIComponent(docId)}?rev=${encodeURIComponent(rev)}`,
      { method: "DELETE" }
    );
  }

  async allDocs(options: {
    startkey?: string;
    endkey?: string;
    include_docs?: boolean;
    limit?: number;
  } = {}): Promise<CouchAllDocsResult> {
    const params = new URLSearchParams();
    if (options.startkey) params.set("startkey", JSON.stringify(options.startkey));
    if (options.endkey) params.set("endkey", JSON.stringify(options.endkey));
    if (options.include_docs) params.set("include_docs", "true");
    if (options.limit) params.set("limit", String(options.limit));
    const qs = params.toString();
    return this.request<CouchAllDocsResult>(`/_all_docs${qs ? "?" + qs : ""}`);
  }

  /**
   * Fetch specific docs by keys using POST _all_docs (avoids N+1 individual GETs).
   * CouchDB supports POST with {"keys": [...]} body for batch retrieval.
   * Pass timeoutMs to override the default 30s transport timeout for large key sets.
   */
  async allDocsByKeys(keys: string[], timeoutMs?: number): Promise<CouchAllDocsResult> {
    return this.request<CouchAllDocsResult>(
      "/_all_docs?include_docs=true",
      {
        method: "POST",
        body: JSON.stringify({ keys }),
        timeoutMs,
      }
    );
  }

  async bulkDocs(docs: CouchDoc[]): Promise<CouchBulkResult[]> {
    return this.request<CouchBulkResult[]>("/_bulk_docs", {
      method: "POST",
      body: JSON.stringify({ docs }),
    });
  }

  /**
   * Poll changes feed using normal feed with short timeout (not longpoll).
   * Polling loop in SyncEngine provides near-realtime.
   */
  async changes(since: string | number = 0, options: {
    timeout?: number;
    limit?: number;
    include_docs?: boolean;
  } = {}): Promise<CouchChangesResult> {
    this.cancelled = false;
    const params = new URLSearchParams({
      since: String(since),
      feed: "normal",
      include_docs: String(options.include_docs ?? true),
    });
    if (options.limit) params.set("limit", String(options.limit));

    return this.request<CouchChangesResult>(`/_changes?${params.toString()}`);
  }

  async getAttachment(docId: string, attName: string, timeoutMs = 120_000): Promise<ArrayBuffer> {
    const url = `${this.baseUrl}/${encodeURIComponent(docId)}/${encodeURIComponent(attName)}`;
    const headers: Record<string, string> = {};
    if (this.authHeader) headers["Authorization"] = this.authHeader;
    const resp = await this.transport.request({ url, method: "GET", headers, timeoutMs });
    if (resp.status >= 400) {
      const text = await resp.text();
      throw new CouchError(resp.status, `CouchDB ${resp.status}: ${text}`);
    }
    return resp.arrayBuffer();
  }

  async putAttachment(docId: string, attName: string, rev: string, data: ArrayBuffer, contentType: string): Promise<CouchBulkResult> {
    const url = `${this.baseUrl}/${encodeURIComponent(docId)}/${encodeURIComponent(attName)}?rev=${encodeURIComponent(rev)}`;
    const headers: Record<string, string> = { "Content-Type": contentType };
    if (this.authHeader) headers["Authorization"] = this.authHeader;
    const resp = await this.transport.request({ url, method: "PUT", headers, body: data });
    if (resp.status >= 400) {
      const text = await resp.text();
      throw new CouchError(resp.status, `CouchDB ${resp.status}: ${text}`);
    }
    return resp.json<CouchBulkResult>();
  }

  cancelChanges(): void {
    this.cancelled = true;
  }

  isCancelled(): boolean {
    return this.cancelled;
  }

  isConfigured(): boolean {
    return !!(this.settings.couchDbUrl && this.settings.couchDbName);
  }
}

export class CouchError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "CouchError";
  }
}
