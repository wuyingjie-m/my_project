#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="/data/agent"
OPS_DIR="$BASE_DIR/ops"
PORT_FILE="$OPS_DIR/instance-ports.conf"
PID_DIR="$OPS_DIR/pids"
LOG_DIR="$OPS_DIR/logs"
BASE_PORT="${BASE_PORT:-18790}"

mkdir -p "$OPS_DIR" "$PID_DIR" "$LOG_DIR"

touch "$PORT_FILE"
touch "$OPS_DIR/instance-users.conf"

OPENCLAW_BIN="${OPENCLAW_BIN:-$(command -v openclaw || true)}"
if [ -z "$OPENCLAW_BIN" ]; then
  OPENCLAW_BIN="/usr/local/bin/openclaw"
fi

if [ ! -x "$OPENCLAW_BIN" ]; then
  echo "ERROR: openclaw not found. Set OPENCLAW_BIN=/path/to/openclaw"
  exit 1
fi

# 防呆：agent 会话的 PATH 会把 openclaw 解析到实例私有 shim（降权用户无法穿越），回退系统路径
case "$OPENCLAW_BIN" in
  */.openclaw/*)
    echo "WARN: OPENCLAW_BIN resolves inside an instance state dir ($OPENCLAW_BIN); falling back to /usr/local/bin/openclaw"
    OPENCLAW_BIN="/usr/local/bin/openclaw"
    ;;
esac

if [ ! -x "$OPENCLAW_BIN" ]; then
  echo "ERROR: fallback OPENCLAW_BIN not executable: $OPENCLAW_BIN"
  exit 1
fi

is_pid_running() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

is_port_used() {
  local port="$1"
  ss -ltn "( sport = :$port )" | grep -qE '127\.0\.0\.1:'"$port"'|\[::1\]:'"$port"
}

port_is_recorded() {
  local port="$1"
  awk -F= -v port="$port" '$1 !~ /^#/ && $2 == port { found=1 } END { exit found ? 0 : 1 }' "$PORT_FILE"
}

next_free_port() {
  local port="$BASE_PORT"
  while port_is_recorded "$port" || is_port_used "$port"; do
    port=$((port + 1))
  done
  echo "$port"
}

sync_port_file() {
  local tmp
  tmp="$(mktemp)"

  awk -F= 'NF >= 2 && $1 != "" && $1 !~ /^#/ { print $1 "=" $2 }' "$PORT_FILE" > "$tmp"

  for dir in "$BASE_DIR"/openclaw_*; do
    [ -d "$dir/.openclaw" ] || continue
    local name
    name="$(basename "$dir")"

    if ! awk -F= -v name="$name" '$1 == name { found=1 } END { exit found ? 0 : 1 }' "$tmp"; then
      local port
      port="$BASE_PORT"
      while awk -F= -v port="$port" '$2 == port { found=1 } END { exit found ? 0 : 1 }' "$tmp" || is_port_used "$port"; do
        port=$((port + 1))
      done
      echo "$name=$port" >> "$tmp"
    fi
  done

  sort -t= -k1,1 "$tmp" > "$PORT_FILE"
  rm -f "$tmp"
}

sync_port_file

while IFS='=' read -r name port; do
  [ -n "${name:-}" ] || continue
  [ -n "${port:-}" ] || continue
  [[ "$name" =~ ^# ]] && continue

  instance_dir="$BASE_DIR/$name"
  config_path="$instance_dir/.openclaw/openclaw.json"
  pid_file="$PID_DIR/$name.pid"
  log_file="$LOG_DIR/$name.log"

  if [ ! -d "$instance_dir/.openclaw" ]; then
    echo "SKIP $name: missing $instance_dir/.openclaw"
    continue
  fi

  if [ ! -f "$config_path" ]; then
    echo "SKIP $name: missing $config_path"
    continue
  fi

  if [ -f "$pid_file" ] && is_pid_running "$(cat "$pid_file")"; then
    echo "OK   $name already running, pid=$(cat "$pid_file"), port=$port"
    continue
  fi

  rm -f "$pid_file"

  if is_port_used "$port"; then
    echo "SKIP $name: port $port is already in use"
    continue
  fi

  run_user="$(awk -F= -v n="$name" '$1 == n { print $2; exit }' "$OPS_DIR/instance-users.conf" 2>/dev/null || true)"

  echo "START $name on port $port"
  echo "     HOME=$instance_dir"
  echo "     config=$config_path"
  echo "     log=$log_file"
  if [ -n "$run_user" ]; then
    echo "     run-as=$run_user"
  fi

  (
    cd "$instance_dir"
    if [ -n "$run_user" ]; then
      env \
        HOME="$instance_dir" \
        OPENCLAW_CONFIG_PATH="$config_path" \
        OPENCLAW_STATE_DIR="$instance_dir/.openclaw" \
        setpriv --reuid "$run_user" --regid "$(id -g "$run_user")" --init-groups --inh-caps=-all --ambient-caps=-all \
        nohup "$OPENCLAW_BIN" gateway --port "$port" > "$log_file" 2>&1 &
    else
      env \
        HOME="$instance_dir" \
        OPENCLAW_CONFIG_PATH="$config_path" \
        OPENCLAW_STATE_DIR="$instance_dir/.openclaw" \
        nohup "$OPENCLAW_BIN" gateway --port "$port" > "$log_file" 2>&1 &
    fi
    echo $! > "$pid_file"
  )

  started=0
  for _ in $(seq 1 5); do
    if [ -f "$pid_file" ] && is_pid_running "$(cat "$pid_file")" && is_port_used "$port"; then
      started=1
      break
    fi
    sleep 1
  done

  if [ "$started" -eq 1 ]; then
    echo "OK   $name started, pid=$(cat "$pid_file"), port=$port"
  elif [ -f "$pid_file" ] && is_pid_running "$(cat "$pid_file")"; then
    echo "WAIT $name process is running but port $port is not listening yet, pid=$(cat "$pid_file"), log=$log_file"
  else
    echo "FAIL $name failed to start, check log=$log_file"
  fi
done < "$PORT_FILE"

echo
echo "Port mapping:"
cat "$PORT_FILE"
