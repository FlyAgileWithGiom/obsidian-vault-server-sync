/**
 * fetchRemoteRevs — batched, retried remote allDocs helper.
 *
 * Fetches the rev/deleted status of a set of doc ids from CouchDB using the
 * same batched+retried allDocs loop that the converter's phantom check uses.
 *
 * WHY batching is non-negotiable (AC2.0-bis):
 *   makeHttpRemoteDb.allDocs is a single unbatched POST. The real Mantu vault
 *   has ~14k docs. A single 14k-key _all_docs POST times out on Fly.io CouchDB.
 *   The converter already proved batching is required. This module is the single
 *   source of truth for that logic — both the converter's phantom check AND the
 *   startup reconciler share this one path (not two copies).
 *
 * Semantics:
 *   - Present doc    → Map entry { rev, deleted: false }
 *   - Tombstoned doc → Map entry { rev, deleted: true }
 *   - not_found/error → NOT in the map at all
 *
 * The "absent from map" contract is load-bearing for callers:
 *   - converter phantom-check: absent OR deleted → phantom → skip
 *   - reconcile (next cycle): must distinguish absent (never existed) from
 *     tombstoned (deleted remotely) — use map.has(id) + map.get(id).deleted.
 *
 * On retry exhaustion the function THROWS — callers must handle this as an
 * abort signal (do not silently treat as "all ids absent").
 */

/** Minimal interface for the remoteDb phantom-check parameter. */
export interface RemoteDbForPhantomCheck {
  allDocs(opts: {
    keys: string[];
    include_docs: false;
  }): Promise<{
    rows: Array<
      | { id: string; key: string; value: { rev: string; deleted?: boolean } }
      | { key: string; error: string }
    >;
  }>;
}

/** Value stored per doc id in the map returned by fetchRemoteRevs. */
export interface RemoteRevEntry {
  rev: string;
  /** true if the remote doc is a tombstone (value.deleted === true). */
  deleted: boolean;
}

/**
 * Batch size for remote allDocs phantom check.
 * 50 ids ≈ ~3.5 KB body — reduced from 100 to lower per-request load on
 * Fly.io CouchDB, which is prone to timeouts under concurrent batch load.
 */
export const PHANTOM_BATCH_SIZE = 50;
/** Timeout per allDocs batch in ms. Increased from 30s to tolerate Fly.io latency spikes. */
export const PHANTOM_BATCH_TIMEOUT_MS = 60_000;
/** Max retries per batch before aborting the entire fetch. */
export const PHANTOM_BATCH_MAX_RETRIES = 3;
/** Base backoff in ms for batch retries (doubles each attempt: 1s, 2s, 4s). */
export const PHANTOM_BATCH_BACKOFF_MS = 1_000;
/** Delay between batches in ms — avoids rate-limiting on Fly.io CouchDB. */
export const PHANTOM_BATCH_DELAY_MS = 500;

/**
 * Fetch the rev and deleted status for a set of doc ids from a remote CouchDB.
 *
 * @param remoteDb  Remote DB instance — only allDocs is called.
 * @param ids       Doc ids to query. Deduplicated order is preserved per-batch.
 * @returns         Map<docId, { rev, deleted }> for ids that exist remotely
 *                  (present or tombstoned). Ids that are not_found / error are
 *                  absent from the returned map.
 * @throws          If any batch exhausts all retries (abort — never silently
 *                  treat failed batches as "absent").
 */
export async function fetchRemoteRevs(
  remoteDb: RemoteDbForPhantomCheck,
  ids: string[],
): Promise<Map<string, RemoteRevEntry>> {
  const result = new Map<string, RemoteRevEntry>();

  for (let i = 0; i < ids.length; i += PHANTOM_BATCH_SIZE) {
    const batchIds = ids.slice(i, i + PHANTOM_BATCH_SIZE);
    const batchNum = Math.floor(i / PHANTOM_BATCH_SIZE) + 1;
    let rows: Array<{ id?: string; key: string; value?: { rev: string; deleted?: boolean }; error?: string }>;

    // Retry loop: up to PHANTOM_BATCH_MAX_RETRIES attempts with exponential backoff.
    // On exhaustion, throw rather than treating as "absent" — silent fallback would
    // allow unverified ids to look like not_found every boot, disabling the feature.
    let lastError: unknown;
    let succeeded = false;

    for (let attempt = 0; attempt <= PHANTOM_BATCH_MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const backoffMs = PHANTOM_BATCH_BACKOFF_MS * Math.pow(2, attempt - 1);
        console.warn(
          `[vault-sync] fetchRemoteRevs: batch ${batchNum} retry ${attempt}/${PHANTOM_BATCH_MAX_RETRIES} ` +
          `after ${backoffMs}ms (error: ${lastError})`,
        );
        await new Promise(r => setTimeout(r, backoffMs));
      }

      try {
        const batchPromise = remoteDb.allDocs({ keys: batchIds, include_docs: false });
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`allDocs batch timed out after ${PHANTOM_BATCH_TIMEOUT_MS}ms`)),
            PHANTOM_BATCH_TIMEOUT_MS,
          ),
        );
        const response = await Promise.race([batchPromise, timeoutPromise]);
        rows = response.rows as typeof rows;
        succeeded = true;
        break;
      } catch (e) {
        lastError = e;
      }
    }

    if (!succeeded) {
      throw new Error(
        `[vault-sync] fetchRemoteRevs: phantom check failed for batch ${batchNum} after ` +
        `${PHANTOM_BATCH_MAX_RETRIES} retries — aborting migration to avoid acting on incomplete data. ` +
        `Retry when CouchDB is responsive. Last error: ${lastError}`,
      );
    }

    for (const row of rows!) {
      if ("error" in row) {
        // not_found or other error — id absent from map (caller interprets as "remote doesn't have it")
        continue;
      }
      // Present (active) or tombstoned (deleted: true) — include in map
      result.set(row.key, {
        rev: row.value!.rev,
        deleted: row.value!.deleted === true,
      });
    }

    // Inter-batch delay to avoid rate-limiting on Fly.io CouchDB
    if (i + PHANTOM_BATCH_SIZE < ids.length) {
      await new Promise(r => setTimeout(r, PHANTOM_BATCH_DELAY_MS));
    }
  }

  return result;
}
