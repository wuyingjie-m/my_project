// broadcast-gate：把过程播报当成工具调用的前置条件（弹回式门禁）
// 规则1：一个 run 的首个工具调用前若未播报 → 弹回一次（PROGRESS_BROADCAST_REQUIRED）
// 规则2：距上次播报超过 staleMinutes 分钟再调工具 → 弹回补节点播报（MILESTONE_STALE）
// 豁免：cron 触发、后台子代理、心跳会话（sessionKey 特征判断，防御式）
// mode: "log"（只记违规日志，不拦截，用于试跑观察）/ "enforce"（真弹回）

import fs from "node:fs";
import path from "node:path";

const DEFAULT_LOG = "/tmp/broadcast-gate-violations.log";

function appendLog(file, line) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line + "\n");
  } catch {}
}

// 豁免：cron 触发 / 后台子代理 / 心跳（拿不到 sessionKey 时宁可放行，防误拦正常任务）
function isExempt(sessionKey) {
  if (!sessionKey) return true;
  const k = String(sessionKey);
  return (
    k.includes(":cron:") ||
    k.includes(":subagent:") ||
    k.includes("heartbeat") ||
    k.includes(":isolated:")
  );
}

// 播报调用自识别：exec 且命令文本是「以 bot 身份调 lark-cli 播报」（AGENTS.md 规定的标准形态）
function isBroadcastCall(event) {
  if (String(event?.toolName || "") !== "exec") return false;
  try {
    const s = JSON.stringify(event.params ?? event.args ?? {});
    return /im\s+\+messages-send/.test(s) && /--as\s+bot/.test(s);
  } catch {
    return false;
  }
}

export default function register(api) {
  const cfg = { mode: "log", staleMinutes: 5, ...(api.pluginConfig ?? {}) };
  const staleMs = Math.max(1, Number(cfg.staleMinutes) || 5) * 60_000;
  const logFile = cfg.logFile || DEFAULT_LOG;
  // 按 runId 维护状态；网关重启即清零（run 生命周期短，可接受）
  const runs = new Map();

  api.on("gateway_stop", () => runs.clear());

  // before_tool_call 的 handler 必须同步返回（async 返回值在该钩子不保证生效）
  api.on("before_tool_call", (event, ctx) => {
    const sessionKey = ctx?.sessionKey || "";
    if (isExempt(sessionKey)) return;

    const runId = ctx?.runId || sessionKey || "";
    if (!runId) return; // 拿不到 run 标识时放行，防误拦

    const now = Date.now();
    const fresh = !runs.has(runId);
    const st = fresh
      ? { broadcasted: false, firstToolAt: now, lastBroadcastAt: 0, lastNagAt: 0 }
      : runs.get(runId);
    runs.set(runId, st);

    // 防状态表无限增长：清理超过 6 小时的旧 run
    if (runs.size > 500) {
      for (const [k, v] of runs) {
        if (now - v.firstToolAt > 6 * 3600_000) runs.delete(k);
      }
    }

    // 播报调用自识别：更新状态并放行
    if (isBroadcastCall(event)) {
      st.broadcasted = true;
      st.lastBroadcastAt = now;
      return;
    }

    const agentId = ctx?.agentId || "unknown";
    let reason = "";
    if (!st.broadcasted && fresh) {
      reason = "PROGRESS_BROADCAST_REQUIRED"; // 规则1
    } else if (
      st.broadcasted &&
      st.lastBroadcastAt > 0 &&
      now - st.lastBroadcastAt > staleMs
    ) {
      reason = "MILESTONE_STALE"; // 规则2
    } else if (
      !st.broadcasted &&
      !fresh &&
      now - st.firstToolAt > staleMs
    ) {
      reason = "PROGRESS_BROADCAST_REQUIRED"; // 规则2b：始终未播报且已超阈值
    }
    if (!reason) return;

    // 同一 run 15 秒内不重复记日志（防刷屏），但拦截行为照常
    if (now - st.lastNagAt > 15_000) {
      st.lastNagAt = now;
      appendLog(
        logFile,
        `${new Date().toISOString()} agent=${agentId} run=${runId} tool=${event?.toolName} reason=${reason} mode=${cfg.mode}`
      );
    }

    if (cfg.mode !== "enforce") return; // 试跑模式：只记日志

    return {
      block: true,
      blockReason:
        reason === "PROGRESS_BROADCAST_REQUIRED"
          ? 'PROGRESS_BROADCAST_REQUIRED: 本任务尚未播报。先用 exec 执行一次开始播报：lark-cli im +messages-send --as bot --chat-id <当前会话chat_id> --text "一行进展" --idempotency-key "milestone-<n>-<日期>"，成功后重试本工具调用。'
          : `MILESTONE_STALE: 距上次播报已超过 ${Math.round(staleMs / 60000)} 分钟。先补一条进展播报（exec: lark-cli im +messages-send --as bot --chat-id <当前会话chat_id> --text "当前进展一行" --idempotency-key "milestone-<n>-<日期>"），成功后重试本工具调用。`,
    };
  });
}
