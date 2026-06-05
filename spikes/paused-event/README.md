# Spike: PouchDB `paused` event discrimination

**Purpose**: Determine whether the `paused` event fired by `db.sync` can be used to
detect the caught-up state when no `change` events have fired (device already up to date).

## Findings

Probed against real CouchDB (container `spike-smoke-couchdb`, port 5986).

### Caught-up scenario (initial pull completed before live sync starts)
Event sequence: `active` → `paused(err=undefined)` — **zero `change` events**.

The `err` argument on `paused` is `undefined` in this case; there is no numeric
`pending` to inspect because no `change` ever fired.

### Never-connected / backoff scenario (dead remote, `retry: true`)
Event sequence: `paused(err=undefined)` fires repeatedly — **no `active`, no `change`,
no `error`**. PouchDB hides the connection failure behind silent paused+retry cycles.

### Discriminator
The `err` argument is `undefined` in BOTH cases and cannot discriminate.
The only reliable discriminator is whether `active` (or `change`) fired before `paused`:
caught-up is always preceded by `active`; never-connected is not.

## Fix applied
`liveSyncContacted` flag in `PouchDbSyncEngine.startLiveSync()` — set `true` by
`active` or `change`, reset `false` at session start and on `error`. The `paused`
handler latches ok only when `liveSyncContacted && noOutstandingWork`.

See `headless/caught-up-regression.test.ts` for the real-CouchDB regression test.
