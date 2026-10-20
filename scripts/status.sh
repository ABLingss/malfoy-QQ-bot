#!/usr/bin/env bash
# Read-only health check for the QQ bot deployment.
# Usage: bash scripts/status.sh
set -uo pipefail

ROOT="${QQ_BOT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_FILE="$ROOT/.env"
export RESEARCH_DB="$ROOT/data/research-agent/research.db"

echo "== systemd =="
for svc in koishi napcat; do
  enabled=$(systemctl is-enabled "$svc" 2>/dev/null || echo unknown)
  active=$(systemctl is-active "$svc" 2>/dev/null || echo unknown)
  printf '%-8s enabled=%-8s active=%s\n' "$svc" "$enabled" "$active"
done

echo
echo "== listening sockets =="
ss -tlnp 2>/dev/null | grep -E ':(5140|6099)\b' || echo "none of 5140/6099 is listening"

echo
echo "== Koishi console =="
curl -s -o /dev/null -w 'http://127.0.0.1:5140/ -> HTTP %{http_code}\n' --max-time 5 \
  http://127.0.0.1:5140/ || echo "request failed"

echo
echo "== credentials present (values never printed) =="
awk -F= '/^(DEEPSEEK_API_KEY|QQ_BOT_UIN|ONEBOT_TOKEN)=/{
  print $1 "=" (length($2) > 0 ? "SET" : "EMPTY")
}' "$ENV_FILE" 2>/dev/null || echo "cannot read $ENV_FILE"

echo
echo "== DeepSeek API reachability =="
KEY=$(awk -F= '/^DEEPSEEK_API_KEY=/{print substr($0, index($0, "=") + 1)}' "$ENV_FILE" 2>/dev/null)
if [[ -z "${KEY:-}" ]]; then
  echo "DEEPSEEK_API_KEY is empty; skip API test"
else
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
    -H "Authorization: Bearer $KEY" https://api.deepseek.com/v1/models) || code=000
  case "$code" in
    200) echo "DeepSeek /v1/models -> HTTP 200 (auth OK)" ;;
    401) echo "DeepSeek /v1/models -> HTTP 401 (invalid key or auth failure)" ;;
    402) echo "DeepSeek /v1/models -> HTTP 402 (insufficient balance)" ;;
    429) echo "DeepSeek /v1/models -> HTTP 429 (rate limited)" ;;
    000) echo "DeepSeek /v1/models -> network failure" ;;
    *)   echo "DeepSeek /v1/models -> HTTP $code" ;;
  esac
fi
unset KEY

echo
echo "== Research Agent (read-only) =="
python3 - <<'PY_STATUS'
import datetime
import os
import pathlib
import sqlite3
from zoneinfo import ZoneInfo

path = pathlib.Path(os.environ.get('RESEARCH_DB', 'data/research-agent/research.db'))
if not path.exists():
    print('research.db: MISSING')
    raise SystemExit(0)
conn = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
try:
    stats = conn.execute(
        """SELECT COUNT(*),
          SUM(CASE WHEN analysis_status='completed' THEN 1 ELSE 0 END),
          SUM(CASE WHEN analysis_status='legacy' THEN 1 ELSE 0 END),
          SUM(CASE WHEN pushed_at IS NOT NULL THEN 1 ELSE 0 END)
        FROM papers"""
    ).fetchone()
    print(f'papers={stats[0]} analyzed={stats[1] or 0} legacy={stats[2] or 0} pushed={stats[3] or 0}')
    delivery = conn.execute(
        "SELECT run_key,status,collect_ok,analyze_ok,report_ok,message_ok,file_ok,last_error FROM delivery_runs WHERE kind='daily' ORDER BY created_at DESC LIMIT 1"
    ).fetchone()
    if delivery:
        print('latest_daily=' + ' '.join(str(x) for x in delivery[:7]))
        if delivery[7]:
            print('latest_daily_error=' + str(delivery[7])[:200])
    else:
        print('latest_daily=none')
    tasks = conn.execute("SELECT status,COUNT(*) FROM tasks GROUP BY status").fetchall()
    print('tasks=' + (', '.join(f'{status}:{count}' for status, count in tasks) or 'none'))
    now = datetime.datetime.now(ZoneInfo('Asia/Shanghai'))
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(datetime.timezone.utc).isoformat()
    week_start = (now - datetime.timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0).astimezone(datetime.timezone.utc).isoformat()
    row = conn.execute(
        "SELECT COUNT(*),COALESCE(SUM(input_tokens),0),COALESCE(SUM(output_tokens),0),COALESCE(SUM(cache_hit_tokens),0),COALESCE(SUM(estimated_cost_usd),0) FROM api_usage WHERE created_at >= ? AND status='ok'",
        (day_start,),
    ).fetchone()
    print(f'today_usage requests={row[0]} input={row[1]} output={row[2]} cache_hit={row[3]} est_usd={row[4]:.6f}')
    row = conn.execute(
        "SELECT COUNT(*),COALESCE(SUM(estimated_cost_usd),0) FROM api_usage WHERE created_at >= ? AND status='ok'",
        (week_start,),
    ).fetchone()
    print(f'week_usage requests={row[0]} est_usd={row[1]:.6f}')
finally:
    conn.close()
PY_STATUS

echo
echo "== recent service errors =="
journalctl -u koishi.service -u napcat.service -p warning -n 15 --no-pager 2>/dev/null || true
