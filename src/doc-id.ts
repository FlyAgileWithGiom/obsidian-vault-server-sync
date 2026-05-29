/**
 * CouchDB doc ID helpers used by PouchDbFsBridge — the single bridge that
 * backs both the Obsidian plugin (pouchdb-browser) and the headless daemon
 * (pouchdb-node). Centralising the encoding here guarantees plugin and daemon
 * produce identical doc IDs, preventing duplicate docs for the same file.
 *
 * Convention: "file/<NFC-normalized-path>"
 * NFC normalization is critical: macOS HFS+/APFS stores filenames in NFD,
 * most other platforms (iOS, Linux) use NFC. Without normalization,
 * "Productivité" from Mac (NFD) and "Productivité" from iOS (NFC)
 * produce two distinct CouchDB docs for the same logical file.
 */

export const DOC_PREFIX = "file/";

/** Convert a vault file path to a CouchDB doc ID (NFC-normalized). */
export function pathToDocId(path: string): string {
  return `${DOC_PREFIX}${path.normalize("NFC")}`;
}

/** Convert a CouchDB doc ID back to a vault file path (NFC-normalized). */
export function docIdToPath(docId: string): string {
  const raw = docId.startsWith(DOC_PREFIX) ? docId.slice(DOC_PREFIX.length) : docId;
  return raw.normalize("NFC");
}
