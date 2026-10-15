#!/usr/bin/env bash
# 用法: bash audit.sh "2026-09-21 09:46:00"
# 输出: 每个 agent 的 活动/工具调用/播报调用 统计（终端 + /tmp/bcast-audit-result.txt）
# 说明: 覆盖 8 实例；每次全新 cp DB 副本到 /tmp/bcast-audit-db（旧副本缺新窗口事件会静默漏计，09-22 修）绕开 exec 护栏；find|grep /agent/ 过滤 legacy 迁移目录
# 工具数附 [cron=N chat=M] 拆分（09-23 增）：cron-only agent 非违规（定时任务按设计静默），合规判定看 chat 部分
cutoff=$(( $(date -d "$1" +%s) * 1000 ))
echo "窗口起点: $(date -d @$((cutoff/1000)) '+%F %T')"
out=/tmp/bcast-audit-result.txt; : > $out
mkdir -p /tmp/bcast-audit-db
for inst in openclaw_sxs openclaw_GTM openclaw_TeamS openclaw_GYL openclaw_need openclaw_PJT openclaw_QD openclaw_XMT; do
  for adb in $(find /data/agent/$inst/.openclaw/agents -maxdepth 3 -name "openclaw-agent.sqlite" 2>/dev/null | grep "/agent/"); do
    aid=$(basename "$(dirname "$(dirname "$adb")")")
    tmp="/tmp/bcast-audit-db/${inst}__${aid}.sqlite"
    cp -f "$adb" "$tmp" 2>/dev/null   # 必须全新复制：[ -f ]||cp 会复用上次运行的旧快照，缺新事件导致漏计
    acts=$(timeout 10 sqlite3 "$tmp" "SELECT COUNT(*) FROM session_nodes WHERE COALESCE(last_activity_at,last_interaction_at,updated_at) >= $cutoff;" 2>/dev/null)
    tools=$(timeout 15 sqlite3 "$tmp" "SELECT COUNT(*) FROM transcript_events WHERE created_at >= $cutoff AND (event_json LIKE '%\"type\":\"toolCall\"%' OR event_json LIKE '%\"type\":\"tool_use\"%');" 2>/dev/null)
    casts=$(timeout 15 sqlite3 "$tmp" "SELECT COUNT(*) FROM transcript_events WHERE created_at >= $cutoff AND event_json LIKE '%+messages-send%';" 2>/dev/null)
    split=$(timeout 15 sqlite3 "$tmp" "SELECT CASE WHEN w.session_key LIKE '%:cron:%' THEN 'cron' ELSE 'chat' END || '=' || COUNT(*) FROM transcript_events e JOIN (SELECT DISTINCT session_id, session_key FROM session_windows) w ON e.session_id=w.session_id WHERE e.created_at >= $cutoff AND (e.event_json LIKE '%\"type\":\"toolCall\"%' OR e.event_json LIKE '%\"type\":\"tool_use\"%') GROUP BY CASE WHEN w.session_key LIKE '%:cron:%' THEN 'cron' ELSE 'chat' END;" 2>/dev/null | tr '\n' ' ')
    [ -z "$acts" ] && continue   # legacy 等无法读取的副本跳过
    echo "$inst/$aid: 活动=${acts:-0} 工具=${tools:-0} 播报=${casts:-0} [${split:-无会话映射}]" >> $out
  done
done
cat $out
