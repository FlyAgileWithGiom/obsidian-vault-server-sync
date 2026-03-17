import { requestUrl, RequestUrlParam } from "obsidian";
import { CouchDoc, ChangeResult } from "./types";

export class CouchClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(couchdbUrl: string, database: string, username: string, password: string) {
    this.baseUrl = couchdbUrl.replace(/\/$/, "") + "/" + database;
    this.headers = {
      "Authorization": "Basic " + btoa(username + ":" + password),
      "Content-Type": "application/json",
    };
  }

  async getDoc(docId: string): Promise<CouchDoc | null> {
    try {
      const response = await requestUrl({
        url: `${this.baseUrl}/${encodeURIComponent(docId)}`,
        method: "GET",
        headers: this.headers,
        throw: false,
      } as RequestUrlParam);

      if (response.status === 404) {
        return null;
      }

      return response.json as CouchDoc;
    } catch (e) {
      console.error("CouchClient.getDoc error:", e);
      return null;
    }
  }

  async putDoc(doc: CouchDoc): Promise<{ ok: boolean; id: string; rev: string } | null> {
    try {
      const response = await requestUrl({
        url: `${this.baseUrl}/${encodeURIComponent(doc._id)}`,
        method: "PUT",
        headers: this.headers,
        body: JSON.stringify(doc),
        throw: false,
      } as RequestUrlParam);

      if (response.status === 409) {
        return null;
      }

      return response.json as { ok: boolean; id: string; rev: string };
    } catch (e) {
      console.error("CouchClient.putDoc error:", e);
      return null;
    }
  }

  async deleteDoc(docId: string, rev: string): Promise<boolean> {
    try {
      const response = await requestUrl({
        url: `${this.baseUrl}/${encodeURIComponent(docId)}?rev=${encodeURIComponent(rev)}`,
        method: "DELETE",
        headers: this.headers,
        throw: false,
      } as RequestUrlParam);

      return response.status === 200;
    } catch (e) {
      console.error("CouchClient.deleteDoc error:", e);
      return false;
    }
  }

  async getAttachment(docId: string, attName: string): Promise<ArrayBuffer | null> {
    try {
      const response = await requestUrl({
        url: `${this.baseUrl}/${encodeURIComponent(docId)}/${encodeURIComponent(attName)}`,
        method: "GET",
        headers: this.headers,
        throw: false,
      } as RequestUrlParam);

      if (response.status === 404) {
        return null;
      }

      return response.arrayBuffer;
    } catch (e) {
      console.error("CouchClient.getAttachment error:", e);
      return null;
    }
  }

  async putAttachment(
    docId: string,
    attName: string,
    rev: string,
    data: ArrayBuffer,
    contentType: string
  ): Promise<string | null> {
    try {
      const headers = {
        "Authorization": this.headers["Authorization"],
        "Content-Type": contentType,
      };

      const response = await requestUrl({
        url: `${this.baseUrl}/${encodeURIComponent(docId)}/${encodeURIComponent(attName)}?rev=${encodeURIComponent(rev)}`,
        method: "PUT",
        headers,
        body: data,
        throw: false,
      } as RequestUrlParam);

      if (response.status !== 201 && response.status !== 200) {
        return null;
      }

      const result = response.json as { ok: boolean; id: string; rev: string };
      return result.rev;
    } catch (e) {
      console.error("CouchClient.putAttachment error:", e);
      return null;
    }
  }

  async getChanges(since: string, limit: number = 100): Promise<{
    results: ChangeResult[];
    last_seq: string;
  }> {
    try {
      const params = new URLSearchParams({
        since,
        include_docs: "true",
        limit: String(limit),
      });

      const response = await requestUrl({
        url: `${this.baseUrl}/_changes?${params.toString()}`,
        method: "GET",
        headers: this.headers,
        throw: false,
      } as RequestUrlParam);

      return response.json as { results: ChangeResult[]; last_seq: string };
    } catch (e) {
      console.error("CouchClient.getChanges error:", e);
      return { results: [], last_seq: since };
    }
  }

  async ping(): Promise<boolean> {
    try {
      const response = await requestUrl({
        url: this.baseUrl,
        method: "GET",
        headers: this.headers,
        throw: false,
      } as RequestUrlParam);

      return response.status === 200;
    } catch (e) {
      console.error("CouchClient.ping error:", e);
      return false;
    }
  }
}
