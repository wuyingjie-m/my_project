"use client";

import { useCallback, useEffect, useState, Suspense, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useI18n } from "@/lib/i18n";

interface AgentInfo {
  id: string;
  instanceId?: string;
  instanceName?: string;
  name: string;
  emoji: string;
}

interface AgentGroup {
  id: string;
  name: string;
  agents: AgentInfo[];
}

interface DailyReportData {
  agentId: string;
  instanceId: string;
  date: string;
  hasActivity: boolean;
  report: string;
  model: string;
  error: string;
  stats: { sessions: number; tasks: number; toolCalls: number; cronRuns: number; cronJobs: number; toolErrors: number };
  fallbackTasks: string[];
  cronRuns: { name: string; status: string; summary: string }[];
  generatedAt: number;
}

function fetchAgentGroups(): Promise<AgentGroup[]> {
  return fetch("/api/config")
    .then((r) => r.json())
    .then((data) => {
      const instances = Array.isArray(data.instances) ? data.instances : [];
      return instances
        .map((inst: any) => ({
          id: inst.id,
          name: inst.name || inst.id,
          agents: (inst.agents || []).map((a: any) => ({
            ...a,
            instanceId: inst.id,
            instanceName: inst.name || inst.id,
          })),
        }))
        .filter((g: AgentGroup) => g.agents.length > 0);
    });
}

function formatIsoDateCn(iso: string): string {
  const parsed = Date.parse(`${iso}T00:00:00+08:00`);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
}

/* ── 轻量 Markdown 渲染：支持 ## 标题 / - 列表 / **加粗** / `代码` ── */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={`${keyPrefix}-${i}`}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={`${keyPrefix}-${i}`} className="px-1 py-0.5 rounded bg-[var(--bg)] text-xs font-mono">{part.slice(1, -1)}</code>;
    }
    return <span key={`${keyPrefix}-${i}`}>{part}</span>;
  });
}

function SimpleMarkdown({ text }: { text: string }) {
  const nodes: ReactNode[] = [];
  let listItems: string[] = [];

  const flushList = () => {
    if (listItems.length === 0) return;
    nodes.push(
      <ul key={`ul-${nodes.length}`} className="list-disc pl-5 space-y-1.5 my-2">
        {listItems.map((li, i) => (
          <li key={i}>{renderInline(li, `li-${nodes.length}-${i}`)}</li>
        ))}
      </ul>,
    );
    listItems = [];
  };

  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (/^#{1,4}\s/.test(line)) {
      flushList();
      nodes.push(
        <h3 key={`h-${nodes.length}`} className="text-base font-semibold mt-4 mb-2 text-[var(--accent)]">
          {renderInline(line.replace(/^#{1,4}\s/, ""), `h-${nodes.length}`)}
        </h3>,
      );
    } else if (/^[-*•]\s+/.test(line)) {
      listItems.push(line.replace(/^[-*•]\s+/, ""));
    } else if (/^\d+[.、]\s+/.test(line)) {
      listItems.push(line.replace(/^\d+[.、]\s+/, ""));
    } else if (!line.trim()) {
      flushList();
    } else {
      flushList();
      nodes.push(<p key={`p-${nodes.length}`} className="my-1.5 leading-relaxed">{renderInline(line, `p-${nodes.length}`)}</p>);
    }
  }
  flushList();
  return <div className="text-sm text-[var(--text)]">{nodes}</div>;
}

/* ── 机器人卡片墙（按实例分组） ── */
function AgentDailyPicker() {
  const [groups, setGroups] = useState<AgentGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { t } = useI18n();

  useEffect(() => {
    fetchAgentGroups()
      .then(setGroups)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-[var(--text-muted)]">{t("common.loading")}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-red-400">{t("common.loadError")}: {error}</p>
      </div>
    );
  }

  const total = groups.reduce((sum, g) => sum + g.agents.length, 0);

  return (
    <main className="min-h-screen p-4 md:p-8 max-w-6xl mx-auto">
      <div className="flex flex-col gap-3 mb-6 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold">📄 {t("nav.agentDaily")}</h1>
          <p className="text-[var(--text-muted)] text-sm mt-1">
            {t("agentDaily.selectAgent")} · {total} 🤖
          </p>
        </div>
        <Link
          href="/"
          className="px-4 py-2 rounded-lg bg-[var(--card)] border border-[var(--border)] text-sm hover:border-[var(--accent)] transition self-start md:self-auto"
        >
          {t("common.backHome")}
        </Link>
      </div>

      {groups.map((group) => (
        <div key={group.id} className="mb-8">
          <div className="flex items-center gap-2 mb-3">
            <h2 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
              {t("agentDaily.groupLabel")} · {group.name}
            </h2>
            <span className="text-xs text-[var(--text-muted)] opacity-70">{group.agents.length}</span>
            <div className="flex-1 h-px bg-[var(--border)]" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {group.agents.map((agent) => (
              <Link
                key={`${group.id}:${agent.id}`}
                href={`/agent-daily?agent=${encodeURIComponent(agent.id)}&instanceId=${encodeURIComponent(agent.instanceId || "default")}`}
                className="p-5 rounded-xl border border-[var(--border)] bg-[var(--card)] hover:border-[var(--accent)] transition cursor-pointer block"
              >
                <div className="flex items-center gap-3 mb-3">
                  <span className="text-3xl">{agent.emoji}</span>
                  <div className="min-w-0">
                    <h3 className="text-lg font-semibold text-[var(--text)] truncate">{agent.name}</h3>
                    {agent.name !== agent.id && (
                      <span className="text-xs text-[var(--text-muted)]">{agent.id}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[var(--text-muted)]">📝 {t("agentDaily.yesterday")}</span>
                  <span className="text-[var(--accent)]">→</span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </main>
  );
}

/* ── 单个机器人昨日日报（真实数据） ── */
function DailyReportView({ agentId, instanceId }: { agentId: string; instanceId: string }) {
  const { t } = useI18n();
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [data, setData] = useState<DailyReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    fetchAgentGroups()
      .then((groups: AgentGroup[]) => {
        const all = groups.flatMap((g) => g.agents);
        setAgent(
          all.find((a) => a.id === agentId && (a.instanceId || "default") === instanceId) ||
            all.find((a) => a.id === agentId) ||
            null,
        );
      })
      .catch(() => {});
  }, [agentId, instanceId]);

  const load = useCallback(
    (refresh: boolean) => {
      setLoading(true);
      setFetchError(null);
      fetch(
        `/api/agent-daily?agentId=${encodeURIComponent(agentId)}&instanceId=${encodeURIComponent(instanceId)}${refresh ? "&refresh=1" : ""}`,
      )
        .then((r) => r.json())
        .then((d: DailyReportData) => setData(d))
        .catch((e) => setFetchError(e.message))
        .finally(() => setLoading(false));
    },
    [agentId, instanceId],
  );

  useEffect(() => {
    load(false);
  }, [load]);

  const stats = data?.stats;
  const statChips = stats
    ? [
        { label: t("agentDaily.statsSessions"), value: stats.sessions, icon: "💬" },
        { label: t("agentDaily.statsTasks"), value: stats.tasks, icon: "📥" },
        { label: t("agentDaily.statsTools"), value: stats.toolCalls, icon: "🔧" },
        { label: t("agentDaily.statsCron"), value: stats.cronJobs ?? stats.cronRuns ?? 0, icon: "⏰" },
      ]
    : [];

  return (
    <main className="min-h-screen p-4 md:p-8 max-w-4xl mx-auto">
      <div className="flex flex-col gap-3 mb-6 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-4xl">{agent?.emoji || "🤖"}</span>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold truncate">
              {agent?.name || agentId} · {t("agentDaily.yesterday")}
            </h1>
            <div className="flex items-center gap-2 mt-1 text-xs text-[var(--text-muted)]">
              <code>{agentId}</code>
              <span className="px-2 py-0.5 rounded-full bg-[var(--bg)] border border-[var(--border)]">
                {agent?.instanceName || instanceId}
              </span>
            </div>
          </div>
        </div>
        <Link
          href="/agent-daily"
          className="px-4 py-2 rounded-lg bg-[var(--card)] border border-[var(--border)] text-sm hover:border-[var(--accent)] transition self-start md:self-auto"
        >
          {t("agentDaily.backToAgents")}
        </Link>
      </div>

      {/* 报告日期 */}
      {data?.date && (
        <div className="p-4 rounded-xl border border-[var(--border)] bg-[var(--card)] mb-6 flex items-center gap-2 text-sm">
          <span>📅</span>
          <span className="text-[var(--text-muted)]">{t("agentDaily.reportDate")}:</span>
          <span className="font-medium">{formatIsoDateCn(data.date)}</span>
        </div>
      )}

      {loading ? (
        <div className="rounded-xl border-2 border-dashed border-[var(--border)] bg-[var(--card)] p-10 flex flex-col items-center justify-center text-center">
          <span className="text-4xl mb-3 animate-pulse">📝</span>
          <div className="text-sm text-[var(--text-muted)]">{t("agentDaily.loadingReport")}</div>
          <div className="w-full max-w-md mt-6 space-y-2.5" aria-hidden>
            <div className="h-3 rounded bg-[var(--bg)] w-full animate-pulse" />
            <div className="h-3 rounded bg-[var(--bg)] w-11/12 animate-pulse" />
            <div className="h-3 rounded bg-[var(--bg)] w-full animate-pulse" />
            <div className="h-3 rounded bg-[var(--bg)] w-4/5 animate-pulse" />
          </div>
        </div>
      ) : fetchError ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-center">
          <p className="text-red-300 text-sm mb-3">{t("common.loadError")}: {fetchError}</p>
          <button
            onClick={() => load(false)}
            className="px-4 py-1.5 rounded-lg text-xs font-medium border border-[var(--border)] bg-[var(--bg)] hover:border-[var(--accent)] transition"
          >
            {t("agentDaily.retry")}
          </button>
        </div>
      ) : data && !data.hasActivity ? (
        <div className="rounded-xl border-2 border-dashed border-[var(--border)] bg-[var(--card)] p-10 flex flex-col items-center justify-center text-center">
          <span className="text-4xl mb-3">🌙</span>
          <p className="text-sm text-[var(--text-muted)]">{t("agentDaily.noActivity")}</p>
        </div>
      ) : data ? (
        <>
          {/* 活动统计 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            {statChips.map((chip) => (
              <div key={chip.label} className="p-3 rounded-xl border border-[var(--border)] bg-[var(--card)] text-center">
                <div className="text-lg font-bold text-[var(--text)]">{chip.icon} {chip.value}</div>
                <div className="text-[10px] text-[var(--text-muted)] mt-0.5">{chip.label}</div>
              </div>
            ))}
          </div>

          {data.report ? (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-5 md:p-6 mb-4">
              <SimpleMarkdown text={data.report} />
            </div>
          ) : null}

          {data.error ? (
            <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-4 mb-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="text-yellow-300 text-xs">
                  ⚠️ {t("agentDaily.generateFailed")}: {data.error}
                </p>
                <button
                  onClick={() => load(true)}
                  className="px-3 py-1 rounded-lg text-xs font-medium border border-[var(--border)] bg-[var(--bg)] hover:border-[var(--accent)] transition"
                >
                  {t("agentDaily.retry")}
                </button>
              </div>
              {data.fallbackTasks.length > 0 && (
                <div className="mt-3 pt-3 border-t border-yellow-500/20">
                  <div className="text-xs font-semibold text-[var(--text-muted)] mb-1.5">{t("agentDaily.taskFallback")}</div>
                  <ol className="list-decimal pl-5 space-y-1 text-xs text-[var(--text-muted)]">
                    {data.fallbackTasks.map((task, i) => (
                      <li key={i}>{task}</li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          ) : null}

          <p className="text-[10px] text-[var(--text-muted)] opacity-60 text-center">
            🤖 {t("agentDaily.aiNote")}
            {data.model ? ` · ${data.model}` : ""}
          </p>
        </>
      ) : null}
    </main>
  );
}

/* ── 页面入口 ── */
function AgentDailyPageInner() {
  const searchParams = useSearchParams();
  const agentId = searchParams.get("agent") || "";
  const instanceId = searchParams.get("instanceId") || "default";

  if (!agentId) return <AgentDailyPicker />;
  return <DailyReportView agentId={agentId} instanceId={instanceId} />;
}

export default function AgentDailyPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><p className="text-[var(--text-muted)]">Loading...</p></div>}>
      <AgentDailyPageInner />
    </Suspense>
  );
}
