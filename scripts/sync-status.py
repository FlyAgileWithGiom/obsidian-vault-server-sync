#!/usr/bin/env python3
"""sync-status.py — Read-only diagnostic report for vault-sync state.

Usage:
  python3 scripts/sync-status.py [<vault-path>]
  npm run sync:status

Reads state file + DB + FS, prints a structured markdown report.
No writes to state file or DB.
"""

import json
import os
import subprocess
import sys
import unicodedata
from datetime import datetime, timezone


def nfc(s: str) -> str:
    """Normalize string to NFC for comparison.

    macOS HFS+/APFS stores filenames in NFD; CouchDB stores docIds in NFC
    (since mac-vault-sync 1.5.2). Without normalizing, the same logical path
    appears as both FS-only AND DB-only orphan in the diff.
    """
    return unicodedata.normalize("NFC", s)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DEFAULT_VAULT = os.path.expanduser("~/ObsidianNotes")
STATE_FILE_NAME = ".vault-sync-state.json"
CONFIG_FILE_NAME = ".vault-sync.json"
DAEMON_LOG = os.path.expanduser("~/.local/log/vault-sync-daemon.log")
TOP_N = 10


def vault_path() -> str:
    if len(sys.argv) > 1:
        return os.path.expanduser(sys.argv[1])
    return os.environ.get("VAULT_PATH", DEFAULT_VAULT)


# ---------------------------------------------------------------------------
# State file parsing
# ---------------------------------------------------------------------------

def load_state(vault: str) -> dict:
    path = os.path.join(vault, STATE_FILE_NAME)
    try:
        with open(path) as f:
            raw = json.load(f)
        # revMap is stored as a JSON string under "vault-sync-revmap"
        revmap_raw = raw.get("vault-sync-revmap", "{}")
        revmap = json.loads(revmap_raw) if isinstance(revmap_raw, str) else revmap_raw
        last_seq = raw.get("vault-sync-lastseq", "unknown")
        return {"revmap": revmap, "last_seq": last_seq}
    except FileNotFoundError:
        return {"revmap": {}, "last_seq": "unknown", "error": f"State file not found: {path}"}
    except Exception as e:
        return {"revmap": {}, "last_seq": "unknown", "error": str(e)}


def parse_revmap(revmap: dict) -> dict:
    known, tombstoned, orphan = [], [], []
    for doc_id, entry in revmap.items():
        state = entry.get("state", "orphan") if isinstance(entry, dict) else "orphan"
        if state == "known":
            known.append(doc_id)
        elif state == "tombstoned":
            tombstoned.append(doc_id)
        else:
            orphan.append(doc_id)
    return {"known": known, "tombstoned": tombstoned, "orphan": orphan}


# ---------------------------------------------------------------------------
# Config file (for DB credentials)
# ---------------------------------------------------------------------------

def load_config(vault: str) -> dict:
    path = os.path.join(vault, CONFIG_FILE_NAME)
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return {}


# ---------------------------------------------------------------------------
# FS enumeration
# ---------------------------------------------------------------------------

DEFAULT_EXCLUDE = [".trash/", ".obsidian/", ".vault-sync-state.json", ".vault-sync.json", ".DS_Store"]


def list_fs_files(vault: str, exclude_patterns: list[str]) -> list[str]:
    result = []
    for dirpath, dirnames, filenames in os.walk(vault):
        # Prune excluded dirs in-place
        dirnames[:] = [
            d for d in dirnames
            if not any((d + "/") in p or d == p.rstrip("/") for p in exclude_patterns)
            and not d.startswith(".")
        ]
        for fname in filenames:
            rel = os.path.relpath(os.path.join(dirpath, fname), vault)
            if not any(pat.rstrip("/") in rel for pat in exclude_patterns):
                result.append(rel)
    return sorted(result)


# ---------------------------------------------------------------------------
# DB query
# ---------------------------------------------------------------------------

def query_db(config: dict) -> dict:
    url = config.get("couchDbUrl", "")
    name = config.get("couchDbName", "")
    user = config.get("couchDbUser", "")
    password = config.get("couchDbPassword", "")

    if not (url and name and user and password):
        return {"error": "No DB credentials in config", "rows": []}

    endpoint = f"{url.rstrip('/')}/{name}/_all_docs?limit=999999"
    # Use curl so the system CA store and keychain certs are respected (Python's
    # bundled CA store may not include private/self-signed server certs on macOS)
    try:
        result = subprocess.run(
            ["curl", "-sf", "--max-time", "15", "-u", f"{user}:{password}", endpoint],
            capture_output=True, text=True
        )
        if result.returncode != 0:
            return {"error": f"curl exited {result.returncode}: {result.stderr.strip()}", "rows": []}
        data = json.loads(result.stdout)
        return {"rows": data.get("rows", []), "total_rows": data.get("total_rows", 0)}
    except Exception as e:
        return {"error": str(e), "rows": []}


# ---------------------------------------------------------------------------
# Daemon status
# ---------------------------------------------------------------------------

def daemon_status() -> dict:
    try:
        result = subprocess.run(
            ["pgrep", "-f", "vault-sync-daemon"],
            capture_output=True, text=True
        )
        pids = result.stdout.strip().splitlines()
        if pids:
            pid = pids[0]
            ps = subprocess.run(
                ["ps", "-o", "etime=", "-p", pid],
                capture_output=True, text=True
            )
            uptime = ps.stdout.strip() or "unknown"
            return {"running": True, "pid": pid, "uptime": uptime}
    except Exception:
        pass
    return {"running": False}


def daemon_log_tail(n: int = 5) -> list[str]:
    try:
        with open(DAEMON_LOG) as f:
            lines = f.readlines()
        return [l.rstrip() for l in lines[-n:]]
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def print_report(vault: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    state = load_state(vault)
    config = load_config(vault)
    exclude_patterns = config.get("excludePatterns", DEFAULT_EXCLUDE)

    revmap = state["revmap"]
    revmap_parsed = parse_revmap(revmap)
    known_ids = set(revmap_parsed["known"])
    tombstoned_ids = set(revmap_parsed["tombstoned"])
    orphan_ids = set(revmap_parsed["orphan"])
    all_revmap_ids = known_ids | tombstoned_ids | orphan_ids

    fs_files = list_fs_files(vault, exclude_patterns)
    # NFC-normalize FS ids so comparison with DB (which stores NFC) is accurate
    # on macOS where filenames are stored in NFD on disk.
    fs_ids = {nfc(f"file/{p}") for p in fs_files}

    db_result = query_db(config)
    db_rows = db_result.get("rows", [])
    db_doc_ids = {nfc(r["id"]) for r in db_rows if not r["id"].startswith("_")}
    db_live_ids = {nfc(r["id"]) for r in db_rows if not r["id"].startswith("_") and not r.get("value", {}).get("deleted")}

    # NFC-normalize revMap ids too — they may be in either form depending on
    # when the entry was written (pre/post 1.5.2). Comparison must be NFC.
    known_ids = {nfc(k) for k in known_ids}
    tombstoned_ids = {nfc(k) for k in tombstoned_ids}
    orphan_ids = {nfc(k) for k in orphan_ids}
    all_revmap_ids = known_ids | tombstoned_ids | orphan_ids

    # Divergence
    fs_only = sorted(fs_ids - db_doc_ids)
    db_only_all = db_doc_ids - fs_ids
    db_only_agent = sorted(db_only_all & (known_ids | orphan_ids))  # in revMap but not tombstoned
    db_only_true_orphan = sorted(db_only_all - all_revmap_ids)     # not in revMap at all
    resurrection = sorted(tombstoned_ids & fs_ids)                  # tombstoned but FS exists

    daemon = daemon_status()
    log_lines = daemon_log_tail(5)

    # --------------- Print ---------------
    print(f"# Sync Status — {vault}")
    print(f"Generated: {ts}")
    print()

    if "error" in state:
        print(f"> WARNING: {state['error']}")
        print()

    print("## Counts")
    print(f"  FS files:       {len(fs_files)}")
    if "error" in db_result:
        print(f"  DB live docs:   (unavailable — {db_result['error']})")
        print(f"  DB tombstones:  (unavailable)")
    else:
        print(f"  DB live docs:   {len(db_live_ids)}")
        print(f"  DB tombstones:  {len(db_doc_ids) - len(db_live_ids)}")
    print(f"  revMap entries: {len(revmap)}")
    print(f"    - known:        {len(known_ids)}")
    print(f"    - tombstoned:   {len(tombstoned_ids)}")
    print(f"    - orphan:       {len(orphan_ids)}")
    print()

    print("## Divergence")
    if "error" in db_result:
        print(f"  (DB unavailable — skipping divergence analysis)")
    else:
        def show(label: str, items: list[str]) -> None:
            print(f"  {label}: {len(items)}")
            for p in items[:TOP_N]:
                print(f"    {p.removeprefix('file/')}")
            if len(items) > TOP_N:
                print(f"    ... and {len(items) - TOP_N} more")

        show("FS-only (push pending)", fs_only)
        show("DB-only orphans (agent-created, no FS)", db_only_agent)
        show("DB-only NOT in revMap (true orphans)", db_only_true_orphan)
        show("Tombstoned but FS file exists (resurrection candidate!)", resurrection)
    print()

    print("## Daemon")
    if daemon["running"]:
        print(f"  Running: yes (PID {daemon['pid']}, uptime {daemon['uptime']})")
    else:
        print("  Running: no")
    if log_lines:
        print("  Last log lines (tail 5):")
        for line in log_lines:
            print(f"    {line}")
    else:
        print(f"  Log not found: {DAEMON_LOG}")
    print()

    print("## Unsyncable")
    print("  (R30 not yet implemented — no data)")


if __name__ == "__main__":
    print_report(vault_path())
