#!/bin/bash
# 盯梢控制面开关 — 置 control.json；off 时顺带清场（队列 → suppressed/，pending → canceling）。
# 用法:
#   switch.sh on|off --runtime <dir>
#   switch.sh on|off --control <file> --state-dir <dir> --queue-dir <dir> --suppressed-dir <dir>
set -euo pipefail
CMD="${1:-}"
if [[ "$CMD" != "on" && "$CMD" != "off" ]]; then
  echo "用法: switch.sh on|off --runtime DIR  （或显式 --control/--state-dir/--queue-dir/--suppressed-dir）" >&2
  exit 1
fi
shift || true
RUNTIME="${PR_AUTOPILOT_RUNTIME:-}"
CONTROL=""
STATE_DIR=""
QUEUE_DIR=""
SUPPRESSED_DIR=""
CHANGED_BY="${USER:-unknown}@$(hostname -s 2>/dev/null || echo host)"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --runtime) RUNTIME="$2"; shift 2 ;;
    --control) CONTROL="$2"; shift 2 ;;
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    --queue-dir) QUEUE_DIR="$2"; shift 2 ;;
    --suppressed-dir) SUPPRESSED_DIR="$2"; shift 2 ;;
    --changed-by) CHANGED_BY="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done
if [[ -z "$RUNTIME" && -z "$CONTROL" ]]; then
  echo "必须 --runtime 或 --control 或环境变量 PR_AUTOPILOT_RUNTIME" >&2
  exit 1
fi
CONTROL="${CONTROL:-$RUNTIME/control.json}"
STATE_DIR="${STATE_DIR:-$RUNTIME/state}"
QUEUE_DIR="${QUEUE_DIR:-${PR_AUTOPILOT_QUEUE_DIR:-$RUNTIME/dispatch-queue}}"
SUPPRESSED_DIR="${SUPPRESSED_DIR:-${PR_AUTOPILOT_SUPPRESSED_DIR:-$RUNTIME/suppressed}}"

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE="$HERE/../../scripts/pr-watch/control-gate.mjs"
export PATH="/opt/homebrew/bin:/usr/bin:/bin:$PATH"

if [[ "$CMD" == "on" ]]; then
  exec node "$GATE" write --control "$CONTROL" --enabled true --changed-by "$CHANGED_BY"
fi
exec node "$GATE" sweep-off --control "$CONTROL" --enabled false --changed-by "$CHANGED_BY" \
  --state-dir "$STATE_DIR" --queue-dir "$QUEUE_DIR" --suppressed-dir "$SUPPRESSED_DIR"
