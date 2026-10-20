#!/usr/bin/env bash
# Read-only restore drill: unpacks a backup into a fresh temp directory and verifies
# the databases, expected tables, research data and knowledge notes. It never writes
# to the project directory or restarts services.
#
# Usage: bash scripts/restore-drill.sh [backup.tar.gz]
set -euo pipefail

ROOT="${QQ_BOT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BACKUP_DIR="$ROOT/backup"
ARCHIVE="${1:-}"
if [[ -z "$ARCHIVE" ]]; then
  ARCHIVE=$(ls -1t "$BACKUP_DIR"/qq-bot-config-*.tar.gz 2>/dev/null | sed -n '1p' || true)
fi
if [[ -z "$ARCHIVE" || ! -f "$ARCHIVE" ]]; then
  echo "No .tar.gz backup found. Encrypted .gpg backups must be decrypted first." >&2
  exit 2
fi

TMP=$(mktemp -d /tmp/qq-bot-restore-drill.XXXXXX)
trap 'rm -rf "$TMP"' EXIT
umask 077

echo "== archive =="
ls -lh "$ARCHIVE"
tar -tzf "$ARCHIVE" | sed -n '1,40p'
echo "file count: $(tar -tzf "$ARCHIVE" | wc -l)"

tar -xzf "$ARCHIVE" -C "$TMP"

echo
echo "== required files =="
for file in env koishi/koishi.yml koishi/data/koishi.db data/research-agent/research.db config/research-profile.json README.md; do
  if [[ -f "$TMP/$file" ]]; then
    printf 'ok   %s\n' "$file"
  else
    printf 'MISS %s\n' "$file"
    exit 3
  fi
done

echo
echo "== database integrity =="
export DRILL_ROOT="$TMP"
python3 - <<'PY'
import os
import pathlib
import sqlite3

root = pathlib.Path(os.environ['DRILL_ROOT'])
checks = {
    'koishi/data/koishi.db': {'binding', 'channel', 'user'},
    'data/research-agent/research.db': {
        'papers', 'paper_analyses', 'paper_versions', 'tasks', 'api_usage',
        'repositories', 'repository_events', 'delivery_runs', 'user_feedback',
    },
}
for relative, required in checks.items():
    path = root / relative
    connection = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
    integrity = connection.execute('PRAGMA integrity_check').fetchone()[0]
    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    missing = required - tables
    if integrity != 'ok' or missing:
        raise SystemExit(f'FAIL {relative}: integrity={integrity}, missing={sorted(missing)}')
    print(f'ok   {relative}: integrity=ok, tables={len(tables)}')
    if relative.endswith('research.db'):
        papers = connection.execute('SELECT COUNT(*) FROM papers').fetchone()[0]
        analyses = connection.execute('SELECT COUNT(*) FROM paper_analyses').fetchone()[0]
        tasks = connection.execute('SELECT COUNT(*) FROM tasks').fetchone()[0]
        print(f'     papers={papers}, analyses={analyses}, tasks={tasks}')
    connection.close()
PY

echo
echo "== knowledge =="
PAPERS=$(find "$TMP/knowledge/papers" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l)
echo "knowledge paper notes: $PAPERS"
if [[ "$PAPERS" -lt 1 ]]; then
  echo "WARN: no paper notes found in backup" >&2
fi

echo
echo "== secret permissions =="
stat -c '%a %n' "$TMP/env" | sed "s#$TMP/##"
if [[ "$(stat -c '%a' "$TMP/env")" != "600" ]]; then
  echo "FAIL: restored .env is not mode 600" >&2
  exit 4
fi

echo
echo "RESTORE DRILL PASSED (read-only, temp dir removed)"
