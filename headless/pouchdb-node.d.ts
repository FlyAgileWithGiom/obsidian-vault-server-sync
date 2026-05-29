/**
 * Minimal ambient declaration for pouchdb-node v9.
 *
 * Mirrors src/pouchdb-browser.d.ts — same API surface, different adapter.
 * pouchdb-node uses LevelDB (via leveldown) as the local storage backend,
 * constructed with a filesystem path instead of a string name.
 *
 * We do NOT use @types/pouchdb — the official types target v6 and conflict
 * with the v9 runtime API surface.
 * Only the subset of APIs used by PouchDbFsBridge, PouchDbSyncEngine, and
 * the headless converter is declared here.
 */

declare module "pouchdb-node" {
  interface PouchDbDoc {
    _id: string;
    _rev?: string;
    _deleted?: boolean;
    _attachments?: Record<string, unknown>;
    [key: string]: unknown;
  }

  interface PouchDbAllDocsResult {
    rows: Array<{
      id: string;
      key: string;
      value: { rev: string; deleted?: boolean };
      doc?: PouchDbDoc;
    }>;
    total_rows: number;
    offset: number;
  }

  interface PouchDbInfo {
    db_name: string;
    doc_count: number;
    update_seq: number | string;
  }

  interface PouchDbPutResult {
    ok: boolean;
    id: string;
    rev: string;
  }

  interface PouchDbSyncHandle {
    cancel(): void;
    on(event: "change", handler: (info: PouchDbChangeInfo) => void): this;
    on(event: "complete", handler: (info: unknown) => void): this;
    on(event: "error", handler: (err: unknown) => void): this;
  }

  interface PouchDbChangeInfo {
    docs_written?: number;
    pending?: number;
  }

  class PouchDB {
    /**
     * @param path  Absolute filesystem path to the LevelDB directory.
     *              pouchdb-node creates the directory if absent.
     * @param options  Optional adapter options (e.g. { adapter: 'leveldb' }).
     */
    constructor(path: string, options?: Record<string, unknown>);

    sync(remote: string, opts?: { live?: boolean; retry?: boolean }): PouchDbSyncHandle;

    replicate: {
      from(remote: string, opts?: { live?: boolean; retry?: boolean }): PouchDbSyncHandle;
    };

    info(): Promise<PouchDbInfo>;

    allDocs(opts?: {
      include_docs?: boolean;
      attachments?: boolean;
    }): Promise<PouchDbAllDocsResult>;

    put(doc: PouchDbDoc): Promise<PouchDbPutResult>;

    get(id: string): Promise<PouchDbDoc>;

    putAttachment(
      docId: string,
      attachmentId: string,
      rev: string,
      attachment: Buffer | ArrayBuffer,
      type: string,
    ): Promise<PouchDbPutResult>;

    getAttachment(
      docId: string,
      attachmentId: string,
    ): Promise<Buffer>;

    bulkDocs(
      docs: PouchDbDoc[],
      opts?: { new_edits?: boolean },
    ): Promise<Array<{ ok?: boolean; id?: string; rev?: string; error?: boolean; message?: string }>>;

    changes(opts: {
      since: string | number;
      live: boolean;
      include_docs?: boolean;
    }): PouchDbSyncHandle;

    destroy(): Promise<void>;
  }

  export = PouchDB;
}
