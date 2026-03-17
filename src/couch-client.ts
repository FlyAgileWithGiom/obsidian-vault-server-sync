import type {
  CouchDoc,
  CouchBulkResult,
  CouchChangesResult,
  CouchAllDocsResult,
  VaultSyncSettings,
} from "./types";

/**
 * Lightweight CouchDB client using fetch API.
 * No PouchDB dependency — ~3KB vs 135KB.
 */
export class CouchClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private abortController: AbortController | null = null;

  constructor(private settings: VaultSyncSettings) {
    const { couchDbUrl, couchDbName } = settings;
    this.baseUrl = `${couchDbUrl.replace(/\/+$/, "")}/${encodeURIComponent(couchDbName)}`;
    this.headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (settings.couchDbUser && settings.couchDbPassword) {
      const creds = btoa(`${settings.couchDbUser}:${settings.couchDbPassword}`);
      this.headers["Authorization"] = `Basic ${creds}`;
    }
  }

  updateSettings(settings: VaultSyncSettings): void {
    this.settings = settings;
    const { couchDbUrl, couchDbName } = settings;
    this.baseUrl = `${couchDbUrl.replace(/\/+$/, "")}/${encodeURIComponent(couchDbName)}`;
    if (settings.couchDbUser && settings.couchDbPassword) {
      const creds = btoa(`${settings.couchDbUser}:${settings.couchDbPassword}`);
      this.headers["Authorization"] = `Basic ${creds}`;
    }
  }

  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const resp = await fetch(url, {
      ...options,
      headers: { ...this.headers, ...((options.headers as Record<string, string>) || {}) },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new CouchError(resp.status, `CouchDB ${resp.status}: ${body}`);
    }
    return resp.json();
  }

  /** Check if DB is reachable */
  async ping(): Promise<boolean> {
    try {
      await this.request<{ db_name: string }>("");
      return true;
    } catch {
      return false;
    }
  }

  /** Ensure the database exists, create if not */
  async ensureDb(): Promise<void> {
    try {
      await this.request("");
    } catch (e) {
      if (e instanceof CouchError && e.status === 404) {
        const url = this.baseUrl;
        await fetch(url, { method: "PUT", headers: this.headers });
      } else {
        throw e;
      }
    }
  }

  /** Get a single document */
  async get(docId: string): Promise<CouchDoc> {
    return this.request<CouchDoc>(`/${encodeURIComponent(docId)}`);
  }

  /** Put a single document */
  async put(doc: CouchDoc): Promise<CouchBulkResult> {
    return this.request<CouchBulkResult>(`/${encodeURIComponent(doc._id)}`, {
      method: "PUT",
      body: JSON.stringify(doc),
    });
  }

  /** Delete a document (mark as deleted) */
  async delete(docId: string, rev: string): Promise<CouchBulkResult> {
    return this.request<CouchBulkResult>(
      `/${encodeURIComponent(docId)}?rev=${encodeURIComponent(rev)}`,
      { method: "DELETE" }
    );
  }

  /** Bulk get all docs with content (for initial sync) */
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

  /** Bulk write documents */
  async bulkDocs(docs: CouchDoc[]): Promise<CouchBulkResult[]> {
    return this.request<CouchBulkResult[]>("/_bulk_docs", {
      method: "POST",
      body: JSON.stringify({ docs }),
    });
  }

  /**
   * Poll changes feed (long-polling, mobile-friendly).
   * Returns when changes arrive or timeout.
   */
  async changes(since: string | number = 0, options: {
    timeout?: number;
    limit?: number;
    include_docs?: boolean;
  } = {}): Promise<CouchChangesResult> {
    // Cancel any previous long-poll
    this.cancelChanges();

    this.abortController = new AbortController();
    const params = new URLSearchParams({
      since: String(since),
      feed: "longpoll",
      timeout: String(options.timeout ?? 25000),
      include_docs: String(options.include_docs ?? true),
    });
    if (options.limit) params.set("limit", String(options.limit));

    const url = `${this.baseUrl}/_changes?${params.toString()}`;
    const resp = await fetch(url, {
      headers: this.headers,
      signal: this.abortController.signal,
    });
    if (!resp.ok) {
      throw new CouchError(resp.status, `Changes feed error: ${resp.status}`);
    }
    return resp.json();
  }

  /** Cancel an ongoing long-poll */
  cancelChanges(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
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
