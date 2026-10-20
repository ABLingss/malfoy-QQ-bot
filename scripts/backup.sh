#!/usr/bin/env bash
# Consistent backup of bot configuration, databases, research knowledge and NapCat config.
# Usage: bash scripts/backup.sh [--with-qq-data] [--encrypt]
# --encrypt requires BACKUP_PASSPHRASE_FILE pointing to a mode-600 passphrase file.
# The unencrypted archive contains secrets; keep it mode 600 and move the encrypted
# copy off-site. No passphrase is written to stdout or the archive.
set -euo pipefail

ROOT="${QQ_BOT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BACKUP_DIR="$ROOT/backup"
NAPCAT_CONFIG_DIR="${NAPCAT_CONFIG_DIR:-$HOME/Napcat/opt/QQ/resources/app/app_launcher/napcat/config}"
QQ_DATA_DIR="${QQ_DATA_DIR:-$HOME/.config/QQ}"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
ARCHIVE="$BACKUP_DIR/qq-bot-config-$STAMP.tar.gz"
WITH_QQ_DATA=0
ENCRYPT=0
for arg in "$@"; do
  case "$arg" in
    --with-qq-data) WITH_QQ_DATA=1 ;;
    --encrypt) ENCRYPT=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

umask 077
mkdir -p "$BACKUP_DIR"
TMP=$(mktemp -d "$BACKUP_DIR/.stage.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/koishi/data" "$TMP/napcat-config" "$TMP/systemd" "$TMP/scripts" \
  "$TMP/config" "$TMP/data/arxiv-digest" "$TMP/data/research-agent" "$TMP/knowledge"

# Secrets and service config
cp -a "$ROOT/.env" "$TMP/env"
cp -a "$ROOT/.env.example" "$TMP/env.example" 2>/dev/null || true
cp -a "$ROOT/koishi/koishi.yml" "$TMP/koishi/koishi.yml"
cp -a "$ROOT/koishi/package.json" "$TMP/koishi/package.json"
cp -a "$ROOT/systemd/." "$TMP/systemd/"
cp -a "$ROOT/scripts/." "$TMP/scripts/"
cp -a "$ROOT/config/." "$TMP/config/"
cp -a "$ROOT/README.md" "$TMP/README.md" 2>/dev/null || true
cp -a "$ROOT/docs" "$TMP/docs" 2>/dev/null || true

# Code needed to restore the research pipeline (no node_modules).
cp -a "$ROOT/koishi/plugins" "$TMP/koishi/plugins"
mkdir -p "$TMP/tests"
cp -a "$ROOT/tests/." "$TMP/tests/" 2>/dev/null || true

# Research state and human-editable knowledge base.
cp -a "$ROOT/data/arxiv-digest/." "$TMP/data/arxiv-digest/" 2>/dev/null || true
cp -a "$ROOT/knowledge/." "$TMP/knowledge/" 2>/dev/null || true
cp -a "$ROOT/data/research-agent/migration-report.json" "$TMP/data/research-agent/" 2>/dev/null || true

# NapCat config
if [ -d "$NAPCAT_CONFIG_DIR" ]; then cp -a "$NAPCAT_CONFIG_DIR/." "$TMP/napcat-config/"; else echo "WARN: NapCat config dir not found: $NAPCAT_CONFIG_DIR" >&2; fi

if [[ "$WITH_QQ_DATA" == "1" ]]; then
  if [ -d "$QQ_DATA_DIR" ]; then cp -a "$QQ_DATA_DIR" "$TMP/qq-data"; else echo "WARN: QQ data dir not found: $QQ_DATA_DIR" >&2; fi
fi

export BACKUP_TMP="$TMP"
export BACKUP_ROOT="$ROOT"
python3 - <<'PY'
import os
import pathlib
import sqlite3

tmp = pathlib.Path(os.environ['BACKUP_TMP'])
jobs = [
    (pathlib.Path(os.environ['BACKUP_ROOT']) / 'koishi' / 'data' / 'koishi.db', tmp / 'koishi' / 'data' / 'koishi.db'),
    (pathlib.Path(os.environ['BACKUP_ROOT']) / 'data' / 'research-agent' / 'research.db', tmp / 'data' / 'research-agent' / 'research.db'),
]
for src, dst in jobs:
    if not src.exists():
        continue
    dst.parent.mkdir(parents=True, exist_ok=True)
    source = sqlite3.connect(f'file:{src}?mode=ro', uri=True)
    target = sqlite3.connect(dst)
    with target:
        source.backup(target)
    target.close()
    source.close()
PY

tar -czf "$ARCHIVE" -C "$TMP" .
chmod 600 "$ARCHIVE"

if [[ "$ENCRYPT" == "1" ]]; then
  if [[ -z "${BACKUP_PASSPHRASE_FILE:-}" || ! -f "$BACKUP_PASSPHRASE_FILE" ]]; then
    echo "BACKUP_PASSPHRASE_FILE must point to an existing passphrase file" >&2
    exit 3
  fi
  if command -v gpg >/dev/null 2>&1; then
    ENCRYPTED="$ARCHIVE.gpg"
    gpg --batch --yes --symmetric --cipher-algo AES256 \
      --passphrase-file "$BACKUP_PASSPHRASE_FILE" \
      --output "$ENCRYPTED" "$ARCHIVE"
  elif command -v openssl >/dev/null 2>&1; then
    ENCRYPTED="$ARCHIVE.enc"
    openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 \
      -pass "file:$BACKUP_PASSPHRASE_FILE" \
      -in "$ARCHIVE" -out "$ENCRYPTED"
  else
    echo "Neither gpg nor openssl is available; refusing to leave an unencrypted backup after --encrypt" >&2
    exit 4
  fi
  chmod 600 "$ENCRYPTED"
  rm -f "$ARCHIVE"
  echo "Created encrypted backup: $ENCRYPTED"
  echo "Decrypt with the matching tool and passphrase file; see docs/research-agent.md"
else
  echo "Created unencrypted backup: $ARCHIVE"
  echo "Encrypt before off-site copy: BACKUP_PASSPHRASE_FILE=/path/passphrase bash scripts/backup.sh --encrypt"
fi
echo "Contents: .env, config, Koishi/NapCat config, Koishi DB, research DB, arXiv state/reports, knowledge/, plugins, systemd, scripts."
echo "This archive contains the DeepSeek key and QQ login configuration. Keep mode 600."
