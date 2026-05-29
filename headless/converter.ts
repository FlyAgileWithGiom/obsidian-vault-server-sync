/**
 * Converter: state.json revMap -> PouchDB local docs
 *
 * Migrates the v1.14.0 JsonStateStore (state.json) revision map to PouchDB
 * local docs so the daemon can resume without re-pulling all docs from
 * CouchDB on first startup after the v2.0 upgrade.
 *
 * Algorithm (Decision D3 in v2-unify-pouchdb-plan.md):
 *   1. Read statePath -> JSON -> parse "vault-sync-revmap" value
 *   2. If db.info().doc_count > 0 -> return 0 (idempotent, already migrated)
 *   3. Filter: keep only state:"known" entries
 *      - tombstoned: PouchDB will pull their deletion on first sync (correct)
 *      - orphan: let PouchDB resolve cleanly
 *   4. Insert via bulkDocs({new_edits:false}) to preserve existing _rev values
 *   5. Write .migration-complete marker to pouchDir
 *   6. Rename state.json -> state.json.migrated (rollback possible)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { RevMap } from "../src/types";
import type PouchDB from "pouchdb-browser";

const REVMAP_KEY = "vault-sync-revmap";
const MIGRATION_MARKER = ".migration-complete";

export interface ConverterResult {
  /** Number of known entries migrated to PouchDB. */
  migrated: number;
  /** Number of tombstoned entries skipped (Decision D3). */
  tombstonedSkipped: number;
  /** Number of orphan entries skipped (Decision D3). */
  orphanSkipped: number;
  /** True if migration was skipped because PouchDB already had docs. */
  alreadyMigrated: boolean;
  /** True if state.json was absent or malformed (no-op). */
  noStateFile: boolean;
}

/**
 * Run the converter.
 *
 * @param statePath  Absolute path to state.json
 * @param pouchDir   Absolute path to the PouchDB LevelDB directory
 * @param db         PouchDB instance (local, node variant)
 * @param dryRun     If true, read and analyse only — do NOT write to PouchDB or
 *                   rename state.json. Logs statistics and returns result.
 */
export async function runConverter(
  statePath: string,
  pouchDir: string,
  db: InstanceType<typeof PouchDB>,
  dryRun = false,
): Promise<ConverterResult> {
  const result: ConverterResult = {
    migrated: 0,
    tombstonedSkipped: 0,
    orphanSkipped: 0,
    alreadyMigrated: false,
    noStateFile: false,
  };

  // Step 1: Read and parse state.json
  let revMap: RevMap;
  try {
    const raw = fs.readFileSync(statePath, "utf-8");
    const parsed: Record<string, string> = JSON.parse(raw);
    const revMapRaw = parsed[REVMAP_KEY];
    if (!revMapRaw) {
      // Key absent — state.json may be from an older format or empty
      result.noStateFile = true;
      console.log("[vault-sync] Converter: no vault-sync-revmap key in state.json — skipping");
      return result;
    }
    revMap = JSON.parse(revMapRaw) as RevMap;
  } catch {
    // File absent, unreadable, or malformed JSON — no-op, PouchDB will fresh-pull
    result.noStateFile = true;
    console.log("[vault-sync] Converter: state.json absent or malformed — skipping (PouchDB will fresh-pull)");
    return result;
  }

  // Step 2: Idempotency check — skip if PouchDB already has docs
  if (!dryRun) {
    try {
      const info = await db.info();
      if (info.doc_count > 0) {
        result.alreadyMigrated = true;
        console.log(`[vault-sync] Converter: PouchDB already has ${info.doc_count} docs — skipping migration`);
        return result;
      }
    } catch (e) {
      console.error("[vault-sync] Converter: could not query PouchDB info:", e);
      return result;
    }
  }

  // Step 3: Filter entries — keep only state:"known"
  const knownEntries: Array<{ docId: string; rev: string; mtime: number }> = [];
  for (const [docId, entry] of Object.entries(revMap)) {
    if (entry.state === "known") {
      knownEntries.push({ docId, rev: entry.rev, mtime: entry.mtime });
    } else if (entry.state === "tombstoned") {
      result.tombstonedSkipped++;
    } else {
      // "orphan" or unknown states
      result.orphanSkipped++;
    }
  }

  if (dryRun) {
    result.migrated = knownEntries.length;
    console.log(
      `[vault-sync] Converter dry-run: ${knownEntries.length} known entries would be migrated, ` +
      `${result.tombstonedSkipped} tombstoned skipped, ${result.orphanSkipped} orphan skipped`,
    );
    return result;
  }

  if (knownEntries.length === 0) {
    console.log("[vault-sync] Converter: no known entries to migrate");
    await writeMarker(pouchDir);
    await renameStateFile(statePath);
    return result;
  }

  // Step 4: Build PouchDB docs preserving existing _rev values.
  // new_edits:false = insert with the exact _rev from state.json; PouchDB
  // treats these as known revisions and skips re-generating ids. This is
  // non-negotiable — without it PouchDB would generate new _revs, defeating
  // the purpose of migration (the remote sync would see them as new docs).
  const docs = knownEntries.map(({ docId, rev, mtime }) => ({
    _id: docId,
    _rev: rev,
    // Minimal doc shape — PouchDB only needs _id and _rev to track the revision.
    // The actual content will be delivered by CouchDB replication on next sync.
    // We set mtime so the LWW resolver has a reference point if conflicts arise.
    mtime,
    // content and deleted are intentionally omitted — they will come from CouchDB.
  }));

  console.log(`[vault-sync] Converter: migrating ${docs.length} known entries to PouchDB...`);

  try {
    const results = await (db as unknown as {
      bulkDocs(
        docs: object[],
        opts: { new_edits: boolean },
      ): Promise<Array<{ ok?: boolean; error?: boolean; message?: string }>>;
    }).bulkDocs(docs, { new_edits: false });

    // Count successes (ok: true) and soft failures
    let successCount = 0;
    let errorCount = 0;
    for (const r of results) {
      if (r.ok) successCount++;
      else if (r.error) errorCount++;
    }
    result.migrated = successCount;

    if (errorCount > 0) {
      console.warn(
        `[vault-sync] Converter: ${errorCount} docs failed to insert (non-fatal — will sync from CouchDB)`,
      );
    }

    console.log(`[vault-sync] Converter: migrated ${successCount} docs from state.json`);
  } catch (e) {
    console.error("[vault-sync] Converter: bulkDocs failed:", e);
    // Do NOT rename state.json — safe to retry on next start
    return result;
  }

  // Step 5: Write migration marker
  await writeMarker(pouchDir);

  // Step 6: Rename state.json -> state.json.migrated
  // Only after bulkDocs succeeds — rollback is possible by reversing the rename.
  await renameStateFile(statePath);

  return result;
}

async function writeMarker(pouchDir: string): Promise<void> {
  try {
    const markerPath = path.join(pouchDir, MIGRATION_MARKER);
    fs.mkdirSync(pouchDir, { recursive: true });
    fs.writeFileSync(markerPath, new Date().toISOString(), "utf-8");
  } catch (e) {
    // Non-fatal — marker is informational only
    console.warn("[vault-sync] Converter: could not write migration marker:", e);
  }
}

async function renameStateFile(statePath: string): Promise<void> {
  try {
    fs.renameSync(statePath, statePath + ".migrated");
    console.log(
      "[vault-sync] Converter: renamed state.json -> state.json.migrated (rollback: reverse rename)",
    );
  } catch (e) {
    // Non-fatal — state.json left in place; idempotency check will skip on next start
    console.warn("[vault-sync] Converter: could not rename state.json:", e);
  }
}
