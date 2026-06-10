# Spike: Obsidian folder-operation event semantics

**Question:** When a user deletes / trashes / renames a FOLDER, does Obsidian fire
`vault.on('delete'|'rename')` once per descendant file, or one coarse folder-level event?
This gates whether the plugin's live delete path needs descendant-tombstoning at all, and
whether the rename "data-loss" path is real.

**Method:** Isolated Obsidian instance (`--user-data-dir` → separate process, own config,
does not touch the real vaults) launched with `--remote-debugging-port=9222`, auto-opening a
throwaway test vault (`F`, `G`, `H`, `X` folders, each with `a.md`, `b.md`, `sub/c.md`).
Driven over the Chrome DevTools Protocol (`probe.mjs`, zero deps): register `vault.on`
listeners, then trigger the real APIs and capture every event `{ev, path, isFolder, oldPath}`.

**Environment:** Obsidian **1.7.4** desktop (macOS, Electron 31.6.0). NOTE: production
`minAppVersion` is 1.11.4 — newer than tested, though per-descendant events are long-standing
behaviour. **iOS NOT tested** (CDP method is desktop-only).

## Result — folder operations fire ONE EVENT PER DESCENDANT (not coarse)

```
operation                            events
-----------------------------------  ----------------------------------------------------------
vault.delete(F)        (UI "Delete") delete ×5: F/a.md, F/b.md, F/sub, F/sub/c.md, F   (children + self)
vault.trash(G, false)  (UI "Trash")  delete ×5: same shape
fileManager.renameFile(H→H2) (move)  rename ×5: H→H2 AND each child H/x → H2/x with oldPath set
external rm -rf X       (FS delete)   delete ×5: X/a.md, X/b.md, X/sub/c.md, X/sub, X
```

Every descendant FILE gets its own `delete` (or `rename`) event. The folder itself also gets
one (path = folder, `isFolder:true`). Even an OUTSIDE filesystem deletion (`rm -rf`) is
reconciled by Obsidian's watcher into per-descendant `delete` events.

## Conclusions

1. **The live folder-delete path was already correct on desktop.** The original
   `markDeletedInPouch` (single exact-docId tombstone) receives a `delete` event per child →
   tombstones each. `tombstoneWithDescendants` is **redundant-but-harmless** (idempotent),
   not the bug fix it was framed as. The folder-level event (`file/F`) is a 404 no-op.
2. **The rename P0 does not trigger on desktop.** Per-child `rename` events → each child hits
   `onVaultEvent` `change(newFilePath)` with `kind === "file"` → pushed under the new path.
   The coarse-folder-event data-loss path (delete-old + skip-folder-change) never occurs.
3. **The real remaining gap is narrower than assumed:** genuine no-event cases — app killed
   mid-operation, deletions while the plugin is not running, and **iOS** (untested here).
   That is reconcile-backstop territory, not descendant-sweep territory.

## Mobile code path — same result (`probe-mobile.mjs`)

Re-ran the experiment under Obsidian's built-in `app.emulateMobile(true)` (`isMobile:true`
verified). **Identical** — folder delete / trash / rename / external-rm all fire one event PER
DESCENDANT. So Obsidian's MOBILE code path also fires per-descendant events; the live folder-delete
path is correct on mobile too, and the sweep is a redundant-but-harmless safety net there as well.

## Caveats / follow-ups
- **Real iOS Capacitor/iCloud FS layer unverified.** `emulateMobile` flips `Platform.isMobile` and
  the mobile code branches but still runs on the desktop Node FS — it does not reproduce the iOS
  file provider / iCloud / Obsidian-Sync mobile path. The in-app delete/rename path (shared core)
  is confirmed per-descendant; only sync-driven external mutations on a real device remain untested.
  A real-device check is now low-priority insurance, not a blocker.
- **Version gap** (1.7.4 tested vs 1.11.4 prod) — almost certainly identical, not confirmed.
- If a real ghost-file symptom existed on desktop, look elsewhere for the cause — a strong
  candidate is the silently-swallowed tombstone failure (cold-review FIX #1), not missing events.

## Repro
```
zsh ../../../.claude/jobs/<job>/tmp/setup-probe.sh   # (see setup-probe.sh contents)
open -na /Applications/Obsidian.app --args --user-data-dir=<udata> --remote-debugging-port=9222
node probe.mjs
pkill -f "user-data-dir=<udata>"
```
Disposable spike — do not copy `probe.mjs` into production.
