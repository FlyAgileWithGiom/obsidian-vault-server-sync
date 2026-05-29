/**
 * Helpers for constructing PouchDB document shapes.
 * Used by PouchDbFsBridge so the Obsidian plugin (pouchdb-browser) and the
 * headless daemon (pouchdb-node) produce identical document formats — critical
 * for LWW conflict resolution (mtime must be integer-truncated identically on
 * both sides).
 */

import { pathToDocId } from "./doc-id";
import type { VaultFile } from "./types";

/**
 * Build a text document for CouchDB/PouchDB.
 * mtime is Math.floor'd to match the integer truncation on the Mac side
 * (ObsidianVaultAdapter.getFiles() truncates mtime). LWW resolution is
 * deterministic only when both sides use integer mtime.
 */
export function buildTextDoc(file: VaultFile, content: string) {
  return {
    _id: pathToDocId(file.path),
    content,
    mtime: Math.floor(file.mtime),
    deleted: false,
  };
}

/**
 * Build a binary document stub for CouchDB/PouchDB.
 * The binary content is stored as an _attachment (via putAttachment),
 * not inlined in this doc. This stub carries the mtime for LWW.
 */
export function buildBinaryDocMeta(file: VaultFile) {
  return {
    _id: pathToDocId(file.path),
    mtime: Math.floor(file.mtime),
    deleted: false,
    // 'content' is absent on binary docs — bridge checks for _attachments on read
  };
}
