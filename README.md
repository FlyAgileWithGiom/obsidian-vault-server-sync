# Obsidian Vault Sync (Fly Agile)

Sync an Obsidian vault to CouchDB so it can be read by `vault-server` (a Claude
MCP server). Ships two artifacts from one codebase: an Obsidian plugin
(`fly-vault-sync`) that runs inside Obsidian on desktop and mobile, and a
headless daemon (`vault-sync-daemon`) that syncs a vault on a machine where
Obsidian is not running.

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
