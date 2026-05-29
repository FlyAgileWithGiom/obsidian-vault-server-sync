# Spike: mobile text-first sync (Refs #72)

Disposable measurement spike. Code here is NOT production — it answers ONE question
with measurement, not theory.

## Question

Does a SERVER-SIDE-filtered PouchDB replication pull ONLY text docs (~tens of MB)
instead of the full ~8 GB attachment-laden DB?

If the selector is evaluated client-side (docs downloaded then filtered locally) there
is NO bandwidth saving — the resulting scratch db is small in both cases, so db size
alone CANNOT discriminate. The decisive evidence is WIRE BYTES.

## Verdict: YES — server-side filtering works at the wire level

`serverSideSelectorWorks = true`. Phase-1 transferred 64 MB, not 8 GB.

## Method

1. `_changes?filter=_selector` row-count probe (cheap, fail-fast on whether `_attachments`
   is even queryable by the selector engine).
2. End-to-end `scratch.replicate.from(remote, {selector})` with a `fetch` wrapper on the
   REMOTE PouchDB summing `content-length` of every response body = true wire bytes.
3. `checkpoint: 'target'` keeps PouchDB checkpoint `_local` docs on the scratch db, NOT on
   prod — honors prod read-only AND is what makes phase-2 resumable (target keeps checkpoint).

Prod (READ-ONLY): https://sync.fly-agile.com/vault-obsidiannotes (14794 docs, 8.59 GB file)
Scratch (writable): http://localhost:5986

## Measured results

### _changes selector probe (server-side, metadata only)

```
unfiltered _changes rows ............. 22871  (all changes incl. tombstones)
selector {_attachments:{$exists:true}} . 6750  (EXACTLY the binary-doc count)
selector {_attachments:{$exists:false}} 16121  (= 22871 - 6750: text docs + ~8076 tombstones)
```

The inverse selector returning exactly 6750 proves `_attachments` IS visible to the
selector engine server-side. (The `$exists:false` count is inflated by deleted-doc
tombstones — `doc_del_count` was 8076 — which carry no `_attachments`. Tombstones are
tiny metadata, not a bandwidth concern. Live text docs that materialize = 8305.)

### Phase-1: text-only replication (the headline)

```
wireBytesTotal .... 64.0 MB        <-- NOT 8 GB. Decisive.
  of which _bulk_get  56.8 MB        (doc bodies, all text)
scratch doc_count .. 8305           (the actual notes)
scratch disk file .. 48.2 MB        (active 38.7 MB)
docs WITH _attachments in scratch .. 0
http requests ...... 1261 (419 _bulk_get)
elapsed ............ 580 s          (~10 min, dominated by per-batch round-trips, not payload)
```

`docs_written=31813` in the progress events is a cumulative leaf-rev counter across the
replication, not unique docs — the final db holds 8305 docs. The 64 MB / ~10 min profile
is impossible if 8 GB were on the wire.

### Phase-2: binary docs separable + resumable

```
selector {_attachments:{$exists:true}} pulls binary docs only.
First ~50 binary docs = 37.8 MB on the wire (attachments are heavy per doc).
Cancel at doc_count=50 -> restart -> continued to doc_count=150 (kept 50, added more).
resumable = true  (restart continues forward without re-pulling existing docs)
```

Phase-2 is independently runnable and makes forward progress across cancel/restart with
no data loss, so binaries can trickle in the background at network pace, non-blocking,
after the vault is already usable on text. (The exact mechanism — checkpoint-resume vs
re-walking the changes feed and skipping already-written docs — was not isolated; either
way there is no loss and no full re-pull, which is what matters for the design.)

### Prod read-only honored

Spike issued only GET / `_bulk_get` POST (reads). `checkpoint:'target'` wrote checkpoints
to scratch only. The +1 doc_count / +1 update_seq observed on prod during the run was a
live device editing a real note (most-recent change was a `.md` file), unrelated to the
spike — `_local` checkpoint docs do not increment `doc_count` anyway.

## Implementation recommendation

Use the PouchDB `selector` replication option directly (Mango selector
`{_attachments:{$exists:false}}` for phase-1 text, `{$exists:true}` for phase-2 binaries).
PouchDB translates `selector` into a server-side `_changes?filter=_selector` filter on
CouchDB 3.x, so the bandwidth saving is real. No design-doc filter and no schema change
(no explicit `isBinary` field) are required — `$exists` on `_attachments` is queryable.

Two-phase initial pull:
- Phase 1 (blocking, fast): `replicate.from(remote, {selector:{_attachments:{$exists:false}}, live:false})`
  -> vault usable at ~tens of MB.
- Phase 2 (background, resumable): `replicate.from(remote, {selector:{_attachments:{$exists:true}}, live:false, retry:true})`.
- Then live `sync` for steady state.

## Gotchas

- The "~20 MB text" premise is STALE. Phase-1 measured 64 MB wire / 48 MB disk, ~3x the
  raw content-field size. Cause: `docs_written=31813` vs `scratch_doc_count=8305` = ~3.8
  leaf revisions pulled per doc — this LiveSync vault has conflict-heavy revision trees and
  replication pulls all leaf revs. Design against ~50-65 MB, not 20 MB. Still tens of MB,
  not GB, so text-first remains a massive win — but do not quote 20 MB.
- DB size alone does NOT prove server-side filtering — both client- and server-side end at
  ~tens of MB locally. Always measure wire bytes (fetch wrapper) to be sure.
- `$exists:false` matches deleted-doc tombstones too; the row count overshoots the live
  text-doc count. Harmless (metadata), but don't read it as "filter broke".
- A design-doc `filter` function (JS, runs on every doc server-side) is the fallback if a
  future CouchDB rejects `_selector`, but it is slower server-side and unnecessary here.
- `checkpoint:'target'` is required when the source must stay read-only and for phase-2
  resumability.

## Run it

```
export PROD_URL="https://livesync:...@sync.fly-agile.com/vault-obsidiannotes"
export SCRATCH_URL="http://smoke:smokepass@localhost:5986"
node measure.mjs text            # phase-1 wire-byte measurement
node measure.mjs binary-resume   # phase-2 separability + resumability
```
