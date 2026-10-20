#!/usr/bin/env bash
# Copy example configs into local runtime files without overwriting existing ones.
# Usage: bash scripts/init-config.sh
set -euo pipefail

ROOT="${QQ_BOT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT"

copy_if_missing() {
  local src="$1" dst="$2"
  if [[ -e "$dst" ]]; then
    echo "keep   $dst"
  elif [[ -e "$src" ]]; then
    cp "$src" "$dst"
    chmod 600 "$dst" 2>/dev/null || true
    echo "create $dst"
  else
    echo "missing example: $src" >&2
  fi
}

copy_if_missing config/arxiv.example.json config/arxiv.json
copy_if_missing config/weekly.example.json config/weekly.json
copy_if_missing config/bot.example.json config/bot.json
copy_if_missing config/research-profile.example.json config/research-profile.json
copy_if_missing koishi/koishi.example.yml koishi/koishi.yml
copy_if_missing .env.example .env

mkdir -p koishi/data/chathub/presets assets/persona knowledge/papers \
  data/arxiv-digest data/research-agent
if [[ ! -f koishi/data/chathub/presets/general.yml ]]; then
  cp presets/general.example.yml koishi/data/chathub/presets/general.yml
  echo "create koishi/data/chathub/presets/general.yml"
else
  echo "keep   koishi/data/chathub/presets/general.yml"
fi

if [[ ! -f data/reminders.json ]]; then
  printf '[]\n' > data/reminders.json
  echo "create data/reminders.json"
fi

chmod 700 data data/arxiv-digest data/research-agent knowledge assets/persona 2>/dev/null || true
chmod 600 .env data/reminders.json config/arxiv.json config/weekly.json config/bot.json \
  config/research-profile.json 2>/dev/null || true

cat <<'EOF'
Next steps:
1. Edit .env (or run scripts/setup-secrets.sh) and set your QQ bot account.
2. Edit config/arxiv.json and config/weekly.json target.userId.
3. Edit config/bot.json groupWhitelist and optional persona.
4. Edit config/research-profile.json for your research directions.
5. Install Koishi dependencies, configure systemd, then start Koishi.
EOF
