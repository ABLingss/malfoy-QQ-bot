#!/usr/bin/env bash
# Scan tracked files for credentials and private deployment artifacts.
# Usage: bash scripts/check-leaks.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

fail=0

report_matches() {
  local category="$1" matches="$2"
  [[ -n "$matches" ]] || return 0
  echo "ERROR: $category"
  printf '%s\n' "$matches" | awk -F: '{ print "  " $1 ":" $2 }' | sort -u
  fail=1
}

scan() {
  local category="$1" pattern="$2" filter="${3:-}"
  local matches
  matches=$(git grep -nI -E "$pattern" -- . ':(exclude)scripts/check-leaks.sh' 2>/dev/null || true)
  if [[ -n "$matches" && -n "$filter" ]]; then
    matches=$(printf '%s\n' "$matches" | grep -vE "$filter" || true)
  fi
  report_matches "$category" "$matches"
}

# High-confidence credential formats.
scan "private key block" '-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----'
scan "OpenCode / API key" 'oc_sk_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9]{20,}'
scan "GitHub token" 'gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}'
scan "AWS access key" 'AKIA[0-9A-Z]{16}'
scan "Slack token" 'xox[baprs]-[A-Za-z0-9-]{10,}'
scan "chat webhook" 'https://(discord|discordapp)\.com/api/webhooks/|https://hooks\.slack\.com/services/'

# Real absolute home paths, ignoring common documentation placeholders.
scan "local home path" '/home/[A-Za-z0-9._-]+/|/Users/[A-Za-z0-9._-]+/|C:\\\\Users\\\\' \
  '/home/(YOUR_USER|USER|user|username|example)/|/Users/(YOUR_USER|USER|user|username|example)/'

# Non-placeholder values in tracked environment files.
env_hits=$(git grep -nI -E '^[[:space:]]*(OPENCODE_API_KEY|DEEPSEEK_API_KEY|OPENCODE_SESSION|ONEBOT_TOKEN)=[^[:space:]]{8,}[[:space:]]*$' -- . \
  ':(exclude)scripts/' ':(exclude)tests/' 2>/dev/null || true)
env_hits=$(printf '%s\n' "$env_hits" | grep -vE 'replace|your|example|changeme|random|placeholder|token$' || true)
report_matches "environment secret" "$env_hits"

uin_hits=$(git grep -nI -E '^[[:space:]]*QQ_BOT_UIN=[0-9]{5,12}[[:space:]]*$' -- . \
  ':(exclude)scripts/' ':(exclude)tests/' 2>/dev/null || true)
uin_hits=$(printf '%s\n' "$uin_hits" | grep -vE 'QQ_BOT_UIN=123456789$' || true)
report_matches "real QQ number" "$uin_hits"

# Private runtime files that must never be tracked.
private_files=$(git ls-files | grep -E \
  '(^|/)\.env$|^koishi/\.env(\.local)?$|^koishi/koishi\.yml$|^config/(arxiv|weekly|bot|research-profile|tts)\.json$|^data/|^knowledge/|^assets/persona/|^backup/|^integrations/|^koishi/(data|cache|temp|external|lib|dist)/|^systemd/[^/]+\.service$|(^|/)\.log$|\.tar\.(gz|zst)$|^AGENTS\.md$|(^|/)\.private\.md$' \
  | grep -vE '(^|/)README\.md$' || true)
report_matches "private file tracked" "$private_files"

if [[ "$fail" -ne 0 ]]; then
  echo
  echo "Leak check failed. Remove the listed data and rotate any exposed credential."
  exit 1
fi

echo "OK: no obvious credentials or private deployment artifacts in tracked files."
