/**
 * Minimal ambient declaration for pouchdb-browser v9.
 * We do NOT use @types/pouchdb-browser — the official types target v6 and
 * conflict with the v9 runtime API surface.
 * Only the subset of APIs used by PouchDbFsBridge and PouchDbSyncStrategy
 * is declared here.
 */

declare module "pouchdb-browser" {
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

  /**
   * Replication / sync options.
   *
   * `selector` is a Mango selector forwarded to CouchDB as a server-side
   * `_changes?filter=_selector` filter (validated by spikes/mobile-text-first):
   * it gates which docs cross the wire, enabling the two-phase text-first pull.
   *
   * `checkpoint: 'target'` stores the replication checkpoint on the local target
   * (keeps a read-only source clean and makes a phase resumable); `false` forces a
   * full changes-feed walk with no checkpoint reuse.
   */
  interface PouchDbReplicationOpts {
    live?: boolean;
    retry?: boolean;
    selector?: Record<string, unknown>;
    checkpoint?: "source" | "target" | false;
  }

  class PouchDB {
    constructor(name: string, options?: Record<string, unknown>);

    sync(remote: string, opts?: PouchDbReplicationOpts): PouchDbSyncHandle;

    replicate: {
      from(remote: string, opts?: PouchDbReplicationOpts): PouchDbSyncHandle;
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
      attachment: Blob | ArrayBuffer,
      type: string,
    ): Promise<PouchDbPutResult>;

    getAttachment(
      docId: string,
      attachmentId: string,
    ): Promise<Blob | Buffer>;

    bulkDocs(
      docs: PouchDbDoc[],
      opts?: { new_edits?: boolean },
    ): Promise<Array<{ ok?: boolean; id?: string; rev?: string; error?: boolean; message?: string }>>;

    changes(opts: {
      since: string | number;
      live: boolean;
      include_docs?: boolean;
    }): PouchDbSyncHandle;
  }

  export = PouchDB;
}
