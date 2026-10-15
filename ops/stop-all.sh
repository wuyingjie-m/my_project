#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="/data/agent"
OPS_DIR="$BASE_DIR/ops"
PORT_FILE="$OPS_DIR/instance-ports.conf"
PID_DIR="$OPS_DIR/pids"
BASE_PORT="${BASE_PORT:-18790}"
GLOBAL_PORTS=("18789")

mkdir -p "$OPS_DIR" "$PID_DIR"
touch "$PORT_FILE"

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

stop_pid() {
  local pid="$1"
  local name="$2"

  if [ -z "${pid:-}" ]; then
    return
  fi

  if ! kill -0 "$pid" 2>/dev/null; then
    echo "OK   $name already stopped"
    return
  fi

  echo "STOP $name pid=$pid"
  kill "$pid" 2>/dev/null || true

  for _ in $(seq 1 10); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "OK   $name stopped"
      return
    fi
    sleep 1
  done

  echo "KILL $name pid=$pid"
  kill -9 "$pid" 2>/dev/null || true
}

pids_from_port() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u
    return
  fi

  ss -ltnp "( sport = :$port )" 2>/dev/null \
    | sed -n 's/.*pid=\([0-9]\+\).*/\1/p' \
    | sort -u
}

stop_port() {
  local port="$1"
  local name="$2"
  local found=0

  while IFS= read -r pid; do
    [ -n "${pid:-}" ] || continue
    found=1
    stop_pid "$pid" "$name port=$port"
  done < <(pids_from_port "$port")

  if [ "$found" -eq 0 ]; then
    echo "OK   $name not running on port $port"
  fi
}

sync_port_file

while IFS='=' read -r name port; do
  [ -n "${name:-}" ] || continue
  [ -n "${port:-}" ] || continue
  [[ "$name" =~ ^# ]] && continue

  pid_file="$PID_DIR/$name.pid"

  if [ -f "$pid_file" ]; then
    pid="$(cat "$pid_file" || true)"
    stop_pid "$pid" "$name"
    rm -f "$pid_file"
  fi

  stop_port "$port" "$name"
done < "$PORT_FILE"

echo
echo "Stopping global/default OpenClaw gateway ports..."

for port in "${GLOBAL_PORTS[@]}"; do
  stop_port "$port" "global-openclaw"
done
