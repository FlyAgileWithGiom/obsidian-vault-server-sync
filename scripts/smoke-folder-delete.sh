#!/usr/bin/env bash
# REAL-artifact smoke test for FOLDER DELETION propagation (#81).
#
# Exercises the LIVE folder-delete path end-to-end against real pouchdb-node + real CouchDB:
#   daemon boots → user CREATES a folder of notes (after boot, so the watcher pushes them) →
#   user DELETES the folder on disk → bridge tombstones every descendant → replicates to CouchDB.
#
# Push-gated: the delete assertions only run if the push phase actually landed the docs in
# CouchDB (otherwise a 404 means "never existed", not "tombstoned" — a false pass).
#
# Adversarial assertions on delete:
#   - every descendant of the deleted folder is TOMBSTONED in CouchDB (was present, now 404)
#   - a SIBLING note outside the folder stays LIVE (no over-deletion / data loss)
#   - a prefix-decoy "Projects.md" stays LIVE (verifies the "/" range boundary on real data)
#
# Requires: dist/headless.js built from the branch under test; smoke CouchDB on :5986.
set -uo pipefail

COUCH="http://smoke:smokepass@localhost:5986"
DB="vault-folderdelete-verify"
REPO="/Users/guillaume/dev/tools/mcp/servers/obsidian-vault-server-sync"
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
present() { curl -s "$COUCH/$DB/$1" | grep -q '"content"'; }
deleted() { [ "$(curl -s -o /dev/null -w '%{http_code}' "$COUCH/$DB/$1")" = "404" ]; }

echo "=== fresh test db ==="
curl -s -X DELETE "$COUCH/$DB" >/dev/null
curl -s -X PUT "$COUCH/$DB" >/dev/null; echo "db=$DB"

echo "=== temp vault (empty except config) ==="
SMOKE=$(mktemp -d); mkdir -p "$SMOKE/vault"
cat > "$SMOKE/vault/.vault-sync.json" <<EOF
{"couchDbUrl":"http://localhost:5986","couchDbName":"$DB","couchDbUser":"smoke","couchDbPassword":"smokepass","syncDebounceMs":300,"excludePatterns":[".trash/",".obsidian/"]}
EOF
echo "SMOKE=$SMOKE"

echo "=== launch daemon, let first-run pull + live sync arm ==="
cd "$REPO"
# Isolation: wipe ONLY this smoke db's state dir (never prod), force smoke creds via env
# (env > Keychain > in-vault) so the test daemon can never use the user's prod credentials.
rm -rf "$HOME/Library/Application Support/vault-sync-daemon/$DB"
VAULT_SYNC_COUCH_USER=smoke VAULT_SYNC_COUCH_PASSWORD=smokepass \
  DAEMON_V2=1 node dist/headless.js "$SMOKE/vault" > "$SMOKE/d.log" 2>&1 &
DPID=$!; echo "pid=$DPID"; sleep 14

echo "=== CREATE folder + sibling decoys AFTER boot (watcher → push) ==="
mkdir -p "$SMOKE/vault/Projects/sub"; sleep 1
printf '# a\n'           > "$SMOKE/vault/Projects/a.md"
printf '# b\n'           > "$SMOKE/vault/Projects/b.md"
printf '# c\n'           > "$SMOKE/vault/Projects/sub/c.md"
printf '# keep\n'        > "$SMOKE/vault/keep.md"            # unrelated sibling — must survive
printf '# prefix decoy\n'> "$SMOKE/vault/Projects.md"        # shares prefix — must survive
sleep 12

echo "=== assert push landed (GATE) ==="
PUSHED=0
present "file%2FProjects%2Fa.md"       && ok "Projects/a.md pushed"       && PUSHED=$((PUSHED+1)) || bad "Projects/a.md NOT pushed"
present "file%2FProjects%2Fb.md"       && ok "Projects/b.md pushed"       && PUSHED=$((PUSHED+1)) || bad "Projects/b.md NOT pushed"
present "file%2FProjects%2Fsub%2Fc.md" && ok "Projects/sub/c.md pushed"   && PUSHED=$((PUSHED+1)) || bad "Projects/sub/c.md NOT pushed"
present "file%2Fkeep.md"               && ok "keep.md pushed"             && PUSHED=$((PUSHED+1)) || bad "keep.md NOT pushed"
present "file%2FProjects.md"           && ok "Projects.md pushed"         && PUSHED=$((PUSHED+1)) || bad "Projects.md NOT pushed"

if [ "$PUSHED" -ne 5 ]; then
  echo ">>> PUSH GATE FAILED ($PUSHED/5) — delete assertions would be meaningless, skipping."
  kill "$DPID" 2>/dev/null; sleep 1; kill -9 "$DPID" 2>/dev/null
  echo "########## daemon log ##########"; tail -40 "$SMOKE/d.log"
  echo "########## RESULT: $PASS passed, $FAIL failed (push gate) ##########"
  exit 1
fi

echo "=== DELETE the folder on disk (the real-world action) ==="
rm -rf "$SMOKE/vault/Projects"
sleep 12

echo "=== assert delete: every descendant TOMBSTONED (was present → now 404) ==="
deleted "file%2FProjects%2Fa.md"       && ok "Projects/a.md tombstoned"     || bad "Projects/a.md STILL LIVE (ghost)"
deleted "file%2FProjects%2Fb.md"       && ok "Projects/b.md tombstoned"     || bad "Projects/b.md STILL LIVE (ghost)"
deleted "file%2FProjects%2Fsub%2Fc.md" && ok "Projects/sub/c.md tombstoned" || bad "Projects/sub/c.md STILL LIVE (ghost)"

echo "=== assert NO over-deletion: siblings still LIVE ==="
present "file%2Fkeep.md"     && ok "keep.md survived"                       || bad "keep.md DELETED (over-deletion / data loss)"
present "file%2FProjects.md" && ok "Projects.md survived (prefix boundary)" || bad "Projects.md DELETED (range boundary bug)"

echo "=== kill daemon ==="
kill "$DPID" 2>/dev/null; sleep 2; kill -9 "$DPID" 2>/dev/null

echo ""
echo "########## daemon log (tail) ##########"; tail -30 "$SMOKE/d.log"
echo ""
echo "########## RESULT: $PASS passed, $FAIL failed ##########"
echo "SMOKE_DIR=$SMOKE"
[ "$FAIL" -eq 0 ]