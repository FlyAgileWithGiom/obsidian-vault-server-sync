#!/usr/bin/env node
/**
 * CLI entry-point for the state.json -> PouchDB migration dry-run.
 *
 * Usage:
 *   node dist/migrate-state-to-pouchdb.js --dry-run <state.json path>
 *
 * The --dry-run flag reads and analyses state.json WITHOUT writing to PouchDB
 * or renaming the file. Reports how many entries would be migrated/skipped.
 *
 * This script is used for the pre-migration gate check (Gate 1 in the plan)
 * before the daemon is switched to PouchDB mode.
 */

import { runConverter } from "./converter";
import * as path from "node:path";
import * as os from "node:os";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const statePath = args.find(a => !a.startsWith("--"));

if (!statePath) {
  console.error("Usage: migrate-state-to-pouchdb [--dry-run] <path-to-state.json>");
  process.exit(1);
}

const absStatePath = path.resolve(statePath);

// For dry-run we don't need a real PouchDB — pass a no-op stub
const stubDb = {
  async info() { return { db_name: "stub", doc_count: 0, update_seq: 0 }; },
  async bulkDocs() { return []; },
} as never;

// pouchDir is only used to write the marker — irrelevant for dry-run
const pouchDir = path.join(os.tmpdir(), "vault-sync-dry-run-pouch");

console.log(`[vault-sync] Converter ${dryRun ? "DRY-RUN" : "LIVE"} on: ${absStatePath}`);

runConverter(absStatePath, pouchDir, stubDb, dryRun)
  .then(result => {
    console.log("\n--- Converter result ---");
    console.log(`  Known entries ${dryRun ? "that would be migrated" : "migrated"}: ${result.migrated}`);
    console.log(`  Tombstoned skipped:  ${result.tombstonedSkipped}`);
    console.log(`  Orphan skipped:      ${result.orphanSkipped}`);
    console.log(`  Already migrated:    ${result.alreadyMigrated}`);
    console.log(`  No state file:       ${result.noStateFile}`);
    process.exit(0);
  })
  .catch(e => {
    console.error("[vault-sync] Converter failed:", e);
    process.exit(1);
  });
