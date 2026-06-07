# ADR: Move CouchDB sync credentials out of the synced vault file

Refs #78. Designed with the `security-specialist` + `architecture-reviewer` agents; decisions confirmed with Giom.

## Context

`.vault-sync.json` lives at the vault root and stores `couchDbUser` + `couchDbPassword` in plaintext. For a vault under Dropbox (the Mantu vault), that file replicates to the Dropbox cloud, every linked device, and Dropbox version history — none under our control (CWE-312, cleartext storage of secrets). The mitigating factor is that the credential is a CouchDB *member* (non-admin) scoped to one DB, so the blast radius is that vault's data. Still, the secret must not ride the synced content artifact.

## Decision

Split persistence by sensitivity behind a `SecretStore` seam (DIP). Only non-secret config stays in `.vault-sync.json`; secrets move to a per-runtime store.

```
.vault-sync.json (stays, syncs):  couchDbUrl, couchDbName, excludePatterns
secret store (per platform):      couchDbUser, couchDbPassword

consumer                       secret backend
-----------------------------  --------------------------------------------
Obsidian plugin (desktop+iOS)  app.secretStorage   (Obsidian >= 1.11.4; not synced)
Headless daemon (macOS Node)   macOS Keychain      (security CLI; Giom's explicit choice over a file)
K8s initContainer              SealedSecret        (already separate — out of scope)
```

`couchDbUser`/`couchDbPassword` remain fields on `VaultSyncSettings`. Only *persistence* splits by sensitivity: credentials are still assembled into the in-memory `VaultSyncSettings` at the engine boundary, so the sync engine and the remote-URL builder are unchanged. The credential *value* does not change — only its location on disk — so no re-sync and no destructive re-pull are expected.

## The SecretStore seam

`src/secret-store.ts` defines an async `SecretStore` interface (`get`/`set`/`isAvailable`). Async because the same contract must fit both Obsidian's synchronous `secretStorage` API and the inherently-async macOS `security` CLI (child process).

- `SecretStorageSecretStore` (plugin) wraps `app.secretStorage`, feature-detected at runtime.
- `KeychainSecretStore` (daemon, `headless/keychain-secret-store.ts`) wraps the `security` CLI.

Obsidian secret ids must be lowercase-alphanumeric-with-dashes, so the logical credentials map to fixed ids — `vault-sync-couch-user` / `vault-sync-couch-password` — which double as the Keychain account names under one service constant (`com.flyagile.vault-sync`). One source of truth across both consumers.

`resolveSecret()` is the single precedence resolver shared by plugin and daemon:

```
env (VAULT_SYNC_COUCH_USER / VAULT_SYNC_COUCH_PASSWORD)  >  secret store  >  legacy in-vault
```

## Two-phase migration

The in-vault file is read by the daemon, the desktop plugin, and iOS at potentially mixed code versions, so deletion of the legacy secret must be deliberate.

- **Phase A — automatic, additive (ships in #78).** On load, if the store has no secret but `.vault-sync.json` still carries one, use it AND copy it into the store (write-new, never delete, never overwrite an existing store secret). Old code still finds the in-vault secret; new code reads the store. Both coexist. Implemented in `applySecretStore()` (plugin) and inside `loadConfig()` (daemon).
- **Phase B — operator-gated, NEVER automatic.** A `migrate-secrets` plugin command and a daemon `--scrub-secrets` flag strip `couchDbUser`/`couchDbPassword` from `.vault-sync.json`. Write-BEFORE-delete: the secret is removed only after confirming BOTH credentials are present in the store, leaving the file otherwise intact. Implemented in `scrubInVaultSecrets()` (plugin) and `scrubInVaultConfig()` (daemon).

## Fail-safe (no destructive resync)

If no credential is found anywhere (env, store, vault), the path degrades to a plain auth failure: `loadConfig`/`loadSettings` return empty credentials (never exit/throw on a missing secret), the remote-URL builder emits a credential-less URL, CouchDB returns a plain 401, and the existing skip-on-fetch-fail path skips reconcile. It must NOT trigger a tombstone-everything / fresh-pull / destructive resync — this repo has a documented history of destructive-resync regressions, and that path is the thing being protected.

Note the deliberate separation in `loadConfig`: a missing/unparseable *file* is still a hard `process.exit(1)` (the file is the only source of `couchDbUrl`/`couchDbName`), but a missing *secret* is not — those two failure modes are kept strictly apart.

## Caveats

### macOS Keychain from a KeepAlive LaunchAgent

The daemon runs under a `KeepAlive` LaunchAgent. If the login keychain is locked, or the item is not authorised for non-interactive access, `security` can BLOCK on a GUI prompt that no headless process can answer. `KeychainSecretStore` therefore bounds every call with a `timeout` + `killSignal` and collapses EVERY failure mode (non-zero exit, not-found, locked, timeout) to `null` on read / a swallowed no-op on write, so the daemon falls back to the legacy in-vault credential rather than wedging. For non-interactive reads to succeed at all, the login keychain must be unlocked and node pre-authorised for the item (a one-time interactive `security add-generic-password -T` grant may be needed). This live Keychain/launchd path cannot be exercised in unit tests — it must be smoke-tested against the real daemon.

### Secret on the security CLI argv

`KeychainSecretStore.set` passes the password as a `security ... -w <value>` argument, briefly visible in the process list (`ps`). The stdin alternative (`-w` with no value) reads interactively and would hang a headless daemon, so the argv form is the deliberate trade-off on a single-user macOS machine. Writes are infrequent (Phase A copy, settings edit).

### Plugin secret write with secretStorage absent

When `app.secretStorage` is absent (an install below 1.11.4 despite the manifest bump), `SecretStorageSecretStore.set` is a no-op. The read fallback still serves any pre-existing in-vault credential, so there is no data loss — but a *newly entered* password on such a runtime is persisted nowhere (store no-op, and never written to the file by design). This is an explicit choice over a write-to-file fallback (consistent with the project's anti-fallback stance): the manifest now requires 1.11.4, so this is an edge case, surfaced here so the choice is deliberate rather than accidental.

## Ops closeout (post-merge, operator-driven — NOT part of #78 implementation)

Dropbox version history retains every secret that ever sat in `.vault-sync.json`. After merge: scrub both vaults (Phase B), re-enter the password per device, purge Dropbox version history, and optionally one final CouchDB password rotation so the canonical secret never touched Dropbox.
