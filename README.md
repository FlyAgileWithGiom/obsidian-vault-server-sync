# Obsidian Vault Sync (Fly Agile)

Sync an Obsidian vault to CouchDB so it can be read by `vault-server` (a Claude
MCP server). Ships two artifacts from one codebase: an Obsidian plugin
(`fly-vault-sync`) that runs inside Obsidian on desktop and mobile, and a
headless daemon (`vault-sync-daemon`) that syncs a vault on a machine where
Obsidian is not running.

## Text-first initial sync (v2.1)

As of v2.1.0 the initial pull is **two-phase**, so the vault becomes usable
after downloading only the notes — not after downloading every attachment. On a
real vault the binaries (images, PDFs, other media) dwarf the text: a sample
`vault-obsidiannotes` carries roughly 8,000 text docs but 6,750 binary docs
whose attachments total several GB. The pre-v2.1 pull was a single unfiltered
replication that fetched everything before the vault could be edited — the
blocker on a slow mobile connection.

### How it works

The engine splits `runInitialPull()` into two phases:

```
Phase 1 (blocking, fast)   pull TEXT docs only, server-side filtered
Phase 2 (background)       binaries backfill while the vault is already usable
Steady state               ongoing live bidirectional sync covers both
```

- **Phase 1 — text only.** The pull passes a CouchDB Mango selector so the
  server sends back only documents that have no attachments. On the sample vault
  this is **~64 MB over the wire** (tens of MB, not several GB). When it
  completes the notes are present and editable.
- **Phase 2 — binaries backfill.** The engine then starts the normal live
  bidirectional `db.sync`. The binaries arrive as that sync's natural pull
  backlog, at network pace, while the vault is already in use. **Push stays live
  from the first moment of phase 2**, so anything you write during the backfill
  propagates immediately — your edits are never stranded while gigabytes of
  attachments download. PouchDB runs `revs_diff` before fetching bodies, so the
  text revisions already pulled in phase 1 are not re-downloaded.

This is one code path on every platform (plugin on desktop and mobile, and the
daemon) — there is no mobile-only fork. The only difference is priority: the
daemon runs the backfill to completion (its copy is the canonical backup),
while on mobile the backfill is low-priority and resumes from its checkpoint
after the app is backgrounded.

### `TEXT_SELECTOR` — the filter mechanism

Phase 1 uses a PouchDB `selector` replication option, a Mango query on the
`_attachments` field:

```
TEXT_SELECTOR = { _attachments: { $exists: false } }
```

PouchDB translates this into a server-side `_changes?filter=_selector` filter on
CouchDB 3.x, so the binary docs never cross the wire during phase 1. There is no
design-doc filter function and no schema change — text docs are distinguished
purely by the absence of `_attachments`. (One harmless quirk: the selector also
matches deleted-doc tombstones, which are tiny metadata, so progress counters
can read higher than the live text-doc count. That is expected, not a filter
fault.)

### Diagnostics — `syncPhase` and `binaryProgress`

Because the vault is usable after phase 1 but the binaries are not all here yet,
the sync status must not read "Synced" prematurely. A `syncPhase` field, distinct
from the connection state, carries the real progress:

```
syncPhase: 'idle' | 'text-pull' | 'text-ready' | 'binary-backfill' | 'complete'
```

At `text-ready` and during `binary-backfill` the connection state deliberately
stays **`syncing`**, never `ok`, so the UI never claims a full sync while
attachments are still arriving. The settings tab renders:

```
Sync phase: <phase>
Notes ready — attachments syncing in background      (shown at text-ready / backfill)
Attachments: <fetched> / <total>                     (when a count is available)
```

A one-shot notice ("Vault Sync: Notes ready, attachments downloading in
background") fires at the `text-ready` transition so the win is visible the
moment the notes land.

The companion `binaryProgress` field reports `{ fetched, total }` when a count is
available. Note that with the live-sync backfill the pending count is the live
`db.sync` backlog (combined remaining work), not an attachments-exact
"N / 6,750" counter — it is a pending indicator, not a precise attachment tally.

## Daemon v2 (PouchDB)

As of v2.0.0 the plugin and the daemon share a single sync engine built on
**PouchDB**. There is no longer a choice of sync strategy — PouchDB is the only
engine on every platform.

### One PouchDB engine, two runtimes

Both sides drive the same `PouchDbSyncEngine` + `PouchDbFsBridge` code. The only
difference is the PouchDB adapter underneath:

- **Plugin** — `pouchdb-browser` (IndexedDB), running inside Obsidian.
- **Daemon** — `pouchdb-node` backed by **LevelDB** (the native `leveldown`
  add-on), running headless under Node.js.

Because both runtimes use the same doc-ID encoding, document shapes, and binary
detection, the plugin and the daemon produce byte-compatible documents and
converge cleanly through CouchDB replication.

### LevelDB storage location

The daemon keeps its PouchDB data in a LevelDB directory, one per database name:

```
~/Library/Application Support/vault-sync-daemon/<dbName>/pouch/
```

(`<dbName>` is the CouchDB database name; on Linux the base is
`~/.config/vault-sync-daemon/...`, on Windows `%APPDATA%/vault-sync-daemon/...`.)

### One-time migration: state.json -> PouchDB

A v1.14 daemon tracked its sync state in a `state.json` revision map. On the
first v2.0 startup, a converter migrates that revision map into PouchDB local
docs so the daemon can resume without re-pulling every document from CouchDB.
The migration is one-time and idempotent (it is skipped if PouchDB already holds
documents).

On success the converter renames the old state file:

```
state.json  ->  state.json.migrated
```

**Rollback** is the reverse rename: stop the daemon, rename
`state.json.migrated` back to `state.json`, and downgrade to a v1.14 build. The
`.migrated` file is kept rather than deleted so this remains possible.

### Phantom filter

Some entries in the old `state.json` were indexed locally but never pushed to
CouchDB — for example `.DS_Store` or `.git/*` files that the daemon's filter
rules block. Migrating those would re-pollute CouchDB on the next sync.

To prevent that, the converter runs a **phantom filter**: for each candidate
entry it checks CouchDB, and skips any entry that is absent there or already
deleted (remotely tombstoned). Only entries that genuinely exist in CouchDB are
migrated; the rest are left for PouchDB to reconcile from the server on first
sync. If the phantom check cannot reach CouchDB, the migration aborts rather
than guessing — it is safe to retry once CouchDB is responsive.

## Build

Build all artifacts (plugin, daemon, migration CLI):

```
node esbuild.config.mjs production
```

The Obsidian plugin bundle is emitted to `dist/plugin/` (a small `main.js` plus
a lazily loaded `pouchdb-browser` chunk via code splitting). The daemon is
emitted to `dist/headless.js`; its native dependencies (`leveldown`,
`fsevents`) are left external and resolved from `node_modules/` at runtime.

### Release artifact (BRAT)

BRAT installs an Obsidian plugin from a single `main.js`. The unified
BRAT-friendly bundle is produced by:

```
npm run build:release
```

which writes `dist/release/main.js` (a single minified CJS bundle) alongside
`manifest.json` and `styles.css`. That single `main.js` is the release artifact
BRAT consumes.
