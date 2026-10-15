#!/usr/bin/env bash
set -euo pipefail

OPS_DIR="/data/agent/ops"
BASE_DIR="/data/agent"

if [ $# -lt 1 ]; then
  echo "Usage: $0 <instance-or-agent> [message]"
  echo "Examples:"
  echo "  $0 gtm"
  echo "  $0 sxs"
  echo "  $0 wyj '你好，你是谁？'"
  exit 1
fi

TARGET_INPUT="$1"
shift || true
MESSAGE="${*:-}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required but not installed."
  exit 1
fi

normalize() {
  echo "$1" | tr '[:upper:]' '[:lower:]'
}

resolve_instance_alias() {
  local key
  key="$(normalize "$1")"

  case "$key" in
    gtm|gogo)
      echo "openclaw_GTM"
      ;;
    gyl)
      echo "openclaw_GYL"
      ;;
    pjt)
      echo "openclaw_PJT"
      ;;
    qd)
      echo "openclaw_QD"
      ;;
    teams|team)
      echo "openclaw_TeamS"
      ;;
    need)
      echo "openclaw_need"
      ;;
    sxs)
      echo "openclaw_sxs"
      ;;
    xmt)
      echo "openclaw_XMT"
      ;;
    *)
      for dir in "$BASE_DIR"/openclaw_*; do
        [ -d "$dir" ] || continue
        name="$(basename "$dir")"
        if [ "$(normalize "$name")" = "openclaw_${key}" ]; then
          echo "$name"
          return
        fi
      done
      echo ""
      ;;
  esac
}

list_agent_ids() {
  local cfg="$1"
  jq -r '
    ((.agents.entries // {}) | keys[]?),
    (.agents.list[]?.id // empty)
  ' "$cfg" 2>/dev/null | awk 'NF' | sort -u
}

TARGET="$(normalize "$TARGET_INPUT")"
INSTANCE="$(resolve_instance_alias "$TARGET_INPUT")"
AGENT_ID=""

if [ -n "$INSTANCE" ]; then
  AGENT_ID="main"
else
  matches=()

  for cfg in "$BASE_DIR"/openclaw_*/.openclaw/openclaw.json; do
    [ -f "$cfg" ] || continue
    inst="$(basename "$(dirname "$(dirname "$cfg")")")"

    while IFS= read -r agent_id; do
      [ -n "$agent_id" ] || continue
      if [ "$(normalize "$agent_id")" = "$TARGET" ] && [ "$agent_id" != "main" ]; then
        matches+=("$inst:$agent_id")
      fi
    done < <(list_agent_ids "$cfg" || true)
  done

  if [ "${#matches[@]}" -eq 0 ]; then
    echo "Unknown instance or child agent: $TARGET_INPUT"
    echo
    echo "Instances:"
    for dir in "$BASE_DIR"/openclaw_*; do
      [ -d "$dir/.openclaw" ] || continue
      echo "  $(basename "$dir")"
    done | sort
    echo
    echo "Child agents:"
    for cfg in "$BASE_DIR"/openclaw_*/.openclaw/openclaw.json; do
      [ -f "$cfg" ] || continue
      inst="$(basename "$(dirname "$(dirname "$cfg")")")"
      list_agent_ids "$cfg" | awk -v inst="$inst" '$0 != "main" { print "  " $0 " -> " inst }' || true
    done | sort
    exit 1
  fi

  if [ "${#matches[@]}" -gt 1 ]; then
    echo "Agent name is not unique: $TARGET_INPUT"
    echo "Matches:"
    printf '  %s\n' "${matches[@]}"
    exit 1
  fi

  INSTANCE="${matches[0]%%:*}"
  AGENT_ID="${matches[0]#*:}"
fi

CONFIG="$BASE_DIR/$INSTANCE/.openclaw/openclaw.json"

if [ ! -f "$CONFIG" ]; then
  echo "Config not found: $CONFIG"
  exit 1
fi

TOKEN="$(jq -r '.gateway.auth.token // empty' "$CONFIG" 2>/dev/null || true)"

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "Gateway token not found in: $CONFIG"
  exit 1
fi

if [ ! -x "$OPS_DIR/status-all.sh" ]; then
  echo "Cannot find executable status script: $OPS_DIR/status-all.sh"
  exit 1
fi

PORT="$("$OPS_DIR/status-all.sh" | awk -v inst="$INSTANCE" '$1 == inst {print $2}')"
STATUS="$("$OPS_DIR/status-all.sh" | awk -v inst="$INSTANCE" '$1 == inst {print $3}')"

if [ -z "$PORT" ]; then
  echo "Could not find port for $INSTANCE."
  echo "Run: $OPS_DIR/status-all.sh"
  exit 1
fi

if [[ "$STATUS" != RUNNING* && "$STATUS" != LISTEN* ]]; then
  echo "$INSTANCE is not running; current status: ${STATUS:-unknown}"
  echo "Run: $OPS_DIR/start-all.sh"
  exit 1
fi

URL="ws://127.0.0.1:$PORT"
SESSION="agent:${AGENT_ID}:main"

export HOME="$BASE_DIR/$INSTANCE"
export OPENCLAW_CONFIG_PATH="$CONFIG"
export OPENCLAW_STATE_DIR="$BASE_DIR/$INSTANCE/.openclaw"

OPENCLAW_BIN="${OPENCLAW_BIN:-$(command -v openclaw || true)}"
if [ -z "$OPENCLAW_BIN" ] || [ ! -x "$OPENCLAW_BIN" ]; then
  OPENCLAW_BIN="/usr/local/bin/openclaw"
fi
# 防呆：agent 会话 PATH 可能把 openclaw 解析到实例私有 shim（降权用户无法穿越）
case "$OPENCLAW_BIN" in
  */.openclaw/*)
    echo "WARN: openclaw resolves inside an instance state dir ($OPENCLAW_BIN); using /usr/local/bin/openclaw"
    OPENCLAW_BIN="/usr/local/bin/openclaw"
    ;;
esac

# 实例映射了专属运行用户时，root 身份的 TUI 降到该用户运行（否则 device-identity/缓存目录归属检查会拒绝）
RUN_USER="$(awk -F= -v n="$INSTANCE" '$1 == n { print $2; exit }' "$OPS_DIR/instance-users.conf" 2>/dev/null || true)"

echo "Connecting $INSTANCE"
echo "Agent: $AGENT_ID"
echo "URL: $URL"
echo "Session: $SESSION"

TUI_ARGS=(--url "$URL" --token "$TOKEN" --session "$SESSION")
if [ -n "$MESSAGE" ]; then
  TUI_ARGS+=(--message "$MESSAGE")
fi

if [ -n "$RUN_USER" ] && [ "$(id -u)" = "0" ]; then
  echo "Run-as: $RUN_USER"
  exec setpriv --reuid "$RUN_USER" --regid "$(id -g "$RUN_USER")" --init-groups --inh-caps=-all --ambient-caps=-all     "$OPENCLAW_BIN" tui "${TUI_ARGS[@]}"
fi

exec "$OPENCLAW_BIN" tui "${TUI_ARGS[@]}"
