# Binary-backfill progress: deliberate Pattern B trade-off

## Follow-up: Precise binary-backfill progress requires Pattern A or a periodic server count

During binary-backfill (Pattern B — the unfiltered live `db.sync` that backfills attachments after phase-1 text pull), an honest "attachments X / Y" meter is not computable from the feed alone. The combined `db.sync` `pending` count covers the entire changes feed — text docs already present locally (skipped via `revs_diff`), binary attachments, and tombstones (~8000 in the observed case) — so neither the numerator (docs actually written) nor the denominator (22874 = full DB change count) maps to "binary attachments remaining". The UI therefore suppresses `pullProgress` during this phase rather than show a misleading ratio. The "Notes ready — attachments syncing in background" message is the honest, correct status.

To get a precise "attachments X / Y" progress meter two approaches would work: (1) **Pattern A** — dedicate a separate `replicate.from` replication for binaries using a `{ _attachments: { $exists: true } }` selector, whose `pending` count is attachments-only; or (2) **a periodic server count** — query `db.info()` or a count-by-selector endpoint before and during backfill to compute remaining. Both approaches add complexity not justified at the current scale. The imprecise-but-honest null meter is the deliberate Pattern B trade-off until the user's vault grows large enough that attachment-sync visibility becomes essential UX.

Refs #74.
