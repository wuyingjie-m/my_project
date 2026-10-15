import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";

export interface DailyStats {
  date: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  messageCount: number;
  avgResponseMs: number;
}

export interface InternalDailyStats extends DailyStats {
  responseTimes: number[];
}

export interface ModelStats {
  modelId: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  messageCount: number;
  avgResponseMs: number;
  responseTimes: number[];
}

export interface SqliteAgentStats {
  lastActive: number | null;
  totalTokens: number;
  contextTokens: number;
  sessionCount: number;
  messageCount: number;
  daily: DailyStats[];
  dailyWithResponseTimes: InternalDailyStats[];
  models: ModelStats[];
}

function parseJsonRows(raw: string): any[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function numberValue(value: unknown): number {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function dateValue(timestamp: unknown, createdAt: unknown): string {
  if (typeof timestamp === "string" && timestamp.length >= 10) return timestamp.slice(0, 10);
  const ms = numberValue(createdAt);
  return ms > 0 ? new Date(ms).toISOString().slice(0, 10) : "";
}

function usageTokens(usage: any): { input: number; output: number; total: number } {
  if (!usage || typeof usage !== "object") return { input: 0, output: 0, total: 0 };
  const input = numberValue(usage.input);
  const output = numberValue(usage.output);
  const total = numberValue(usage.totalTokens) || input + output;
  return { input, output, total };
}

function isTerminalAssistantMessage(message: any): boolean {
  const stopReason = typeof message?.stopReason === "string" ? message.stopReason : "";
  return stopReason === "stop" || stopReason === "end_turn";
}

// 每 agent 统计缓存：config/stats-all/models 共用本库，避免同一 DB 在 TTL 内被同步 execFileSync 反复查询
const agentStatsCache = new Map<string, { stats: SqliteAgentStats; ts: number }>();
const AGENT_STATS_TTL_MS = 300_000;

export function getSqliteDailyStats(homeDir: string, agentId: string): InternalDailyStats[] | null {
  const stats = getSqliteAgentStats(homeDir, agentId);
  return stats?.dailyWithResponseTimes || null;
}

export function getSqliteModelStats(homeDir: string, agentId: string): ModelStats[] | null {
  const stats = getSqliteAgentStats(homeDir, agentId);
  return stats?.models || null;
}

export function getSqliteAgentStats(homeDir: string, agentId: string): SqliteAgentStats | null {
  const cacheKey = `${homeDir}::${agentId}`;
  const cached = agentStatsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < AGENT_STATS_TTL_MS) return cached.stats;

  const candidates = [
    path.join(homeDir, "agents", agentId, "agent", "openclaw-agent.sqlite"),
    path.join(homeDir, "agents", agentId, "openclaw-agent.sqlite"),
  ];
  const dbPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!dbPath) return null;

  try {
    // 使用 Node 内置 sqlite（进程内查询）替代 spawn sqlite3 CLI：
    // 串行 CLI spawn + 全量 JSON 序列化曾是统计冷启动分钟级阻塞的根源
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      const sessionRow = db.prepare(
        "SELECT COUNT(*) AS sessionCount, MAX(COALESCE(last_activity_at,last_interaction_at,updated_at)) AS lastActive FROM session_nodes",
      ).get();
      const sessionRows = [sessionRow || {}];
      // 只转储近窗口事件：仪表盘只需要近期趋势
      const eventCutoffMs = Date.now() - 120 * 24 * 60 * 60 * 1000;
      const eventCutoffIso = new Date(eventCutoffMs).toISOString();
      const eventRows = db.prepare(
        "SELECT session_id, created_at, event_json FROM transcript_events "
          + "WHERE (typeof(created_at) = 'integer' AND created_at >= ?) "
          + "OR (typeof(created_at) = 'text' AND created_at >= ?) "
          + "ORDER BY created_at ASC",
      ).all(eventCutoffMs, eventCutoffIso);

    const dayMap = new Map<string, InternalDailyStats>();
    const modelMap = new Map<string, ModelStats>();
    const lastUserBySession = new Map<string, number>();
    let totalTokens = 0;
    let messageCount = 0;
    let lastMessageAt = 0;

    for (const row of eventRows) {
      let event: any;
      try {
        event = JSON.parse(String(row.event_json || ""));
      } catch {
        continue;
      }
      if (event?.type !== "message" || !event.message) continue;

      const at = typeof event.timestamp === "string"
        ? Date.parse(event.timestamp)
        : numberValue(row.created_at);
      if (Number.isFinite(at) && at > lastMessageAt) lastMessageAt = at;

      const date = dateValue(event.timestamp, row.created_at);
      if (!date) continue;

      const sessionId = String(row.session_id || "");
      const message = event.message;
      const role = typeof message.role === "string" ? message.role : "";

      if (role === "user") {
        if (Number.isFinite(at) && at > 0) lastUserBySession.set(sessionId, at);
        continue;
      }

      if (role !== "assistant") continue;

      const currentDay = dayMap.get(date) || {
        date,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        messageCount: 0,
        avgResponseMs: 0,
        responseTimes: [],
      };

      const usage = usageTokens(message.usage);
      if (usage.total > 0) {
        currentDay.inputTokens += usage.input;
        currentDay.outputTokens += usage.output;
        currentDay.totalTokens += usage.total;
        currentDay.messageCount += 1;
        totalTokens += usage.total;
        messageCount += 1;

        if (message.model) {
          const key = `${message.provider || "unknown"}/${message.model}`;
          const model = modelMap.get(key) || {
            modelId: String(message.model),
            provider: String(message.provider || "unknown"),
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            messageCount: 0,
            avgResponseMs: 0,
            responseTimes: [],
          };
          model.inputTokens += usage.input;
          model.outputTokens += usage.output;
          model.totalTokens += usage.total;
          model.messageCount += 1;
          modelMap.set(key, model);
        }
      }

      const previousUser = lastUserBySession.get(sessionId);
      if (previousUser && isTerminalAssistantMessage(message)) {
        const diff = at - previousUser;
        if (diff > 0 && diff < 600000) {
          currentDay.responseTimes.push(diff);
          if (message.model) {
            const key = `${message.provider || "unknown"}/${message.model}`;
            const model = modelMap.get(key);
            if (model) model.responseTimes.push(diff);
          }
        }
        lastUserBySession.delete(sessionId);
      }

      dayMap.set(date, currentDay);
    }

    const dailyWithResponseTimes = Array.from(dayMap.values())
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((day) => ({
        ...day,
        avgResponseMs: day.responseTimes.length
          ? Math.round(day.responseTimes.reduce((sum, value) => sum + value, 0) / day.responseTimes.length)
          : 0,
      }));

    const daily = dailyWithResponseTimes.map(({ responseTimes, ...day }) => day);
    const models = Array.from(modelMap.values())
      .map((model) => ({
        ...model,
        avgResponseMs: model.responseTimes.length
          ? Math.round(model.responseTimes.reduce((sum, value) => sum + value, 0) / model.responseTimes.length)
          : 0,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens);

    const stats: SqliteAgentStats = {
      lastActive: Math.max(numberValue(sessionRows[0]?.lastActive), lastMessageAt) || null,
      totalTokens,
      contextTokens: 0,
      sessionCount: numberValue(sessionRows[0]?.sessionCount),
      messageCount,
      daily,
      dailyWithResponseTimes,
      models,
    };
      agentStatsCache.set(cacheKey, { stats, ts: Date.now() });
      return stats;
    } finally {
      db.close();
    }
  } catch (error) {
    console.error(`Failed to read OpenClaw SQLite stats for ${agentId}:`, error);
    return null;
  }
}
