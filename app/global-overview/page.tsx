"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";

interface DayStat {
  date: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  messageCount: number;
  avgResponseMs: number;
}

interface AllStats {
  daily: DayStat[];
  weekly: DayStat[];
  monthly: DayStat[];
}

type TimeRange = "daily" | "weekly" | "monthly" | "total";

type TFunc = (key: string) => string;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function formatMs(ms: number): string {
  if (!ms) return "-";
  if (ms < 1000) return ms + "ms";
  return (ms / 1000).toFixed(1) + "s";
}

function formatTokenCount(n: number): string {
  const v = Number(n || 0);
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
  return String(v);
}

// 趋势折线图（纵轴固定列 + 横向滚动区默认定位最新日期）
function TrendChart({ data, lines, height = 180, t }: { data: DayStat[]; lines: { key: keyof DayStat; color: string; label: string }[]; height?: number; t: TFunc }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastDate = data.length > 0 ? data[data.length - 1].date : "";

  // 默认滚到最右侧展示最新日期；仅在最新日期变化时回正，不干扰手动拖动
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [lastDate]);

  if (data.length === 0) return <div className="flex items-center justify-center h-32 text-[var(--text-muted)] text-sm">{t("common.noData")}</div>;

  const pad = { top: 16, right: 16, bottom: 50, left: 56 };
  const plotW = Math.max(500 - pad.left, data.length * 56) + pad.right;
  const chartW = plotW - pad.right;
  const chartH = height - pad.top - pad.bottom;

  let maxVal = 0;
  for (const d of data) for (const l of lines) { const v = d[l.key] as number; if (v > maxVal) maxVal = v; }
  if (maxVal === 0) maxVal = 1;

  const ticks = Array.from({ length: 5 }, (_, i) => Math.round((maxVal / 4) * i));

  function toX(i: number) { return (i / (data.length - 1 || 1)) * chartW; }
  function toY(v: number) { return pad.top + chartH - (v / maxVal) * chartH; }

  return (
    <div className="flex" style={{ height }}>
      {/* 纵轴固定列（不随横向滚动移动） */}
      <svg width={pad.left} height={height} className="shrink-0 text-[var(--text-muted)]">
        {ticks.map((tick, i) => (
          <text key={i} x={pad.left - 8} y={toY(tick) + 4} textAnchor="end" fontSize={10} fill="currentColor">{formatTokens(tick)}</text>
        ))}
        <line x1={pad.left - 1} y1={pad.top} x2={pad.left - 1} y2={pad.top + chartH} stroke="currentColor" opacity={0.25} />
      </svg>
      {/* 绘图区：横向滚动 */}
      <div ref={scrollRef} className="min-w-0 flex-1 overflow-x-auto">
        <svg width={plotW} height={height} className="block text-[var(--text-muted)]">
          {ticks.map((tick, i) => (
            <line key={i} x1={0} y1={toY(tick)} x2={chartW + pad.right - 8} y2={toY(tick)} stroke="currentColor" opacity={0.12} />
          ))}
          {lines.map((l) => {
            const points = data.map((d, i) => `${toX(i)},${toY(d[l.key] as number)}`).join(" ");
            return <polyline key={l.key} points={points} fill="none" stroke={l.color} strokeWidth={2} opacity={0.85} />;
          })}
          {lines.map((l) => data.map((d, i) => (
            <circle key={`${l.key}-${i}`} cx={toX(i)} cy={toY(d[l.key] as number)} r={3} fill={l.color} opacity={0.9}>
              <title>{`${d.date} ${l.label}: ${formatTokens(d[l.key] as number)}`}</title>
            </circle>
          )))}
          {data.map((d, i) => (
            <text key={i} x={toX(i)} y={height - pad.bottom + 16} textAnchor="middle" fontSize={9} fill="currentColor"
              transform={`rotate(-30, ${toX(i)}, ${height - pad.bottom + 16})`}>{d.date.slice(5)}</text>
          ))}
          <line x1={0} y1={pad.top + chartH} x2={chartW + pad.right - 8} y2={pad.top + chartH} stroke="currentColor" opacity={0.25} />
        </svg>
      </div>
    </div>
  );
}
// 响应时间趋势图（纵轴固定列 + 横向滚动区默认定位最新日期）
function ResponseTrendChart({ data, height = 180, t }: { data: DayStat[]; height?: number; t: TFunc }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const filtered = data.filter(d => d.avgResponseMs > 0);
  const lastDate = filtered.length > 0 ? filtered[filtered.length - 1].date : "";

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [lastDate]);

  if (filtered.length === 0) return <div className="flex items-center justify-center h-32 text-[var(--text-muted)] text-sm">{t("home.noResponseData")}</div>;

  const pad = { top: 16, right: 16, bottom: 50, left: 56 };
  const plotW = Math.max(500 - pad.left, filtered.length * 56) + pad.right;
  const chartW = plotW - pad.right;
  const chartH = height - pad.top - pad.bottom;
  const maxVal = Math.max(...filtered.map(d => d.avgResponseMs));

  const ticks = Array.from({ length: 5 }, (_, i) => Math.round((maxVal / 4) * i));
  function toX(i: number) { return (i / (filtered.length - 1 || 1)) * chartW; }
  function toY(v: number) { return pad.top + chartH - (v / maxVal) * chartH; }

  const points = filtered.map((d, i) => `${toX(i)},${toY(d.avgResponseMs)}`).join(" ");

  return (
    <div className="flex" style={{ height }}>
      <svg width={pad.left} height={height} className="shrink-0 text-[var(--text-muted)]">
        {ticks.map((tick, i) => (
          <text key={i} x={pad.left - 8} y={toY(tick) + 4} textAnchor="end" fontSize={10} fill="currentColor">{formatMs(tick)}</text>
        ))}
        <line x1={pad.left - 1} y1={pad.top} x2={pad.left - 1} y2={pad.top + chartH} stroke="currentColor" opacity={0.25} />
      </svg>
      <div ref={scrollRef} className="min-w-0 flex-1 overflow-x-auto">
        <svg width={plotW} height={height} className="block text-[var(--text-muted)]">
          {ticks.map((tick, i) => (
            <line key={i} x1={0} y1={toY(tick)} x2={chartW + pad.right - 8} y2={toY(tick)} stroke="currentColor" opacity={0.12} />
          ))}
          <polyline points={points} fill="none" stroke="#f59e0b" strokeWidth={2} opacity={0.85} />
          {filtered.map((d, i) => (
            <circle key={i} cx={toX(i)} cy={toY(d.avgResponseMs)} r={3} fill="#f59e0b" opacity={0.9}>
              <title>{`${d.date}: ${formatMs(d.avgResponseMs)}`}</title>
            </circle>
          ))}
          {filtered.map((d, i) => (
            <text key={`l-${i}`} x={toX(i)} y={height - pad.bottom + 16} textAnchor="middle" fontSize={9} fill="currentColor"
              transform={`rotate(-30, ${toX(i)}, ${height - pad.bottom + 16})`}>{d.date.slice(5)}</text>
          ))}
          <line x1={0} y1={pad.top + chartH} x2={chartW + pad.right - 8} y2={pad.top + chartH} stroke="currentColor" opacity={0.25} />
        </svg>
      </div>
    </div>
  );
}
interface OverviewAgent {
  instanceId: string;
  instanceName: string;
  agentId: string;
  name: string;
  emoji: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  messageCount: number;
}

interface OverviewData {
  generatedAt: string;
  weekStart: string;
  totals: { inputTokens: number; outputTokens: number; totalTokens: number; messageCount: number };
  agents: OverviewAgent[];
}

interface QuotaData {
  quota: { weeklyTokens: number; fiveHourTokens: number; resetTime: string; weekStart: string; resetsAt: string; fiveHourWindowStart: string; next5hReset: string };
  pools: Array<{
    label: string;
    keyTails: string[];
    members: Array<{ instanceId: string; instanceName: string; agentId: string; name: string; source: string }>;
    usage5h: { totalTokens: number };
    weekly: { totalTokens: number };
    pct5h: number;
    pctWeek: number;
    weeklyQuota: number;
    fiveHourQuota: number;
  }>;
}

export default function GlobalOverviewPage() {
  const { t } = useI18n();
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [allStats, setAllStats] = useState<AllStats | null>(null);
  const [statsRange, setStatsRange] = useState<TimeRange>("daily");
  const [instanceFilter, setInstanceFilter] = useState<string | null>(null);
  const [quota, setQuota] = useState<QuotaData | null>(null);

  const RANGE_LABELS: Record<TimeRange, string> = { daily: t("range.daily"), weekly: t("range.weekly"), monthly: t("range.monthly"), total: t("range.total") };

  // 用量排行轮询 (30秒)
  useEffect(() => {
    const fetchOverview = () => {
      fetch("/api/global-overview", { cache: "no-store" })
        .then(r => r.json())
        .then(d => {
          if (d && d.agents) setOverview(d);
        })
        .catch(() => {});
    };
    fetchOverview();
    const timer = setInterval(fetchOverview, 30000);
    return () => clearInterval(timer);
  }, []);

  // 趋势统计轮询 (60秒)
  useEffect(() => {
    const fetchStats = () => {
      fetch("/api/stats-all", { cache: "no-store" })
        .then(r => r.json())
        .then(d => {
          if (d && d.daily) setAllStats(d);
        })
        .catch(() => {});
    };
    fetchStats();
    const timer = setInterval(fetchStats, 60000);
    return () => clearInterval(timer);
  }, []);

  // 实例筛选：null = 全局；筛选时总消耗卡与排行榜联动
  const allAgents = overview?.agents ?? [];
  const instanceOptions = Array.from(new Set(allAgents.map((a) => a.instanceId)));
  const filteredAgents = allAgents.filter((a) => !instanceFilter || a.instanceId === instanceFilter);
  const filteredTotals = filteredAgents.reduce(
    (acc, a) => ({
      inputTokens: acc.inputTokens + a.inputTokens,
      outputTokens: acc.outputTokens + a.outputTokens,
      totalTokens: acc.totalTokens + a.totalTokens,
      messageCount: acc.messageCount + a.messageCount,
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, messageCount: 0 },
  );

  // 额度水位轮询 (60秒)
  useEffect(() => {
    const fetchQuota = () => {
      fetch("/api/quota-usage", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => { if (d && d.pools) setQuota(d); })
        .catch(() => {});
    };
    fetchQuota();
    const timer = setInterval(fetchQuota, 60000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="p-3 md:p-4 max-w-6xl mx-auto">
      {/* 头部 */}
      <div className="mb-4">
        <h1 className="text-xl font-bold flex items-center gap-2">🌐 {t("home.globalOverview")}</h1>
        {overview?.weekStart && (
          <p className="text-[var(--text-muted)] text-xs mt-0.5">{t("home.weekOf")} {overview.weekStart}</p>
        )}
      </div>

      {/* 消耗总token + 用量排行榜 */}
      <section className="rounded-xl border border-[var(--border)] bg-[var(--card)]/50 p-3 md:p-4">
        <div className="flex flex-col gap-3 md:flex-row">
          <div className="shrink-0 rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 md:w-60">
            <div className="text-xs text-[var(--text-muted)]">
              {instanceFilter ? `${t("home.weeklyTotalTokens")} · ${instanceFilter.replace("openclaw_", "")}` : t("home.weeklyTotalTokens")}
            </div>
            <div className="mt-1 text-2xl font-bold text-[var(--text)]">{formatTokenCount(filteredTotals.totalTokens)}</div>
            <div className="mt-1 text-[11px] text-[var(--text-muted)]">
              ↑ {formatTokenCount(filteredTotals.inputTokens)} · ↓ {formatTokenCount(filteredTotals.outputTokens)}
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="text-xs text-[var(--text-muted)]">{t("home.agentTokenRanking")}</span>
              <div className="flex flex-wrap items-center gap-1">
                <button type="button" onClick={() => setInstanceFilter(null)}
                  className={`rounded-full px-2 py-0.5 text-[10px] transition ${instanceFilter === null ? "bg-[var(--accent)] font-medium text-[var(--bg)]" : "border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]"}`}>{t("home.allInstances")}</button>
                {instanceOptions.map((id) => (
                  <button key={id} type="button" onClick={() => setInstanceFilter(instanceFilter === id ? null : id)}
                    className={`rounded-full px-2 py-0.5 text-[10px] transition ${instanceFilter === id ? "bg-[var(--accent)] font-medium text-[var(--bg)]" : "border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]"}`}>{id.replace("openclaw_", "")}</button>
                ))}
              </div>
            </div>
            <div className="max-h-72 divide-y divide-[var(--border)] overflow-y-auto rounded-lg border border-[var(--border)]">
              {filteredAgents.filter((a) => a.totalTokens > 0).map((a, i) => (
                <div key={`${a.instanceId}:${a.agentId}`} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                  <span className={`w-5 shrink-0 text-center font-mono ${i === 0 ? "text-amber-400" : i === 1 ? "text-slate-300" : i === 2 ? "text-orange-400" : "text-[var(--text-muted)]"}`}>{i + 1}</span>
                  <span className="shrink-0">{a.emoji}</span>
                  <span className="truncate text-[var(--text)]">{a.name}</span>
                  {!instanceFilter && <span className="shrink-0 text-[10px] text-[var(--text-muted)]">{a.instanceName}</span>}
                  <span className="ml-auto shrink-0 font-mono text-[var(--text)]">{formatTokenCount(a.totalTokens)}</span>
                </div>
              ))}
              {(!overview || filteredAgents.filter((a) => a.totalTokens > 0).length === 0) && (
                <div className="px-3 py-4 text-center text-xs text-[var(--text-muted)]">{t("home.noTokenData")}</div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* 套餐额度水位 */}
      {quota && (
        <section className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--card)]/50 p-3 md:p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-[var(--text)]">🌐 {t("home.quotaPanel")}</h2>
            <span className="text-[10px] text-[var(--text-muted)]">{t("home.quotaReset")}: {new Date(new Date(quota.quota.resetsAt).getTime() + 8 * 3600_000).toISOString().slice(5, 16).replace("T", " ")}</span>
          </div>
          <div className="space-y-3">
            {quota.pools.map((p) => {
              const colorCls = (pct: number) => (pct >= 85 ? "bg-red-500" : pct >= 60 ? "bg-amber-400" : "bg-emerald-500");
              const statusKey = (pct: number) => (pct >= 85 ? t("home.quotaCritical") : pct >= 60 ? t("home.quotaWarn") : t("home.quotaHealthy"));
              return (
                <div key={p.label} className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3">
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-mono font-semibold text-[var(--text)]">{p.label}</span>
                  </div>
                  {[{ label: t("home.quota5h"), extra: `→ ${t("home.quotaReset")} ${new Date(new Date(quota.quota.next5hReset).getTime() + 8 * 3600_000).toISOString().slice(11, 16)}`, pct: p.pct5h, used: p.usage5h.totalTokens, quota: p.fiveHourQuota },
                    { label: t("home.quotaWeek"), extra: "", pct: p.pctWeek, used: p.weekly.totalTokens, quota: p.weeklyQuota }].map((row: { label: string; extra?: string; pct: number; used: number; quota: number }) => (
                    <div key={row.label} className="mb-1.5">
                      <div className="mb-0.5 flex items-center justify-between text-[10px] text-[var(--text-muted)]">
                        <span>{row.label} {row.extra} · {statusKey(row.pct)}</span>
                        <span className="font-mono">{formatTokenCount(row.used)} / {formatTokenCount(row.quota)} ({row.pct}% · 余 {formatTokenCount(Math.max(0, row.quota - row.used))})</span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--border)]">
                        <div className={`h-full rounded-full ${colorCls(row.pct)}`} style={{ width: `${Math.max(2, row.pct)}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* 全局趋势统计 */}
      {allStats && (
        <div className="mt-4 p-5 rounded-xl border border-[var(--border)] bg-[var(--card)]">
          <div className="flex flex-col gap-2 mb-4 md:flex-row md:items-center md:justify-between">
            <h2 className="text-sm font-semibold text-[var(--text)]">{t("home.globalTrend")}</h2>
            <div className="flex rounded-lg border border-[var(--border)] overflow-hidden">
              {(Object.keys(RANGE_LABELS) as TimeRange[]).map((r) => (
                <button key={r} onClick={() => setStatsRange(r)}
                  className={`px-3 py-1 text-xs transition ${statsRange === r ? "bg-[var(--accent)] text-[var(--bg)] font-medium" : "bg-[var(--bg)] text-[var(--text-muted)] hover:text-[var(--text)]"}`}
                >{RANGE_LABELS[r]}</button>
              ))}
            </div>
          </div>
          {(() => {
            const currentData = statsRange === "total" ? allStats.monthly : allStats[statsRange];
            let totalInput: number, totalOutput: number, totalMsgs: number;
            if (statsRange === "total") {
              const allDaily = allStats.daily;
              totalInput = allDaily.reduce((s, d) => s + d.inputTokens, 0);
              totalOutput = allDaily.reduce((s, d) => s + d.outputTokens, 0);
              totalMsgs = allDaily.reduce((s, d) => s + d.messageCount, 0);
            } else {
              const now = new Date();
              const getCurrentPeriodKey = () => {
                if (statsRange === "daily") return now.toISOString().slice(0, 10);
                if (statsRange === "weekly") {
                  const day = now.getUTCDay();
                  const mondayOffset = day === 0 ? -6 : 1 - day;
                  const monday = new Date(now.getTime() + mondayOffset * 86400000);
                  return monday.toISOString().slice(0, 10);
                }
                return now.toISOString().slice(0, 7);
              };
              const periodKey = getCurrentPeriodKey();
              const latestEntry = currentData.length > 0 ? currentData[currentData.length - 1] : null;
              const currentEntry = latestEntry?.date === periodKey ? latestEntry : null;
              totalInput = currentEntry?.inputTokens ?? 0;
              totalOutput = currentEntry?.outputTokens ?? 0;
              totalMsgs = currentEntry?.messageCount ?? 0;
            }
            return (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
                  <div className="p-3 rounded-lg bg-[var(--bg)] border border-[var(--border)]">
                    <div className="text-[10px] text-[var(--text-muted)]">{t("home.totalInputToken")}</div>
                    <div className="text-lg font-bold text-blue-400">{formatTokens(totalInput)}</div>
                  </div>
                  <div className="p-3 rounded-lg bg-[var(--bg)] border border-[var(--border)]">
                    <div className="text-[10px] text-[var(--text-muted)]">{t("home.totalOutputToken")}</div>
                    <div className="text-lg font-bold text-emerald-400">{formatTokens(totalOutput)}</div>
                  </div>
                  <div className="p-3 rounded-lg bg-[var(--bg)] border border-[var(--border)]">
                    <div className="text-[10px] text-[var(--text-muted)]">{t("home.totalMessages")}</div>
                    <div className="text-lg font-bold text-purple-400">{totalMsgs}</div>
                  </div>
                </div>
                <div className="mb-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-[var(--text-muted)]">{t("home.tokenTrend")}</span>
                    <div className="flex items-center gap-3 text-[10px]">
                      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500 inline-block" /> Input</span>
                      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" /> Output</span>
                    </div>
                  </div>
                  <TrendChart data={currentData} lines={[
                    { key: "inputTokens", color: "#3b82f6", label: "Input" },
                    { key: "outputTokens", color: "#10b981", label: "Output" },
                  ]} t={t} />
                </div>
                {statsRange === "daily" && (
                  <div>
                    <span className="text-xs text-[var(--text-muted)]">{t("home.avgResponseTrend")}</span>
                    <ResponseTrendChart data={currentData} t={t} />
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}
