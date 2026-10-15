#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="/data/agent"
OPS_DIR="$BASE_DIR/ops"
PORT_FILE="$OPS_DIR/instance-ports.conf"
PID_DIR="$OPS_DIR/pids"
BASE_PORT="${BASE_PORT:-18790}"

mkdir -p "$OPS_DIR" "$PID_DIR"
touch "$PORT_FILE"

get_env_value() {
  local pid="$1"
  local key="$2"

  if [ ! -r "/proc/$pid/environ" ]; then
    return
  fi

  tr '\0' '\n' < "/proc/$pid/environ" \
    | sed -n "s/^${key}=//p" \
    | head -1
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

pids_from_port() {
  local port="$1"
  ss -ltnp "( sport = :$port )" 2>/dev/null \
    | sed -n 's/.*pid=\([0-9]\+\).*/\1/p' \
    | sort -u
}

sync_port_file

printf "%-20s %-8s %-12s %-8s %-10s %-s\n" "INSTANCE" "PORT" "STATUS" "PID" "ENV" "URL"
printf "%-20s %-8s %-12s %-8s %-10s %-s\n" "--------" "----" "------" "---" "---" "---"

while IFS='=' read -r name port; do
  [ -n "${name:-}" ] || continue
  [ -n "${port:-}" ] || continue
  [[ "$name" =~ ^# ]] && continue

  instance_dir="$BASE_DIR/$name"
  expected_home="$instance_dir"
  expected_state="$instance_dir/.openclaw"
  expected_config="$instance_dir/.openclaw/openclaw.json"
  pid_file="$PID_DIR/$name.pid"
  pid=""
  status="STOPPED"
  env_status="-"

  if [ ! -d "$instance_dir/.openclaw" ]; then
    printf "%-20s %-8s %-12s %-8s %-10s http://127.0.0.1:%s/\n" "$name" "$port" "MISSING_DIR" "-" "-" "$port"
    continue
  fi

  if [ ! -f "$expected_config" ]; then
    printf "%-20s %-8s %-12s %-8s %-10s http://127.0.0.1:%s/\n" "$name" "$port" "NO_CONFIG" "-" "-" "$port"
    continue
  fi

  if [ -f "$pid_file" ]; then
    saved_pid="$(cat "$pid_file" || true)"
    if [ -n "$saved_pid" ] && kill -0 "$saved_pid" 2>/dev/null; then
      pid="$saved_pid"
    fi
  fi

  if [ -z "$pid" ]; then
    pid="$(pids_from_port "$port" | head -1)"
  fi

  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    if is_port_used "$port"; then
      if curl -fsS -I "http://127.0.0.1:$port/" >/dev/null 2>&1; then
        status="RUNNING"
      else
        status="LISTEN"
      fi
    else
      status="STARTING"
    fi

    actual_home="$(get_env_value "$pid" "HOME" || true)"
    actual_state="$(get_env_value "$pid" "OPENCLAW_STATE_DIR" || true)"
    actual_config="$(get_env_value "$pid" "OPENCLAW_CONFIG_PATH" || true)"

    if [ "$actual_home" = "$expected_home" ] \
      && [ "$actual_state" = "$expected_state" ] \
      && [ "$actual_config" = "$expected_config" ]; then
      env_status="OK"
    else
      env_status="BAD_ENV"
      status="${status}!"
    fi
  else
    pid="-"
  fi

  printf "%-20s %-8s %-12s %-8s %-10s http://127.0.0.1:%s/\n" "$name" "$port" "$status" "$pid" "$env_status" "$port"

done < "$PORT_FILE"
