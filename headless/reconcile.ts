/**
 * reconcile — pure FS<->PouchDB divergence detection module.
 *
 * Given a snapshot of vault files, local PouchDB docs, and remote revs, returns
 * a list of ReconcileActions describing what needs to happen to bring both sides
 * into agreement. No I/O of its own — all readers are injected so tests can mock.
 *
 * Design contract (load-bearing; do not relax without the plan's sign-off):
 *
 *   CONTENT is the local arbiter:
 *     An exact string compare between disk text and local PouchDB content is
 *     the gate for "did this file change?". This eliminates the 253 false-positive
 *     case where mtime drifted without content changing (e.g. a copy, a restore,
 *     or a filesystem touch).
 *
 *   REMOTE REV is the direction arbiter:
 *     When content diverged, comparing local._rev to the remote winning rev
 *     tells us whether the remote also moved during the outage. Equal → we are
 *     safe to push. Different → both sides moved → non-destructive conflict-copy.
 *
 *   MTIME IS NEVER USED:
 *     No mtime-equality fast-path is added here even though it would be faster,
 *     because mtime has proven unreliable on this vault (253 false positives).
 *     Evaluate only against real boot timing if boot is proven slow — YAGNI otherwise.
 *
 *   BINARY FILES (stored via CouchDB _attachments):
 *     Hashing GBs of attachments on every boot is unacceptable. We compare
 *     VaultFile.size (from stat) against the LocalDoc.size field (populated by
 *     doc-builder). Equal size → skip:identical. Differ → apply same rev test.
 *     Residual miss: a same-size content change is not detected at reconcile time
 *     (rare; caught by any subsequent live edit). A stored content-hash field would
 *     close this, but is a doc-schema change — YAGNI, out of scope.
 */

import { pathToDocId, docIdToPath } from "../src/doc-id";
import { isBinaryPath } from "../src/binary-ext";
import type { RemoteRevEntry } from "./remote-revs";
import type { VaultFile } from "../src/types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ReconcileAction =
  | { kind: "push";          path: string }
  | { kind: "pull";          path: string }
  | { kind: "tombstone";     docId: string }
  | { kind: "conflict-copy"; path: string }
  | { kind: "skip";          path: string;
      reason: "identical" | "excluded" | "awaiting-pull" | "remote-newer" | "both-absent" };

/**
 * Minimal local PouchDB doc shape needed by reconcile.
 * Only the fields used for divergence detection — not the full PouchDB doc type.
 */
export interface LocalDoc {
  _rev?: string;
  content?: string;
  size?: number;
  _attachments?: object;
}

export interface ReconcileInput {
  /** Vault files currently on disk. */
  vaultFiles: VaultFile[];

  /**
   * All doc IDs currently in local PouchDB.
   * Required to enumerate DB-present / FS-absent candidates that cannot be
   * discovered from vaultFiles or remoteRevs alone (e.g. a doc that was never
   * synced to a remote the reconciler knows about).
   * Caller passes the result of db.allDocs({ include_docs: false }).rows.map(r => r.id).
   */
  localDocIds: string[];

  /** Read a single local PouchDB doc by docId. Resolves to undefined for 404. */
  localGet: (docId: string) => Promise<LocalDoc | undefined>;

  /**
   * Read the current text content of a vault file from disk.
   * Called ONLY for text files where local doc is present (never for binary,
   * FS-absent, stub, or excluded cases).
   */
  readDiskText: (file: VaultFile) => Promise<string>;

  /**
   * Remote rev/deleted status map built by fetchRemoteRevs.
   * Absent key ⇒ remote not_found (per AC2.0).
   * Present key with deleted:true ⇒ remote tombstone.
   */
  remoteRevs: Map<string, RemoteRevEntry>;

  /** Returns true if the path should be excluded (same exclusion rules as live sync). */
  isExcluded: (path: string) => boolean;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Compute the set of reconciliation actions for all candidate docIds.
 *
 * Candidate set = union of:
 *   - docIds derived from vaultFiles (FS-present)
 *   - localDocIds (DB-present, may not have FS file)
 *   - remoteRevs keys (remote-present, may not have FS file or local doc)
 *
 * Each candidate is evaluated exactly once in priority order:
 *   1. excluded → skip:excluded
 *   2. stub (no content, no _attachments) → skip:awaiting-pull
 *   3. FS present branch (tombstone check FIRST, then local-absent, then content compare)
 *   4. FS absent branch (tombstone check FIRST, then local-absent, then rev compare)
 */
export async function reconcile(input: ReconcileInput): Promise<ReconcileAction[]> {
  const { vaultFiles, localDocIds, localGet, readDiskText, remoteRevs, isExcluded } = input;

  // Build a lookup: docId → VaultFile (for O(1) FS-present checks)
  const fileByDocId = new Map<string, VaultFile>();
  for (const file of vaultFiles) {
    fileByDocId.set(pathToDocId(file.path), file);
  }

  // Build candidate set = union of all three sources
  const candidateSet = new Set<string>();
  for (const file of vaultFiles) {
    candidateSet.add(pathToDocId(file.path));
  }
  for (const id of localDocIds) {
    candidateSet.add(id);
  }
  for (const id of remoteRevs.keys()) {
    candidateSet.add(id);
  }

  const actions: ReconcileAction[] = [];

  for (const docId of candidateSet) {
    const path = docIdToPath(docId);
    const fsFile = fileByDocId.get(docId);
    const remote = remoteRevs.get(docId); // undefined ⇒ remote not_found

    // ------------------------------------------------------------------
    // Rule 1: excluded path → skip:excluded (checked FIRST)
    // ------------------------------------------------------------------
    if (isExcluded(path)) {
      actions.push({ kind: "skip", path, reason: "excluded" });
      continue;
    }

    const localDoc = await localGet(docId);

    // ------------------------------------------------------------------
    // Rule 2: converter-seeded stub (no content, no _attachments) → skip:awaiting-pull
    // Guard against v1→v2 mass-push: these stubs are seeded by runConverter
    // and have not yet been populated by live sync. AC2.8.
    // ------------------------------------------------------------------
    if (
      localDoc !== undefined &&
      localDoc.content === undefined &&
      localDoc._attachments === undefined
    ) {
      actions.push({ kind: "skip", path, reason: "awaiting-pull" });
      continue;
    }

    if (fsFile !== undefined) {
      // ----------------------------------------------------------------
      // FS PRESENT branch
      // ----------------------------------------------------------------

      // Rule 5: remote tombstone + FS present → conflict-copy (keep-over-delete).
      // Check BEFORE content compare — a tombstone outranks a "content differs" push.
      if (remote !== undefined && remote.deleted) {
        actions.push({ kind: "conflict-copy", path });
        continue;
      }

      if (localDoc === undefined) {
        // Rule 3: FS present, local-DB absent
        if (remote === undefined) {
          // AC2.1 — stranded file: push it
          actions.push({ kind: "push", path });
        } else {
          // Remote is present and active; live sync will pull it. Do NOT push.
          actions.push({ kind: "skip", path, reason: "remote-newer" });
        }
        continue;
      }

      // Local doc is present. Compare content or size depending on file type.
      if (isBinaryPath(path)) {
        // Rule 7: binary — size compare
        const docSize = localDoc.size ?? 0;
        const diskSize = fsFile.size;
        if (docSize === diskSize) {
          actions.push({ kind: "skip", path, reason: "identical" });
        } else if (localDoc._rev !== undefined && localDoc._rev === remote?.rev) {
          actions.push({ kind: "push", path });
        } else {
          actions.push({ kind: "conflict-copy", path });
        }
      } else {
        // Rule 6: text — exact string compare
        const diskText = await readDiskText(fsFile);
        if (diskText === localDoc.content) {
          // AC2.2 — identical content regardless of mtime
          actions.push({ kind: "skip", path, reason: "identical" });
        } else if (localDoc._rev !== undefined && localDoc._rev === remote?.rev) {
          // Clean local edit: remote unchanged → push
          actions.push({ kind: "push", path });
        } else {
          // AC2.4 — both sides diverged → conflict-copy
          actions.push({ kind: "conflict-copy", path });
        }
      }
    } else {
      // ----------------------------------------------------------------
      // FS ABSENT branch — AC2.3
      // ----------------------------------------------------------------

      // Rule AC2.3d: remote tombstone + FS absent → both-absent → skip
      // Check BEFORE rev compare.
      if (remote !== undefined && remote.deleted) {
        actions.push({ kind: "skip", path, reason: "both-absent" });
        continue;
      }

      if (localDoc === undefined) {
        // AC2.3c: no local doc, FS absent, remote present → brand-new remote creation → pull
        if (remote !== undefined) {
          actions.push({ kind: "pull", path });
        }
        // If remote also absent: both sources absent, nothing to do (no candidate
        // would reach here from remoteRevs — it would not be in the candidate set)
        continue;
      }

      // Local doc present, FS absent.
      // AC2.3a: local._rev === remote winning rev → user deleted on disk → tombstone
      // AC2.3b: local._rev !== remote winning rev → remote moved during outage → pull
      //
      // OFF-TABLE CELL: local doc present + FS absent + remote ABSENT (not_found).
      // Reachable when a remote doc was deleted+compacted (tombstone GC'd) while
      // the daemon was down, so remoteRevs returns not_found (not a tombstone entry).
      // Decision: treat as AC2.3b (pull), i.e. "remote has changed since our last
      // sync" — the safe/data-preserving direction.
      // Acknowledged risk: if the user intentionally deleted the file on disk AND
      // remote was independently compacted, this will restore the file. However:
      //   - compacted tombstones are rare (CouchDB compaction is not frequent)
      //   - false-positive pull is recoverable (user re-deletes the file on disk)
      //   - false-negative tombstone on a valid pull would lose remote data
      // Lean keep-over-delete per the plan's data-loss bar.
      // NOTE to Cycle 3 wiring author: Cycle 3 builds remoteRevs over
      // union(localDocIds, vaultFileDocIds) — not_found here means the doc was
      // never synced to the queried remote OR the tombstone was compacted away.
      // If this cell fires often in production, consider checking local _rev
      // prefix (1-) as a "never synced" signal.
      if (localDoc._rev !== undefined && localDoc._rev === remote?.rev) {
        // AC2.3a: rev-equal → user deleted on disk during outage → tombstone
        actions.push({ kind: "tombstone", docId });
      } else {
        // AC2.3b (rev differs) or remote absent (not_found — see off-table note above)
        actions.push({ kind: "pull", path });
      }
    }
  }

  return actions;
}
