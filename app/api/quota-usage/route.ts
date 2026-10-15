import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { loadDiskCache, saveDiskCache } from "@/lib/disk-cache";
import { getSqliteDailyStats } from "@/lib/sqlite-stats";
import { readAgentKeyInfos, usageSince, quotaWeekStart, nextResetIso } from "@/lib/key-pools";
import type { AgentKeyInfo } from "@/lib/key-pools";

// 60s SWR（比排行榜慢一档：5h 窗口查询较重）
let cache: { data: any; ts: number } | null = loadDiskCache<any>("quota-usage");
let refreshing = false;
const TTL = 60_000;

type QuotaConfig = {
  weeklyTokens: number;
  fiveHourTokens?: number;
  fiveHourAnchor?: string;
  resetDow: number;
  resetTime: string;
  resetsAtOverride?: string;
  excludeInstances?: string[];
  planLabels?: Record<string, string>;
  perKeySplit?: string[];
  keyQuotas?: Record<string, { weeklyTokens: number; fiveHourTokens?: number }>;
  keyOwners?: Record<string, string>;
  fiveHourRatio: number;
  timezoneOffsetHours: number;
};
const DEFAULTS: QuotaConfig = {
  weeklyTokens: 1_350_000_000,
  fiveHourTokens: 285_000_000,
  fiveHourAnchor: "2026-10-08T09:46:00+08:00",
  resetDow: 2,
  resetTime: "20:06",
  excludeInstances: ["openclaw_sxs", "openclaw_need", "openclaw_XMT"],
  planLabels: { default: "TeamS+GTM", openclaw_TeamS: "TeamS+GTM", openclaw_GTM: "TeamS+GTM", openclaw_GYL: "GYL", openclaw_PJT: "PJT", openclaw_QD: "QD" },
  fiveHourRatio: 0.227,
  timezoneOffsetHours: 8,
};

function readConfig(): QuotaConfig {
  try {
    const p = path.join(process.cwd(), "quota-config.json");
    if (fs.existsSync(p)) return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(p, "utf-8")) };
  } catch {}
  return DEFAULTS;
}

// 额度统计范围：排除低用量/共用 key 的实例（sxs/need/XMT 用别家 key，不占独立套餐）
function inScope(infos: AgentKeyInfo[], cfg: QuotaConfig): AgentKeyInfo[] {
  const excluded = new Set(cfg.excludeInstances || []);
  return infos.filter((a) => !excluded.has(a.instanceId));
}

async function computeQuotaUsage() {
  const cfg = readConfig();
  const now = new Date();
  const fiveHourTokens = Number(cfg.fiveHourTokens) || Math.round(cfg.weeklyTokens * cfg.fiveHourRatio);
  const excluded = new Set(cfg.excludeInstances || []);

  // 周窗口：有 resetsAtOverride 时按「override - 7 天」取窗口起始日期；否则按周日 reset 规则推算
  let weekStart: string;
  let resetsAt: string;
  if (cfg.resetsAtOverride) {
    const t = new Date(cfg.resetsAtOverride).getTime();
    resetsAt = cfg.resetsAtOverride;
    weekStart = new Date(t - 7 * 86400_000).toISOString().slice(0, 10);
  } else {
    weekStart = quotaWeekStart(now, cfg.resetDow, cfg.resetTime, cfg.timezoneOffsetHours);
    resetsAt = nextResetIso(now, cfg.resetDow, cfg.resetTime, cfg.timezoneOffsetHours);
  }

  // 5h 额度为固定锚点重置（每 5 小时一窗，非任意滚动窗口）：最近锚点 2026-09-30 14:06（用户实测）
  const FIVE_H_MS = 5 * 3600_000;
  const anchor5hMs = cfg.fiveHourAnchor ? new Date(cfg.fiveHourAnchor).getTime() : now.getTime() - FIVE_H_MS;
  const windowsSinceAnchor = Math.floor((now.getTime() - anchor5hMs) / FIVE_H_MS);
  const window5hStartMs = anchor5hMs + windowsSinceAnchor * FIVE_H_MS;
  const since5h = window5hStartMs;
  const infos = inScope(readAgentKeyInfos(), cfg);

  // ===== 按 apikey 隔离计量（2026-10-13）：每把 key 独立套餐、独立池 =====
  // 用量按「时间 × key」归属：切换日志 .data/key-log.json 记录实例何时起用哪把 key；
  // 周粒度按天归属（当天结束时刻在用哪把就算哪把的账），5h 粒度按秒级区间重叠切分。
  type KeyLogEntry = { ts: number; instanceId: string; keyTail: string };
  const readKeyLog = (): KeyLogEntry[] => {
    try {
      const lp = path.join(process.cwd(), ".data", "key-log.json");
      if (!fs.existsSync(lp)) return [];
      const arr = JSON.parse(fs.readFileSync(lp, "utf-8"));
      return Array.isArray(arr) ? arr.filter((e: any) => e && e.instanceId && e.keyTail) : [];
    } catch { return []; }
  };
  const intervalsByInstance = new Map<string, Array<{ from: number; to: number; keyTail: string }>>();
  const byInst = new Map<string, KeyLogEntry[]>();
  for (const e of readKeyLog()) {
    if (!byInst.has(e.instanceId)) byInst.set(e.instanceId, []);
    byInst.get(e.instanceId)!.push(e);
  }
  for (const [inst, entries] of byInst) {
    entries.sort((a, b) => a.ts - b.ts);
    const ivals: Array<{ from: number; to: number; keyTail: string }> = [];
    for (const e of entries) {
      const last = ivals[ivals.length - 1];
      if (last && last.keyTail === e.keyTail) continue;
      if (last) last.to = e.ts || last.to;
      ivals.push({ from: e.ts || 0, to: Infinity, keyTail: e.keyTail });
    }
    intervalsByInstance.set(inst, ivals);
  }
  // 每 key 涉及的实例（含历史持有），用于归账范围
  const instsForKey = new Map<string, Set<string>>();
  for (const [inst, ivals] of intervalsByInstance) {
    for (const iv of ivals) {
      if (!instsForKey.has(iv.keyTail)) instsForKey.set(iv.keyTail, new Set());
      instsForKey.get(iv.keyTail)!.add(inst);
    }
  }
  const dayEndMs = (date: string) => Date.parse(`${date}T23:59:59.999+08:00`);

  const pools = Object.keys(cfg.keyQuotas || {}).map((tail) => {
    const kq = (cfg.keyQuotas || {})[tail];
    const poolWeeklyQuota = Number(kq?.weeklyTokens) || cfg.weeklyTokens;
    const pool5hQuota = Number(kq?.fiveHourTokens) || fiveHourTokens;
    const owner = (cfg.keyOwners || {})[tail] || tail;
    const members = infos.filter((a) => a.keyTail === tail);
    const relAgents = infos.filter((a) => instsForKey.get(tail)?.has(a.instanceId));
    const usage5h = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const weekly = { inputTokens: 0, outputTokens: 0, totalTokens: 0, messageCount: 0 };
    for (const m of relAgents) {
      const ivals = intervalsByInstance.get(m.instanceId) || [];
      // 5h：该 key 持有区间与当前 5h 窗口的重叠，按秒级切分归账
      for (const iv of ivals) {
        if (iv.keyTail !== tail) continue;
        const os = Math.max(iv.from, window5hStartMs);
        const oe = Math.min(iv.to, now.getTime());
        if (oe <= os) continue;
        const u = usageSince(m.homeDir, m.agentId, os, oe);
        usage5h.inputTokens += u.inputTokens;
        usage5h.outputTokens += u.outputTokens;
        usage5h.totalTokens += u.totalTokens;
      }
      // 周：按天归属——当天结束时刻仍持有该实例的 key 认领该天
      const daily = getSqliteDailyStats(m.homeDir, m.agentId);
      if (daily) {
        for (const d of daily) {
          if (d.date < weekStart) continue;
          const de = dayEndMs(d.date);
          if (!ivals.some((iv) => iv.keyTail === tail && iv.from <= de && iv.to >= de)) continue;
          weekly.inputTokens += d.inputTokens;
          weekly.outputTokens += d.outputTokens;
          weekly.totalTokens += d.totalTokens;
          weekly.messageCount += d.messageCount;
        }
      }
    }
    const pct = (used: number, quota: number) => Math.min(100, Math.round((used / quota) * 1000) / 10);
    return {
      label: `${owner}·${tail}`,
      keyTail: tail,
      owner,
      keyTails: [tail],
      members: members.map((m) => ({ instanceId: m.instanceId, instanceName: m.instanceName, agentId: m.agentId, name: m.name, source: m.source })),
      usage5h,
      weekly,
      weeklyQuota: poolWeeklyQuota,
      fiveHourQuota: pool5hQuota,
      weeklyRemaining: Math.max(0, poolWeeklyQuota - weekly.totalTokens),
      fiveHourRemaining: Math.max(0, pool5hQuota - usage5h.totalTokens),
      pct5h: pct(usage5h.totalTokens, pool5hQuota),
      pctWeek: pct(weekly.totalTokens, poolWeeklyQuota),
    };
  }).sort((a, b) => b.weekly.totalTokens - a.weekly.totalTokens);

  return {
    generatedAt: now.toISOString(),
    quota: {
      weeklyTokens: cfg.weeklyTokens,
      fiveHourTokens,
      resetDow: cfg.resetDow,
      resetTime: cfg.resetTime,
      weekStart,
      resetsAt,
      fiveHourWindowStart: new Date(window5hStartMs).toISOString(),
      next5hReset: new Date(window5hStartMs + FIVE_H_MS).toISOString(),
    },
    pools,
  };
}

export async function GET() {
  const cached = cache;
  if (cached && Date.now() - cached.ts < TTL) {
    return NextResponse.json(cached.data);
  }
  if (cached) {
    if (!refreshing) {
      refreshing = true;
      computeQuotaUsage()
        .then((data) => {
          const entry = { data, ts: Date.now() };
          cache = entry;
          saveDiskCache("quota-usage", entry);
        })
        .catch((err: any) => console.error("quota-usage background refresh failed:", err?.message || err))
        .finally(() => { refreshing = false; });
    }
    return NextResponse.json(cached.data);
  }
  try {
    const data = await computeQuotaUsage();
    const entry = { data, ts: Date.now() };
    cache = entry;
    saveDiskCache("quota-usage", entry);
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
