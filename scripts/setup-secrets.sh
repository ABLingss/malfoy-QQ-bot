#!/usr/bin/env bash
# Write DeepSeek API key and QQ bot account into .env without echoing the key.
# Usage: bash scripts/setup-secrets.sh
set -euo pipefail

ROOT="${QQ_BOT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_FILE="$ROOT/.env"
umask 077

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found" >&2
  exit 1
fi

printf 'DeepSeek API Key (input hidden, starts with sk-): '
IFS= read -rs DEEPSEEK_API_KEY
printf '\n'

printf 'QQ bot account number (digits only): '
IFS= read -r QQ_BOT_UIN
printf '\n'

if [[ -z "${DEEPSEEK_API_KEY}" || "${DEEPSEEK_API_KEY}" == *[[:space:]]* ]]; then
  echo "ERROR: API key is empty or contains whitespace." >&2
  exit 1
fi
if [[ ! "${DEEPSEEK_API_KEY}" =~ ^sk-[A-Za-z0-9_-]+$ ]]; then
  echo "ERROR: API key format looks wrong (expected sk-...)." >&2
  exit 1
fi
if [[ ! "${QQ_BOT_UIN}" =~ ^[0-9]{5,12}$ ]]; then
  echo "ERROR: QQ number must be 5-12 digits." >&2
  exit 1
fi

TMP_FILE="$(mktemp "${ENV_FILE}.XXXXXX")"
NEED_TOKEN=0
CURRENT_TOKEN=$(awk -F= '/^ONEBOT_TOKEN=/{print substr($0, index($0, "=") + 1)}' "$ENV_FILE" 2>/dev/null || true)
if [[ -z "$CURRENT_TOKEN" || "$CURRENT_TOKEN" == replace-* || "$CURRENT_TOKEN" == change-* ]]; then
  NEED_TOKEN=1
fi
{
  grep -v -E '^(DEEPSEEK_API_KEY|QQ_BOT_UIN|ONEBOT_TOKEN)=' "$ENV_FILE" || true
  printf 'DEEPSEEK_API_KEY=%s\n' "$DEEPSEEK_API_KEY"
  printf 'QQ_BOT_UIN=%s\n' "$QQ_BOT_UIN"
  if [[ "$NEED_TOKEN" == "1" ]]; then
    printf 'ONEBOT_TOKEN=%s\n' "$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  else
    printf 'ONEBOT_TOKEN=%s\n' "$CURRENT_TOKEN"
  fi
} > "$TMP_FILE"
chmod 600 "$TMP_FILE"
mv -f "$TMP_FILE" "$ENV_FILE"
chmod 600 "$ENV_FILE"

echo "Saved to $ENV_FILE (mode 600). Key was not printed or written to shell history."
