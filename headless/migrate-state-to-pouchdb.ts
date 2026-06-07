/**
 * CLI entry-point for the state.json -> PouchDB migration (dry-run and live).
 * Note: the shebang (#!/usr/bin/env node) is injected by esbuild's banner — not here.
 *
 * Usage:
 *   node dist/migrate-state-to-pouchdb.js --dry-run --state <state.json> [--remote <couchdb-url>]
 *   node dist/migrate-state-to-pouchdb.js --state <state.json> [--remote <couchdb-url>]
 *
 * --dry-run: reads and analyses state.json WITHOUT writing to PouchDB or
 *            renaming the file. Reports how many entries would be migrated/skipped.
 *
 * --state:   path to state.json (required)
 * --remote:  CouchDB URL for phantom detection. When provided, known entries
 *            absent or deleted in CouchDB are skipped rather than migrated to
 *            prevent phantom push on next sync (e.g. .DS_Store, .git/* entries).
 *
 * This script is used for the pre-migration gate check (Gate 1 in the plan)
 * before the daemon is switched to PouchDB mode.
 */

import { runConverter, type RemoteDbForPhantomCheck } from "./converter";
import * as path from "node:path";
import * as os from "node:os";
import * as https from "node:https";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

// Parse --state <path> (flag style) or fallback to first positional arg
const stateIdx = args.indexOf("--state");
const statePath = stateIdx !== -1
  ? args[stateIdx + 1]
  : args.find(a => !a.startsWith("--"));

const remoteIdx = args.indexOf("--remote");
const remoteUrl = remoteIdx !== -1 ? args[remoteIdx + 1] : undefined;

if (!statePath) {
  console.error("Usage: migrate-state-to-pouchdb [--dry-run] --state <path-to-state.json> [--remote <couchdb-url>]");
  process.exit(1);
}

const absStatePath = path.resolve(statePath);

// For dry-run we don't need a local PouchDB — pass a no-op stub
const stubDb = {
  async info() { return { db_name: "stub", doc_count: 0, update_seq: 0 }; },
  async bulkDocs() { return []; },
} as never;

// pouchDir is only used to write the marker — irrelevant for dry-run
const pouchDir = path.join(os.tmpdir(), "vault-sync-dry-run-pouch");

console.log(`[vault-sync] Converter ${dryRun ? "DRY-RUN" : "LIVE"} on: ${absStatePath}`);
if (remoteUrl) {
  // Strip any user:pass@ from the URL before logging — an operator-supplied
  // --remote can carry inline credentials that would otherwise hit stdout/logs.
  const sanitized = new URL(remoteUrl);
  sanitized.username = "";
  sanitized.password = "";
  console.log(`[vault-sync] Remote phantom check: ${sanitized.href}`);
}

/**
 * Build a RemoteDbForPhantomCheck that uses node:https directly.
 * pouchdb-node's HTTP adapter hangs on large _all_docs?keys requests (keep-alive
 * issues with Fly.io / CouchDB). node:https with explicit keep-alive disabled works.
 */
function makeHttpRemoteDb(rawUrl: string): RemoteDbForPhantomCheck {
  const parsed = new URL(rawUrl);
  const auth = parsed.username
    ? `Basic ${Buffer.from(`${parsed.username}:${parsed.password}`).toString("base64")}`
    : undefined;

  // Strip credentials from the URL for the request
  const reqUrl = new URL(rawUrl);
  reqUrl.username = "";
  reqUrl.password = "";
  const baseUrl = reqUrl.toString().replace(/\/$/, "");

  return {
    async allDocs(opts: { keys: string[]; include_docs: false }) {
      const endpoint = `${baseUrl}/_all_docs?include_docs=false`;
      const body = JSON.stringify({ keys: opts.keys });

      return new Promise((resolve, reject) => {
        const reqOptions = new URL(endpoint);
        const req = https.request(
          {
            hostname: reqOptions.hostname,
            port: reqOptions.port || 443,
            path: reqOptions.pathname + reqOptions.search,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
              ...(auth ? { "Authorization": auth } : {}),
              // Disable keep-alive to avoid socket hang-up on Fly.io CouchDB
              "Connection": "close",
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => {
              try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
                resolve(parsed);
              } catch (e) {
                reject(new Error(`Failed to parse _all_docs response: ${e}`));
              }
            });
            res.on("error", reject);
          },
        );

        req.on("error", reject);
        req.write(body);
        req.end();
      });
    },
  };
}

async function main() {
  let remoteDb: RemoteDbForPhantomCheck | undefined;

  if (remoteUrl) {
    remoteDb = makeHttpRemoteDb(remoteUrl);
  }

  const result = await runConverter(absStatePath, pouchDir, stubDb, dryRun, remoteDb);

  const total = result.migrated + result.tombstonedSkipped + result.orphanSkipped + result.phantomSkipped;

  console.log("\n--- Converter result ---");
  console.log(`  Known entries ${dryRun ? "that would be migrated" : "migrated"}: ${result.migrated}`);
  console.log(`  Tombstoned skipped:  ${result.tombstonedSkipped}`);
  console.log(`  Orphan skipped:      ${result.orphanSkipped}`);
  console.log(`  Phantoms skipped:    ${result.phantomSkipped}`);
  console.log(`  Total accounted:     ${total}`);
  console.log(`  Already migrated:    ${result.alreadyMigrated}`);
  console.log(`  No state file:       ${result.noStateFile}`);
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error("[vault-sync] Converter failed:", e);
    process.exit(1);
  });
