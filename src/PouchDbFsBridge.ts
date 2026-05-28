/**
 * PouchDbFsBridge — bidirectional bridge between Obsidian vault FS and local PouchDB.
 *
 * Instantiated by PouchDbSyncStrategy. Responsible for:
 * - Vault events (modify/create/delete/rename) -> local PouchDB writes
 * - PouchDB change events -> vault FS writes
 * - Echo-loop suppression (Level 1: TTL cache, Level 2: content equality)
 * - Parent directory creation before vault FS writes
 *
 * The strategy handles the actual CouchDB replication (db.sync). This bridge
 * only cares about the local PouchDB <-> vault FS boundary.
 */

import type { Plugin, EventRef } from "obsidian";
import type { VaultAdapter, VaultEntry } from "./types";
import { buildTextDoc, buildBinaryDocMeta } from "./doc-builder";
import { docIdToPath, pathToDocId, DOC_PREFIX } from "./doc-id";
import { isBinaryPath, ATTACHMENT_NAME, CONTENT_TYPE_MAP, contentTypeForPath } from "./binary-ext";
import type PouchDB from "pouchdb-browser";

// Shape of a PouchDB change row from db.changes()
interface PouchChangeRow {
  id: string;
  seq: string | number;
  deleted?: boolean;
  doc?: {
    _id: string;
    _rev?: string;
    _deleted?: boolean;
    _attachments?: Record<string, unknown>;
    content?: string;
    mtime?: number;
    deleted?: boolean;
  };
}

export class PouchDbFsBridge {
  private plugin: Plugin | null = null;
  private eventRefs: EventRef[] = [];
  /** Level 1 echo-suppression: paths recently written by bridge -> vault, with write timestamp. */
  private recentRemotePaths: Map<string, number> = new Map();
  /** Handle for the PouchDB changes listener, so it can be cancelled on unregister. */
  private changesHandle: { cancel(): void } | null = null;

  constructor(
    private readonly vault: VaultAdapter,
    private readonly db: PouchDB,
  ) {}

  /**
   * Wire vault event handlers and start listening to PouchDB changes.
   * Called by PouchDbSyncStrategy.register(plugin).
   */
  register(plugin: Plugin): void {
    this.plugin = plugin;
    const vaultObj = plugin.app.vault;

    const addEvent = (ref: EventRef) => {
      plugin.registerEvent(ref);
      this.eventRefs.push(ref);
    };

    addEvent(
      vaultObj.on("modify", (file) => this.onVaultModify(file))
    );
    addEvent(
      vaultObj.on("create", (file) => this.onVaultModify(file))
    );
    addEvent(
      vaultObj.on("delete", (file) => this.onVaultDelete(file))
    );
    addEvent(
      vaultObj.on("rename", (file, oldPath) => this.onVaultRename(file, oldPath as string))
    );

    // Start listening to PouchDB changes (live, from current seq)
    this.startChangesListener();
  }

  /** Stop all event handlers and the PouchDB changes listener. */
  unregister(): void {
    if (this.plugin) {
      const vaultObj = this.plugin.app.vault as typeof this.plugin.app.vault & { offref?: (ref: EventRef) => void };
      if (vaultObj.offref) {
        for (const ref of this.eventRefs) {
          vaultObj.offref(ref);
        }
      }
      this.eventRefs = [];
      this.plugin = null;
    }

    if (this.changesHandle) {
      this.changesHandle.cancel();
      this.changesHandle = null;
    }
  }

  // --- Vault -> PouchDB ---

  private onVaultModify(file: { path: string }): void {
    const entry = this.vault.getEntryByPath(file.path);
    if (!entry || entry.kind !== "file") return;

    // Check echo-suppression Level 1: recently written by bridge
    const cached = this.recentRemotePaths.get(file.path);
    if (cached !== undefined && Math.abs(Date.now() - cached) < 3000) return;

    if (isBinaryPath(file.path)) {
      // Binary path: handled in commit 8 extension
      this.writeBinaryToPouch(entry).catch(() => {/* non-critical, will retry on next change */});
    } else {
      this.writeTextToPouch(entry).catch(() => {/* non-critical */});
    }
  }

  private onVaultDelete(file: { path: string }): void {
    const docId = pathToDocId(file.path);
    this.markDeletedInPouch(docId).catch(() => {/* non-critical */});
  }

  private onVaultRename(file: { path: string }, oldPath: string): void {
    // Treat rename as: delete old doc, create new doc
    const oldDocId = pathToDocId(oldPath);
    this.markDeletedInPouch(oldDocId).catch(() => {});
    const entry = this.vault.getEntryByPath(file.path);
    if (entry && entry.kind === "file") {
      if (isBinaryPath(file.path)) {
        this.writeBinaryToPouch(entry).catch(() => {});
      } else {
        this.writeTextToPouch(entry).catch(() => {});
      }
    }
  }

  private async writeTextToPouch(file: import("./types").VaultFile): Promise<void> {
    const content = await this.vault.readText(file);
    const docId = pathToDocId(file.path);

    // Get current _rev to avoid 409 conflicts
    let rev: string | undefined;
    try {
      const existing = await this.db.get(docId);
      rev = existing._rev;
    } catch {
      // Doc doesn't exist yet — create new
    }

    const doc = {
      ...buildTextDoc(file, content),
      ...(rev ? { _rev: rev } : {}),
    };

    await this.db.put(doc as Parameters<typeof this.db.put>[0]);
  }

  private async writeBinaryToPouch(file: import("./types").VaultFile): Promise<void> {
    const docId = pathToDocId(file.path);

    // Get current _rev to avoid 409 conflicts
    let rev: string | undefined;
    try {
      const existing = await this.db.get(docId);
      rev = existing._rev;
    } catch {
      // Doc doesn't exist yet
    }

    const meta = {
      ...buildBinaryDocMeta(file),
      ...(rev ? { _rev: rev } : {}),
    };

    const metaResult = await this.db.put(meta as Parameters<typeof this.db.put>[0]);
    const newRev = metaResult.rev;

    // Read the binary data and store as attachment
    const data = await this.vault.readBinary(file);
    const contentType = contentTypeForPath(file.path);
    await this.db.putAttachment(docId, ATTACHMENT_NAME, newRev, data, contentType);
  }

  private async markDeletedInPouch(docId: string): Promise<void> {
    try {
      const existing = await this.db.get(docId);
      await this.db.put({
        ...existing,
        _deleted: true,
        deleted: true,
      } as Parameters<typeof this.db.put>[0]);
    } catch {
      // Doc doesn't exist — no-op
    }
  }

  // --- PouchDB -> Vault ---

  private startChangesListener(): void {
    this.changesHandle = this.db.changes({
      since: "now",
      live: true,
      include_docs: true,
    }) as { cancel(): void };

    // The PouchDB changes handle emits 'change' events
    const changesEmitter = this.changesHandle as unknown as {
      on(event: "change", handler: (change: PouchChangeRow) => void): void;
      on(event: "error", handler: (err: unknown) => void): void;
    };

    changesEmitter.on("change", (change) => {
      this.applyRemoteChange(change).catch(() => {/* non-critical */});
    });

    changesEmitter.on("error", (_err) => {
      // Changes feed error — strategy will restart on visibility change
    });
  }

  private async applyRemoteChange(change: PouchChangeRow): Promise<void> {
    if (!change.doc) return;
    const doc = change.doc;

    // Only handle file/ docs — skip design docs, metadata docs, etc.
    if (!doc._id.startsWith(DOC_PREFIX)) return;
    const path = docIdToPath(doc._id);

    // Skip deleted docs — handle tombstone by deleting from vault
    if (doc._deleted || doc.deleted) {
      const entry = this.vault.getEntryByPath(path);
      if (entry && entry.kind === "file") {
        this.markRemoteWrite(path);
        await this.vault.deleteFile(entry);
      }
      return;
    }

    if (isBinaryPath(path)) {
      // Binary path: handled in commit 8 extension
      await this.applyRemoteBinaryChange(doc, path);
      return;
    }

    // Text path
    const content = typeof doc.content === "string" ? doc.content : null;
    if (content === null) return; // Malformed doc — skip

    // Level 2 echo-suppression: content equality guard
    const existingEntry = this.vault.getEntryByPath(path);
    if (existingEntry && existingEntry.kind === "file") {
      const localContent = await this.vault.readText(existingEntry);
      if (localContent === content) return; // Idempotent write, skip
    }

    // Ensure parent directory exists
    await this.ensureParentDirectory(path);

    // Mark as remote write BEFORE writing to suppress vault event echo
    this.markRemoteWrite(path);

    if (existingEntry && existingEntry.kind === "file") {
      await this.vault.modifyText(existingEntry, content);
    } else {
      await this.vault.createText(path, content);
    }
  }

  private async applyRemoteBinaryChange(
    doc: NonNullable<PouchChangeRow["doc"]>,
    path: string,
  ): Promise<void> {
    // Check if this doc has an attachment
    if (!doc._attachments || !doc._attachments[ATTACHMENT_NAME]) return;

    const existingEntry = this.vault.getEntryByPath(path);

    // Level 1 echo-suppression only (no content equality for binary — too expensive)
    const cached = this.recentRemotePaths.get(path);
    if (cached !== undefined && Math.abs(Date.now() - cached) < 3000) return;

    await this.ensureParentDirectory(path);
    this.markRemoteWrite(path);

    const blob = await this.db.getAttachment(doc._id, ATTACHMENT_NAME);
    const buffer = blob instanceof Blob
      ? await blob.arrayBuffer()
      : (blob as unknown as ArrayBuffer);

    if (existingEntry && existingEntry.kind === "file") {
      await this.vault.modifyBinary(existingEntry, buffer);
    } else {
      await this.vault.createBinary(path, buffer);
    }
  }

  private markRemoteWrite(path: string): void {
    this.recentRemotePaths.set(path, Date.now());
    setTimeout(() => this.recentRemotePaths.delete(path), 3000);
  }

  private async ensureParentDirectory(filePath: string): Promise<void> {
    const lastSlash = filePath.lastIndexOf("/");
    if (lastSlash <= 0) return; // Root level, no parent needed
    const parentPath = filePath.substring(0, lastSlash);
    if (!this.vault.getEntryByPath(parentPath)) {
      await this.vault.createDirectory(parentPath);
    }
  }
}
