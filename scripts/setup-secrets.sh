#!/usr/bin/env bash
# Write OpenCode Go / DeepSeek keys and QQ bot account into .env without
# echoing the keys. OpenCode Go is used for chat; the DeepSeek key is optional
# and only needed for the /tools/search and /tools/fetch helpers.
# Usage: bash scripts/setup-secrets.sh
set -euo pipefail

ROOT="${QQ_BOT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_FILE="$ROOT/.env"
umask 077

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found" >&2
  exit 1
fi

printf 'OpenCode Go API Key (input hidden, starts with oc_sk_): '
IFS= read -rs OPENCODE_API_KEY
printf '\n'

CURRENT_DEEPSEEK=$(awk -F= '/^DEEPSEEK_API_KEY=/{print substr($0, index($0, "=") + 1)}' "$ENV_FILE" 2>/dev/null || true)
printf 'DeepSeek API Key for web search/fetch (optional, Enter to keep current): '
IFS= read -rs DEEPSEEK_API_KEY
printf '\n'
if [[ -z "${DEEPSEEK_API_KEY}" ]]; then
  DEEPSEEK_API_KEY="$CURRENT_DEEPSEEK"
fi

printf 'QQ bot account number (digits only): '
IFS= read -r QQ_BOT_UIN
printf '\n'

if [[ -z "${OPENCODE_API_KEY}" || "${OPENCODE_API_KEY}" == *[[:space:]]* ]]; then
  echo "ERROR: OpenCode Go API key is empty or contains whitespace." >&2
  exit 1
fi
if [[ ! "${OPENCODE_API_KEY}" =~ ^oc_sk_[A-Za-z0-9_-]+$ ]]; then
  echo "ERROR: OpenCode Go API key format looks wrong (expected oc_sk_...)." >&2
  exit 1
fi
if [[ -n "${DEEPSEEK_API_KEY}" && ! "${DEEPSEEK_API_KEY}" =~ ^sk-[A-Za-z0-9_-]+$ ]]; then
  echo "ERROR: DeepSeek API key format looks wrong (expected sk-... or empty)." >&2
  exit 1
fi
if [[ ! "${DEEPSEEK_API_KEY}" =~ ^sk-[A-Za-z0-9_-]+$ ]]; then
  echo "WARN: DEEPSEEK_API_KEY is empty; web search/fetch tools will be unavailable." >&2
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
  grep -v -E '^(OPENCODE_API_KEY|OPENCODE_BASE_URL|OPENCODE_MODEL|OPENCODE_SESSION|DEEPSEEK_API_KEY|QQ_BOT_UIN|ONEBOT_TOKEN)=' "$ENV_FILE" || true
  printf 'OPENCODE_API_KEY=%s\n' "$OPENCODE_API_KEY"
  printf 'OPENCODE_BASE_URL=%s\n' "${OPENCODE_BASE_URL:-https://opencode.ai/inference/go/v1}"
  printf 'OPENCODE_MODEL=%s\n' "${OPENCODE_MODEL:-deepseek-v4.1-flash}"
  printf 'OPENCODE_SESSION=%s\n' "${OPENCODE_SESSION:-qq-bot}"
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

echo "Saved to $ENV_FILE (mode 600). Keys were not printed or written to shell history."
