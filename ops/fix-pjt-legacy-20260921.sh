#!/usr/bin/env bash
# fix-pjt-legacy-20260921.sh — 一次性修复 PJT 网关 legacy workspace setup 状态迁移
# 背景: doctor 报 StartupMaintenanceRequiredError "Legacy workspace setup state requires migration"
#       (workspace/openclaw-workspace-state.json, 2026-07-21 遗留)，修复需独占状态库，必须停网关执行
# 生成: 2026-09-21 by PJT main agent（owner 指示修复）
# 用法: bash /data/agent/ops/fix-pjt-legacy-20260921.sh
# 影响: 仅重启 openclaw_PJT 网关(端口18791)，其余 7 个网关不受影响；预计 1-2 分钟
# 回滚: /tmp/pjt-backup/*-openclaw-backup.tar.gz (已验证) +
#       .openclaw/backups/openclaw-workspace-state.json.bak-20260921

set -uo pipefail

NAME="openclaw_PJT"
BASE_DIR="/data/agent"
OPS_DIR="$BASE_DIR/ops"
INSTANCE_DIR="$BASE_DIR/$NAME"
STATE_DIR="$INSTANCE_DIR/.openclaw"
CONFIG="$STATE_DIR/openclaw.json"
PID_FILE="$OPS_DIR/pids/$NAME.pid"
LOG_FILE="$OPS_DIR/logs/$NAME.log"
LEGACY_FILE="$STATE_DIR/workspace/openclaw-workspace-state.json"
LEGACY_BAK="$STATE_DIR/backups/openclaw-workspace-state.json.bak-20260921"
BACKUP_DIR="/tmp/pjt-backup"
FIX_LOG="$BACKUP_DIR/fix-run-$(date +%Y%m%d-%H%M%S).log"

OPENCLAW_BIN="${OPENCLAW_BIN:-$(command -v openclaw || true)}"
[ -z "$OPENCLAW_BIN" ] && OPENCLAW_BIN="/usr/local/bin/openclaw"

PORT="$(awk -F= -v n="$NAME" '$1==n{print $2}' "$OPS_DIR/instance-ports.conf" 2>/dev/null)"
[ -z "$PORT" ] && PORT=18791

mkdir -p "$BACKUP_DIR"
exec > >(tee -a "$FIX_LOG") 2>&1

say(){ echo "[$(date +%H:%M:%S)] $*"; }

pids_on_port(){
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | sort -u
    return
  fi
  ss -ltnp "( sport = :$PORT )" 2>/dev/null | sed -n 's/.*pid=\([0-9]\+\).*/\1/p' | sort -u
}

say "== [0/6] 前置校验"
fail=0
[ -x "$OPENCLAW_BIN" ] || { say "FATAL openclaw 不可用: $OPENCLAW_BIN"; fail=1; }
[ -f "$CONFIG" ] || { say "FATAL 缺少配置 $CONFIG"; fail=1; }
ls "$BACKUP_DIR"/*openclaw-backup.tar.gz >/dev/null 2>&1 || { say "FATAL 未找到备份归档 $BACKUP_DIR"; fail=1; }
[ -f "$LEGACY_BAK" ] || { say "FATAL 缺少 legacy 单文件备份 $LEGACY_BAK"; fail=1; }
if [ "$fail" = 1 ]; then say "中止：先解决上述问题再跑"; exit 1; fi
say "OK openclaw=$OPENCLAW_BIN port=$PORT 备份齐备"

say "== [1/6] 停止 $NAME 网关（仅此实例）"
PIDS="$(pids_on_port)"
if [ -z "$PIDS" ]; then
  say "端口 $PORT 无监听（网关可能已停止）"
else
  for pid in $PIDS; do
    cwd="$(readlink /proc/$pid/cwd 2>/dev/null || true)"
    if [ -n "$cwd" ] && [ "$cwd" != "$INSTANCE_DIR" ]; then
      say "SKIP pid=$pid cwd=$cwd 不是 $INSTANCE_DIR，不动它"
      continue
    fi
    say "STOP pid=$pid (SIGTERM)"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 15); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    if kill -0 "$pid" 2>/dev/null; then
      say "KILL pid=$pid (15s 未退出，升级为 SIGKILL)"
      kill -9 "$pid" 2>/dev/null || true
      sleep 2
    fi
  done
fi
if [ -n "$(pids_on_port)" ]; then
  say "FATAL 端口 $PORT 仍被占用，中止（不会跑 doctor）"
  exit 1
fi
say "OK 网关已停，端口已释放"
rm -f "$PID_FILE"

say "== [2/6] 等待状态库句柄落盘"
sleep 3

say "== [3/6] openclaw doctor --fix（限时10分钟）"
cd "$INSTANCE_DIR"
env HOME="$INSTANCE_DIR" OPENCLAW_CONFIG_PATH="$CONFIG" OPENCLAW_STATE_DIR="$STATE_DIR" \
  timeout 600 "$OPENCLAW_BIN" doctor --fix --yes
FIX_RC=$?
say "doctor 退出码=$FIX_RC"

say "== [4/6] 验证迁移结果"
if [ -f "$LEGACY_FILE" ]; then
  say "WARN legacy 文件仍在: $LEGACY_FILE"
else
  say "OK legacy 文件已被迁移移除"
fi

say "== [5/6] 重启 $NAME（与 start-all.sh 同款拉起方式）"
(
  cd "$INSTANCE_DIR"
  env HOME="$INSTANCE_DIR" OPENCLAW_CONFIG_PATH="$CONFIG" OPENCLAW_STATE_DIR="$STATE_DIR" \
    nohup "$OPENCLAW_BIN" gateway --port "$PORT" >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
)
STARTED=0
for _ in $(seq 1 45); do
  [ -n "$(pids_on_port)" ] && { STARTED=1; break; }
  sleep 1
done

say "== [6/6] 汇总"
if [ "$STARTED" = 1 ]; then
  say "OK 网关已恢复 pid=$(cat "$PID_FILE" 2>/dev/null) port=$PORT 日志=$LOG_FILE"
else
  say "FAIL 网关 45s 内未监听 $PORT；手动拉起: bash $OPS_DIR/start-all.sh；看日志: tail -50 $LOG_FILE"
fi
if [ ! -f "$LEGACY_FILE" ]; then
  say "RESULT=FIXED (doctor_rc=$FIX_RC) — 完整日志 $FIX_LOG"
  exit 0
fi
say "RESULT=NOT-FIXED (doctor_rc=$FIX_RC) — 网关状态见上，细节看 $FIX_LOG"
exit 2
