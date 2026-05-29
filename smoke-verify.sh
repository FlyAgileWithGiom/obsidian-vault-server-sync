#!/usr/bin/env bash
# Adversarial REAL smoke test for v2.0 PouchDB daemon (C07+C08 verification).
# Exercises: boot, converter phantom filter, pull (remote-only doc), push (new local note),
# and data-loss safety (pre-existing real notes unchanged).
set -uo pipefail

COUCH="http://smoke:smokepass@localhost:5986"
DB="vault-wf-verify"
REPO="/Users/guillaume/dev/tools/mcp/servers/obsidian-vault-server-sync/.claude/worktrees/agent-ad586f4d9764d0eb1"
STATE_DIR="$HOME/Library/Application Support/vault-sync-daemon/$DB"

echo "=== STEP 2: fresh test db ==="
curl -s -X DELETE "$COUCH/$DB" >/dev/null
curl -s -X PUT "$COUCH/$DB" ; echo

echo "=== STEP 3: temp vault ==="
SMOKE=$(mktemp -d)
mkdir -p "$SMOKE/vault"
echo "SMOKE=$SMOKE"

echo "=== STEP 4: push 2 real synced notes to couch (capture real revs) ==="
NOTE_A_CONTENT="# Alpha note\n\nReal synced content alpha line.\n"
NOTE_B_CONTENT="# Beta note\n\nReal synced content beta line.\n"
printf "$NOTE_A_CONTENT" > "$SMOKE/vault/alpha.md"
printf "$NOTE_B_CONTENT" > "$SMOKE/vault/beta.md"
A_CONTENT_JSON=$(printf "$NOTE_A_CONTENT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
B_CONTENT_JSON=$(printf "$NOTE_B_CONTENT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
A_MTIME=$(( $(stat -f %m "$SMOKE/vault/alpha.md") * 1000 ))
B_MTIME=$(( $(stat -f %m "$SMOKE/vault/beta.md") * 1000 ))

A_RESP=$(curl -s -X PUT "$COUCH/$DB/file%2Falpha.md" -H "Content-Type: application/json" \
  -d "{\"content\":$A_CONTENT_JSON,\"mtime\":$A_MTIME}")
B_RESP=$(curl -s -X PUT "$COUCH/$DB/file%2Fbeta.md" -H "Content-Type: application/json" \
  -d "{\"content\":$B_CONTENT_JSON,\"mtime\":$B_MTIME}")
A_REV=$(echo "$A_RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["rev"])')
B_REV=$(echo "$B_RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["rev"])')
echo "alpha rev=$A_REV  beta rev=$B_REV"

echo "=== STEP 4b: seed 1 remote-only doc (pull target) ==="
REMOTE_ONLY_CONTENT="# Remote only\n\nThis doc exists only in couch and must be PULLED to disk.\n"
RO_CONTENT_JSON=$(printf "$REMOTE_ONLY_CONTENT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
curl -s -X PUT "$COUCH/$DB/file%2Fremote-only.md" -H "Content-Type: application/json" \
  -d "{\"content\":$RO_CONTENT_JSON,\"mtime\":$A_MTIME}" >/dev/null
echo "seeded remote-only.md in couch"

echo "=== STEP 4c: craft state.json with 2 real revs + 2 phantoms ==="
mkdir -p "$STATE_DIR"
REVMAP=$(python3 -c "
import json
revmap = {
  'file/alpha.md':       {'state':'known','rev':'$A_REV','mtime':$A_MTIME},
  'file/beta.md':        {'state':'known','rev':'$B_REV','mtime':$B_MTIME},
  'file/.DS_Store':      {'state':'known','rev':'1-aaa','mtime':$A_MTIME},
  'file/.git/HEAD':      {'state':'known','rev':'1-bbb','mtime':$A_MTIME},
}
print(json.dumps({'vault-sync-revmap': json.dumps(revmap)}))
")
echo "$REVMAP" > "$STATE_DIR/state.json"
echo "state.json written at $STATE_DIR/state.json"
cat "$STATE_DIR/state.json"; echo

echo "=== STEP 4d: record checksums of 2 real notes BEFORE daemon ==="
A_SUM_BEFORE=$(shasum -a 256 "$SMOKE/vault/alpha.md" | awk '{print $1}')
B_SUM_BEFORE=$(shasum -a 256 "$SMOKE/vault/beta.md" | awk '{print $1}')
echo "alpha before=$A_SUM_BEFORE"
echo "beta  before=$B_SUM_BEFORE"

echo "=== STEP 5: write .vault-sync.json config ==="
cat > "$SMOKE/vault/.vault-sync.json" <<EOF
{"couchDbUrl":"http://localhost:5986","couchDbName":"$DB","couchDbUser":"smoke","couchDbPassword":"smokepass","syncDebounceMs":300,"excludePatterns":[".trash/",".obsidian/"]}
EOF
cat "$SMOKE/vault/.vault-sync.json"; echo

echo "=== STEP 6: wipe pouch dir for fresh migration ==="
rm -rf "$STATE_DIR/pouch"

echo "=== STEP 7: launch daemon DAEMON_V2=1 ==="
cd "$REPO"
DAEMON_V2=1 node dist/headless.js "$SMOKE/vault" > "$SMOKE/d.log" 2>&1 &
DPID=$!
echo "daemon pid=$DPID"
sleep 12

echo "=== STEP 7b: PUSH test — create a NEW note after boot ==="
PUSH_CONTENT="# Push test\n\nCreated after boot — must reach couch via FsWatcher->bridge->sync.\n"
printf "$PUSH_CONTENT" > "$SMOKE/vault/pushtest.md"
sleep 10

echo "=== STEP 8: kill daemon ==="
kill "$DPID" 2>/dev/null
sleep 2
kill -9 "$DPID" 2>/dev/null

echo ""
echo "############## ASSERTIONS ##############"
echo ""
echo "=== A1: daemon log (full) ==="
cat "$SMOKE/d.log"
echo ""
echo "=== A2: couch _all_docs ==="
curl -s "$COUCH/$DB/_all_docs" | python3 -m json.tool
echo ""
echo "=== A3: phantom check — .DS_Store / .git/HEAD must be ABSENT from couch ==="
ALLDOCS=$(curl -s "$COUCH/$DB/_all_docs")
echo "$ALLDOCS" | grep -q "file/.DS_Store" && echo "FAIL: .DS_Store phantom IN couch" || echo "PASS: .DS_Store absent"
echo "$ALLDOCS" | grep -q "file/.git/HEAD" && echo "FAIL: .git/HEAD phantom IN couch" || echo "PASS: .git/HEAD absent"
echo ""
echo "=== A4: pull — remote-only.md must exist on disk with remote content ==="
if [ -f "$SMOKE/vault/remote-only.md" ]; then
  echo "PASS: remote-only.md pulled to disk"
  echo "--- content ---"; cat "$SMOKE/vault/remote-only.md"; echo "--- end ---"
else
  echo "FAIL: remote-only.md NOT on disk"
fi
echo ""
echo "=== A5: push — pushtest.md must exist in couch ==="
PUSH_DOC=$(curl -s "$COUCH/$DB/file%2Fpushtest.md")
echo "$PUSH_DOC" | python3 -m json.tool 2>/dev/null || echo "$PUSH_DOC"
echo "$PUSH_DOC" | grep -q '"content"' && echo "PASS: pushtest.md in couch with content" || echo "FAIL: pushtest.md NOT pushed to couch"
echo ""
echo "=== A6: data-loss — 2 real note checksums UNCHANGED ==="
A_SUM_AFTER=$(shasum -a 256 "$SMOKE/vault/alpha.md" | awk '{print $1}')
B_SUM_AFTER=$(shasum -a 256 "$SMOKE/vault/beta.md" | awk '{print $1}')
echo "alpha after =$A_SUM_AFTER"
echo "beta  after =$B_SUM_AFTER"
[ "$A_SUM_BEFORE" = "$A_SUM_AFTER" ] && echo "PASS: alpha.md unchanged" || echo "FAIL: alpha.md CHANGED (data loss)"
[ "$B_SUM_BEFORE" = "$B_SUM_AFTER" ] && echo "PASS: beta.md unchanged" || echo "FAIL: beta.md CHANGED (data loss)"
[ -s "$SMOKE/vault/alpha.md" ] && echo "PASS: alpha.md non-empty" || echo "FAIL: alpha.md EMPTY"
[ -s "$SMOKE/vault/beta.md" ] && echo "PASS: beta.md non-empty" || echo "FAIL: beta.md EMPTY"
echo ""
echo "=== A7: converter log line — expect '2 phantom skipped' ==="
grep -i "phantom" "$SMOKE/d.log" || echo "NO phantom log line"
echo ""
echo "SMOKE_DIR=$SMOKE"
echo "STATE_DIR=$STATE_DIR"
echo "############## END ##############"
