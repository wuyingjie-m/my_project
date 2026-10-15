import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { discoverOpenClawInstances, getInstanceAgentIds, configuredAgentEntries } from "@/lib/openclaw-instances";
import { getSqliteDailyStats } from "@/lib/sqlite-stats";
import { loadDiskCache, saveDiskCache } from "@/lib/disk-cache";

// 30秒内存缓存（SWR：命中直接返回，过期返回旧数据并后台单飞刷新）——与 stats-all 同模式
let overviewCache: { data: any; ts: number } | null = loadDiskCache<any>("global-overview");
let overviewRefreshing = false;
const CACHE_TTL_MS = 30_000;

// 当前周起始（UTC 周一，与 stats-all 周聚合口径一致）
function currentWeekStart(): string {
  const now = new Date();
  const day = now.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + mondayOffset))
    .toISOString().slice(0, 10);
}

// sqlite 缺席时的 JSONL 兜底：仅累计本周 assistant usage 总量（多数实例已迁 sqlite，此路极少走）
function weeklyTokensFromJsonl(homeDir: string, agentId: string, weekStart: string) {
  const sessionsDir = path.join(homeDir, "agents", agentId, "sessions");
  const totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, messageCount: 0 };
  let files: string[] = [];
  try {
    files = fs.readdirSync(sessionsDir).filter((f) => /\.jsonl$/.test(f) && !f.includes(".deleted."));
  } catch {
    return totals;
  }
  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(sessionsDir, file), "utf-8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line.includes('"usage"')) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.type !== "message" || entry.message?.role !== "assistant" || !entry.message?.usage) continue;
      const date = typeof entry.timestamp === "string" ? entry.timestamp.slice(0, 10) : "";
      if (!date || date < weekStart) continue;
      totals.inputTokens += entry.message.usage.input || 0;
      totals.outputTokens += entry.message.usage.output || 0;
      totals.totalTokens += entry.message.usage.totalTokens || 0;
      totals.messageCount += 1;
    }
  }
  return totals;
}

async function computeGlobalOverview() {
  const weekStart = currentWeekStart();
  const instances = discoverOpenClawInstances();
  const agents: Array<{
    instanceId: string;
    instanceName: string;
    agentId: string;
    name: string;
    emoji: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    messageCount: number;
  }> = [];

  for (const instance of instances) {
    for (const agentId of getInstanceAgentIds(instance)) {
      const daily = getSqliteDailyStats(instance.homeDir, agentId);
      let week = { inputTokens: 0, outputTokens: 0, totalTokens: 0, messageCount: 0 };
      if (daily) {
        for (const d of daily) {
          if (d.date < weekStart) continue;
          week.inputTokens += d.inputTokens;
          week.outputTokens += d.outputTokens;
          week.totalTokens += d.totalTokens;
          week.messageCount += d.messageCount;
        }
      } else {
        week = weeklyTokensFromJsonl(instance.homeDir, agentId, weekStart);
      }
      const entry = configuredAgentEntries(instance.config).find((a) => a.id === agentId);
      agents.push({
        instanceId: instance.id,
        instanceName: instance.name,
        agentId,
        name: entry?.name || agentId,
        emoji: entry?.emoji || entry?.identity?.emoji || "🤖",
        inputTokens: week.inputTokens,
        outputTokens: week.outputTokens,
        totalTokens: week.totalTokens,
        messageCount: week.messageCount,
      });
    }
  }

  agents.sort((a, b) => b.totalTokens - a.totalTokens || a.instanceId.localeCompare(b.instanceId) || a.agentId.localeCompare(b.agentId));
  const totals = agents.reduce(
    (acc, a) => ({
      inputTokens: acc.inputTokens + a.inputTokens,
      outputTokens: acc.outputTokens + a.outputTokens,
      totalTokens: acc.totalTokens + a.totalTokens,
      messageCount: acc.messageCount + a.messageCount,
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, messageCount: 0 },
  );

  return {
    generatedAt: new Date().toISOString(),
    weekStart,
    totals,
    agents,
  };
}


export async function GET() {
  const cached = overviewCache;
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return NextResponse.json(cached.data);
  }
  if (cached) {
    // 有旧缓存但已过期：立即返回旧数据，后台单飞刷新
    if (!overviewRefreshing) {
      overviewRefreshing = true;
      computeGlobalOverview()
        .then((data) => {
          const entry = { data, ts: Date.now() };
          overviewCache = entry;
          saveDiskCache("global-overview", entry);
        })
        .catch((err: any) => console.error("global-overview background refresh failed:", err?.message || err))
        .finally(() => {
          overviewRefreshing = false;
        });
    }
    return NextResponse.json(cached.data);
  }
  // 无缓存（冷启动）同步计算一次
  try {
    const data = await computeGlobalOverview();
    const entry = { data, ts: Date.now() };
    overviewCache = entry;
    saveDiskCache("global-overview", entry);
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
