"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useI18n } from "@/lib/i18n";
import { GatewayStatus } from "./gateway-status";
import {
  AgentCard,
  ModelBadge,
  type AgentModelOptionGroup,
  type PlatformTestResult,
  type AgentModelTestResult,
  type AgentSessionTestResult,
} from "./components/agent-card";

interface Platform {
  name: string;
  accountId?: string;
  appId?: string;
  botOpenId?: string;
  botUserId?: string;
}

interface Agent {
  id: string;
  instanceId?: string;
  name: string;
  emoji: string;
  model: string;
  platforms: Platform[];
  session?: {
    lastActive: number | null;
    totalTokens: number;
    contextTokens: number;
    sessionCount: number;
    todayAvgResponseMs: number;
    messageCount: number;
    weeklyResponseMs: number[];
    weeklyTokens: number[];
  };
}

interface GroupChat {
  groupId: string;
  channel: string;
  agents: { id: string; emoji: string; name: string }[];
}

interface ConfigData {
  agents: Agent[];
  instances?: Array<{
    id: string;
    name: string;
    gatewayPort?: number;
    gatewayToken?: string;
    gatewayHost?: string;
    agents: Array<{ id: string; name?: string; emoji?: string; model?: string; platforms?: Platform[]; session?: Agent["session"] }>;
  }>;
  defaults: { model: string; fallbacks: string[] };
  providers?: Array<{
    id: string;
    accessMode?: "auth" | "api_key";
    models?: Array<{ id: string; name?: string }>;
  }>;
  gateway?: { port: number; token?: string; host?: string };
  groupChats?: GroupChat[];
}




function agentResultKey(instanceId: string | undefined, agentId: string): string {
  return `${instanceId || "default"}:${agentId}`;
}

function agentPlatformResultKey(instanceId: string | undefined, agentId: string, platform: string): string {
  return `${agentResultKey(instanceId, agentId)}:${platform}`;
}

function getAgentTargets(data: ConfigData | null): Array<{ instanceId: string; agent: Agent }> {
  if (!data) return [];
  if (!data.instances?.length) return data.agents.map((agent) => ({ instanceId: "default", agent }));
  const agentById = new Map(data.agents.map((agent) => [agent.id, agent]));
  return data.instances.flatMap((instance) => (
    instance.agents.map((summary) => {
      const base = agentById.get(summary.id);
      return {
        instanceId: instance.id,
        agent: {
          id: summary.id,
          instanceId: instance.id,
          name: summary.name || summary.id,
          emoji: summary.emoji || "🤖",
          model: summary.model || base?.model || data.defaults.model,
          platforms: summary.platforms || base?.platforms || [],
          session: summary.session || base?.session,
        },
      };
    })
  ));
}

function scopedDmSessionResults(
  results: Record<string, PlatformTestResult | null> | null,
  instanceId: string,
  agentId: string,
): Record<string, PlatformTestResult | null> | undefined {
  if (!results) return undefined;
  const scoped: Record<string, PlatformTestResult | null> = {};
  const prefix = `${agentResultKey(instanceId, agentId)}:`;
  for (const [key, value] of Object.entries(results)) {
    if (key.startsWith(prefix)) {
      scoped[key.slice(prefix.length)] = value;
    }
  }
  return scoped;
}

function scopedPlatformTestResults(
  results: Record<string, PlatformTestResult | null> | null,
  instanceId: string,
  agentId: string,
): Record<string, PlatformTestResult | null> | undefined {
  if (!results) return undefined;
  const scoped: Record<string, PlatformTestResult | null> = {};
  const prefix = `${agentResultKey(instanceId, agentId)}:`;
  for (const [key, value] of Object.entries(results)) {
    if (key.startsWith(prefix)) scoped[key.slice(prefix.length)] = value;
  }
  return scoped;
}

let cachedHomeData: ConfigData | null = null;
let cachedHomeError: string | null = null;
let cachedHomeLastUpdated = "";
let cachedHomeRefreshInterval = 0;
let cachedHomeAgentStates: Record<string, string> = {};



export default function Home() {
  const { t, locale } = useI18n();
  const [data, setData] = useState<ConfigData | null>(cachedHomeData);
  const [error, setError] = useState<string | null>(cachedHomeError);
  const [refreshInterval, setRefreshInterval] = useState(cachedHomeRefreshInterval);
  const [lastUpdated, setLastUpdated] = useState<string>(cachedHomeLastUpdated);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const [testResults, setTestResults] = useState<Record<string, AgentModelTestResult | null> | null>(null);
  const [testing, setTesting] = useState(false);
  const [platformTestResults, setPlatformTestResults] = useState<Record<string, PlatformTestResult | null> | null>(null);
  const [testingPlatforms, setTestingPlatforms] = useState(false);
  const [sessionTestResults, setSessionTestResults] = useState<Record<string, AgentSessionTestResult | null> | null>(null);
  const [testingSessions, setTestingSessions] = useState(false);
  const [dmSessionResults, setDmSessionResults] = useState<Record<string, PlatformTestResult | null> | null>(null);
  const [testingDmSessions, setTestingDmSessions] = useState(false);
  const [agentStates, setAgentStates] = useState<Record<string, string>>(cachedHomeAgentStates);


  const REFRESH_OPTIONS = [
    { label: t("refresh.manual"), value: 0 },
    { label: t("refresh.10s"), value: 10 },
    { label: t("refresh.30s"), value: 30 },
    { label: t("refresh.1m"), value: 60 },
    { label: t("refresh.5m"), value: 300 },
    { label: t("refresh.10m"), value: 600 },
  ];

  const parseApiPayload = useCallback(async (resp: Response) => {
    const raw = await resp.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(raw);
    } catch {}
    const errorText = parsed?.error || raw || `HTTP ${resp.status}`;
    return { ok: resp.ok, status: resp.status, data: parsed, errorText };
  }, []);

  const callTestApi = useCallback(async (url: string) => {
    const requestWithMethod = async (method: "POST" | "GET") => {
      const resp = await fetch(url, { method, cache: "no-store" });
      return parseApiPayload(resp);
    };

    const first = await requestWithMethod("POST");
    if (first.ok) return first.data;

    const methodIssue = first.status === 405 || /method not allowed/i.test(first.errorText || "");
    if (!methodIssue) throw new Error(first.errorText);

    const fallback = await requestWithMethod("GET");
    if (fallback.ok) return fallback.data;
    throw new Error(fallback.errorText || first.errorText);
  }, [parseApiPayload]);

  const fetchData = useCallback((silent = false) => {
    if (!silent) setLoading(true);
    fetch("/api/config")
      .then((r) => r.json())
      .then((configData) => {
        if (configData.error) {
          setError(configData.error);
          cachedHomeError = configData.error;
        } else {
          setData(configData);
          setError(null);
          cachedHomeData = configData;
          cachedHomeError = null;
        }
        const updated = new Date().toLocaleTimeString("zh-CN");
        setLastUpdated(updated);
        cachedHomeLastUpdated = updated;
      })
      .catch((e) => {
        setError(e.message);
        cachedHomeError = e.message;
      })
      .finally(() => {
        if (!silent) setLoading(false);
      });
  }, []);

  const changeAgentModel = useCallback(async (instanceId: string, agentId: string, model: string) => {
    const resp = await fetch("/api/config/agent-model", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instanceId, agentId, model }),
    });
    const payload = await parseApiPayload(resp);
    if (!payload.ok) {
      throw new Error(payload.errorText || t("agent.modelApplyFailed"));
    }
    // 即时回显：先本地更新该 agent 的模型徽章，再后台重新拉取校准（后端 PATCH 已同步清内存+磁盘缓存）
    setData((prev) => {
      if (!prev || !Array.isArray(prev.instances)) return prev;
      return {
        ...prev,
        instances: prev.instances.map((inst) =>
          inst.id === instanceId
            ? {
                ...inst,
                agents: Array.isArray(inst.agents)
                  ? inst.agents.map((a) => (a.id === agentId ? { ...a, model } : a))
                  : inst.agents,
              }
            : inst
        ),
      };
    });
    fetchData(true);
  }, [fetchData, parseApiPayload, t]);

  // 首次加载 - 从 localStorage 恢复测试状态
  useEffect(() => {
    fetchData(!!cachedHomeData);
    const savedTestResults = localStorage.getItem('agentTestResults');
    if (savedTestResults) {
      try {
        setTestResults(JSON.parse(savedTestResults));
      } catch (e) {
        console.error('Failed to parse testResults from localStorage', e);
      }
    }
    const savedPlatformTestResults = localStorage.getItem('platformTestResults');
    if (savedPlatformTestResults) {
      try {
        setPlatformTestResults(JSON.parse(savedPlatformTestResults));
      } catch (e) {
        console.error('Failed to parse platformTestResults from localStorage', e);
      }
    }
    const savedSessionTestResults = localStorage.getItem('sessionTestResults');
    if (savedSessionTestResults) {
      try {
        setSessionTestResults(JSON.parse(savedSessionTestResults));
      } catch (e) {
        console.error('Failed to parse sessionTestResults from localStorage', e);
      }
    }
    const savedDmSessionResults = localStorage.getItem('dmSessionResults');
    if (savedDmSessionResults) {
      try {
        setDmSessionResults(JSON.parse(savedDmSessionResults));
      } catch (e) {
        console.error('Failed to parse dmSessionResults from localStorage', e);
      }
    }
  }, [fetchData]);

  useEffect(() => {
    cachedHomeRefreshInterval = refreshInterval;
  }, [refreshInterval]);

  // 保存测试结果到 localStorage
  useEffect(() => {
    if (testResults) {
      localStorage.setItem('agentTestResults', JSON.stringify(testResults));
    }
  }, [testResults]);

  useEffect(() => {
    if (platformTestResults) {
      localStorage.setItem('platformTestResults', JSON.stringify(platformTestResults));
    }
  }, [platformTestResults]);

  useEffect(() => {
    if (sessionTestResults) {
      localStorage.setItem('sessionTestResults', JSON.stringify(sessionTestResults));
    }
  }, [sessionTestResults]);

  useEffect(() => {
    if (dmSessionResults) {
      localStorage.setItem('dmSessionResults', JSON.stringify(dmSessionResults));
    }
  }, [dmSessionResults]);

  const testAllAgents = useCallback(() => {
    setTesting(true);
    // Set all agents to null (testing indicator) so UI shows ⏳
    const pending: Record<string, any> = {};
    for (const { instanceId, agent } of getAgentTargets(data)) pending[agentResultKey(instanceId, agent.id)] = null;
    setTestResults(pending);
    callTestApi("/api/test-bound-models")
      .then((resp) => {
        if (resp.results) {
          const map: Record<string, { ok: boolean; text?: string; error?: string; elapsed: number }> = {};
          for (const r of resp.results) map[agentResultKey(r.instanceId, r.agentId)] = r;
          setTestResults(map);
        }
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : "Request failed";
        const failed: Record<string, { ok: boolean; error: string; elapsed: number }> = {};
        for (const { instanceId, agent } of getAgentTargets(data)) failed[agentResultKey(instanceId, agent.id)] = { ok: false, error: msg, elapsed: 0 };
        setTestResults(failed);
      })
      .finally(() => setTesting(false));
  }, [data, callTestApi]);

  const testAllPlatforms = useCallback(() => {
    setTestingPlatforms(true);
    // Set all agent:platform combos to null (⏳)
    const pending: Record<string, any> = {};
    if (data) {
        for (const { instanceId, agent: a } of getAgentTargets(data)) {
          for (const p of a.platforms) {
          pending[agentPlatformResultKey(instanceId, a.id, p.name)] = null;
        }
      }
    }
    setPlatformTestResults(pending);
    callTestApi("/api/test-platforms")
      .then((resp) => {
        if (resp.results) {
          const map: Record<string, PlatformTestResult> = {};
          for (const r of resp.results) map[agentPlatformResultKey(r.instanceId, r.agentId, r.platform)] = r;
          setPlatformTestResults(map);
        }
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : "Request failed";
        const failed: Record<string, PlatformTestResult> = {};
        if (data) {
          for (const { instanceId, agent: a } of getAgentTargets(data)) {
            for (const p of a.platforms) {
              failed[agentPlatformResultKey(instanceId, a.id, p.name)] = {
                ok: false,
                error: msg,
                elapsed: 0,
              };
            }
          }
        }
        setPlatformTestResults(failed);
      })
      .finally(() => setTestingPlatforms(false));
  }, [data, callTestApi]);

  const testAllSessions = useCallback(() => {
    setTestingSessions(true);
    const pending: Record<string, any> = {};
    for (const { instanceId, agent: a } of getAgentTargets(data)) pending[agentResultKey(instanceId, a.id)] = null;
    setSessionTestResults(pending);
    callTestApi("/api/test-sessions")
      .then((resp) => {
        if (resp.results) {
          const map: Record<string, { ok: boolean; reply?: string; error?: string; elapsed: number }> = {};
          for (const r of resp.results) map[agentResultKey(r.instanceId, r.agentId)] = r;
          setSessionTestResults(map);
        }
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : "Request failed";
        const failed: Record<string, { ok: boolean; error: string; elapsed: number }> = {};
        for (const { instanceId, agent: a } of getAgentTargets(data)) failed[agentResultKey(instanceId, a.id)] = { ok: false, error: msg, elapsed: 0 };
        setSessionTestResults(failed);
      })
      .finally(() => setTestingSessions(false));
  }, [data, callTestApi]);

  const testAllDmSessions = useCallback(() => {
    setTestingDmSessions(true);
    const pending: Record<string, any> = {};
    for (const { instanceId, agent } of getAgentTargets(data)) {
      for (const p of agent.platforms) {
        pending[agentPlatformResultKey(instanceId, agent.id, p.name)] = null;
      }
    }
    setDmSessionResults(pending);
    callTestApi("/api/test-dm-sessions")
      .then((resp) => {
        if (resp.results) {
          const map: Record<string, PlatformTestResult> = {};
          for (const r of resp.results) map[agentPlatformResultKey(r.instanceId, r.agentId, r.platform)] = r;
          setDmSessionResults(map);
        }
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : "Request failed";
        const failed: Record<string, PlatformTestResult> = {};
        for (const { instanceId, agent } of getAgentTargets(data)) {
          for (const p of agent.platforms) {
            failed[agentPlatformResultKey(instanceId, agent.id, p.name)] = {
              ok: false,
              error: msg,
              elapsed: 0,
            };
          }
        }
        setDmSessionResults(failed);
      })
      .finally(() => setTestingDmSessions(false));
  }, [data, callTestApi]);

  // 定时刷新
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (refreshInterval > 0) {
      timerRef.current = setInterval(fetchData, refreshInterval * 1000);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [refreshInterval, fetchData]);

  // Agent 状态轮询 (30秒)
  useEffect(() => {
    const fetchStatus = () => {
      fetch("/api/agent-status")
        .then(r => r.json())
        .then(d => {
          if (d.statuses) {
            const map: Record<string, string> = {};
            for (const s of d.statuses) map[agentResultKey(s.instanceId, s.agentId)] = s.state;
            setAgentStates(map);
            cachedHomeAgentStates = map;
          }
        })
        .catch(() => {});
    };
    fetchStatus();
    const timer = setInterval(fetchStatus, 30000);
    return () => clearInterval(timer);
  }, []);


  if (error && !data) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-6 p-8">
        <div className="w-full max-w-md">
          <GatewayStatus />
        </div>
        <div className="text-center">
          <p className="text-red-400 text-sm">{t("common.loadError")}: {error}</p>
          <p className="text-[var(--text-muted)] text-xs mt-1">
            {t("gateway.configCorruptHint")}
          </p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-[var(--text-muted)]">{t("common.loading")}</p>
      </div>
    );
  }

  const providerAccessModeMap: Record<string, "auth" | "api_key"> = {};
  for (const p of data.providers || []) {
    if (!p?.id || !p.accessMode) continue;
    providerAccessModeMap[p.id] = p.accessMode;
  }
  const modelOptions: AgentModelOptionGroup[] = (data.providers || [])
    .filter((provider) => provider?.id && Array.isArray(provider.models) && provider.models.length > 0)
    .map((provider) => ({
      providerId: provider.id,
      providerName: provider.id,
      accessMode: provider.accessMode,
      models: (provider.models || []).map((model) => ({
        id: model.id,
        name: model.name || model.id,
      })),
    }));
  const agentById = new Map(data.agents.map((agent) => [agent.id, agent]));
  const instanceGroups = data.instances?.length
    ? data.instances.map((instance) => ({
        ...instance,
        agents: instance.agents.map((summary): Agent => {
          const base = agentById.get(summary.id);
          return {
            id: summary.id,
            instanceId: instance.id,
            name: summary.name || summary.id,
            emoji: summary.emoji || "🤖",
            model: summary.model || base?.model || data.defaults.model,
            platforms: summary.platforms || base?.platforms || [],
            session: summary.session || base?.session,
          };
        }),
      }))
    : [{ id: "default", name: locale === "zh" ? "主实例" : "Primary instance", gatewayPort: data.gateway?.port, gatewayToken: data.gateway?.token, gatewayHost: data.gateway?.host, agents: data.agents.map((agent) => ({ ...agent, instanceId: "default" })) }];
  return (
    <div className="p-3 md:p-4 max-w-6xl mx-auto">
      {/* 头部 */}
      <div className="flex flex-col gap-2 mb-3 md:flex-row md:items-center md:justify-between">
        <div className="hidden md:block">
          <h1 className="text-xl font-bold flex items-center gap-2">
            🤖 {t("home.pageTitle")}
          </h1>
          <p className="text-[var(--text-muted)] text-xs mt-0.5">
            {t("models.totalPrefix")} {data.agents.length} {t("home.agentCount")} · {t("home.defaultModel")}: {data.defaults.model}
          </p>
        </div>
        <div className="flex items-center gap-2 overflow-x-auto pb-1 max-w-full">
          <button
            onClick={testAllAgents}
            disabled={testing}
            className="shrink-0 px-4 py-2 rounded-lg bg-[var(--card)] border border-[var(--border)] text-[var(--text)] text-sm font-medium hover:border-[var(--accent)] transition disabled:opacity-50 cursor-pointer"
          >
            {testing ? t("home.testingAll") : t("home.testAll")}
          </button>
          <button
            onClick={testAllPlatforms}
            disabled={testingPlatforms}
            className="shrink-0 px-4 py-2 rounded-lg bg-[var(--card)] border border-[var(--border)] text-[var(--text)] text-sm font-medium hover:border-[var(--accent)] transition disabled:opacity-50 cursor-pointer"
          >
            {testingPlatforms ? t("home.testingPlatforms") : t("home.testPlatforms")}
          </button>
          <button
            onClick={testAllSessions}
            disabled={testingSessions}
            className="shrink-0 px-4 py-2 rounded-lg bg-[var(--card)] border border-[var(--border)] text-[var(--text)] text-sm font-medium hover:border-[var(--accent)] transition disabled:opacity-50 cursor-pointer"
          >
            {testingSessions ? t("home.testingSessions") : t("home.testSessions")}
          </button>
          <button
            onClick={testAllDmSessions}
            disabled={testingDmSessions}
            className="shrink-0 px-4 py-2 rounded-lg bg-[var(--card)] border border-[var(--border)] text-[var(--text)] text-sm font-medium hover:border-[var(--accent)] transition disabled:opacity-50 cursor-pointer"
          >
            {testingDmSessions ? t("home.testingDmSessions") : t("home.testDmSessions")}
          </button>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="shrink-0">
          <GatewayStatus hideIconOnMobile />
        </div>
        <div className="flex items-center gap-2 min-w-0 max-w-full overflow-x-auto pb-1 md:overflow-visible md:pb-0">
          <select
            value={refreshInterval}
            onChange={(e) => setRefreshInterval(Number(e.target.value))}
            className="shrink-0 px-3 py-2 rounded-lg bg-[var(--card)] border border-[var(--border)] text-sm text-[var(--text)] cursor-pointer hover:border-[var(--accent)] transition"
          >
            {REFRESH_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.value === 0 ? `🔄 ${opt.label}` : `⏱️ ${opt.label}`}
              </option>
            ))}
          </select>
          {refreshInterval === 0 && (
            <button
              onClick={() => fetchData(false)}
              disabled={loading}
              className="shrink-0 px-3 py-2 rounded-lg bg-[var(--card)] border border-[var(--border)] text-sm hover:border-[var(--accent)] transition disabled:opacity-50"
            >
              {loading ? "⏳" : "🔄"}
            </button>
          )}
          {lastUpdated && (
            <span className="shrink-0 text-xs text-[var(--text-muted)] whitespace-nowrap">
              {t("home.updatedAt")} {lastUpdated}
            </span>
          )}
        </div>
      </div>

      {/* 卡片墙 */}
      <div className="space-y-4">
        {instanceGroups.map((instance) => (
          <section key={instance.id} className="rounded-xl border border-[var(--border)] bg-[var(--card)]/50 p-3 md:p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="text-base">🧩</span>
              <h2 className="text-sm font-semibold text-[var(--text)]">{instance.name}</h2>
              <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-medium text-sky-400">
                {instance.agents.length} {t("home.agentCount")}
              </span>
              {instance.gatewayPort && (
                <span className="text-[10px] text-[var(--text-muted)]">Gateway :{instance.gatewayPort}</span>
              )}
            </div>
            <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2">
              {instance.agents.map((agent) => (
                <div key={`${instance.id}:${agent.id}`} className="w-[85vw] min-w-[280px] max-w-[360px] shrink-0 snap-start sm:w-[320px] lg:w-[340px]">
                  <AgentCard agent={agent} gatewayPort={instance.gatewayPort || data.gateway?.port || 18789} gatewayToken={instance.gatewayToken || data.gateway?.token} gatewayHost={instance.gatewayHost || data.gateway?.host} t={t} testResult={testResults?.[agentResultKey(instance.id, agent.id)]} platformTestResults={scopedPlatformTestResults(platformTestResults, instance.id, agent.id)} sessionTestResult={sessionTestResults?.[agentResultKey(instance.id, agent.id)]} agentState={agentStates[agentResultKey(instance.id, agent.id)]} dmSessionResults={scopedDmSessionResults(dmSessionResults, instance.id, agent.id)} providerAccessModeMap={providerAccessModeMap} modelOptions={modelOptions} onModelChange={(agentId, model) => changeAgentModel(instance.id, agentId, model)} />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      {/* 群聊管理 */}
      {data.groupChats && data.groupChats.length > 0 && (
        <div className="mt-8 p-4 rounded-xl border border-[var(--border)] bg-[var(--card)]">
          <h2 className="text-sm font-semibold text-[var(--text-muted)] mb-3">
            {t("home.groupTopology")}
          </h2>
          <div className="space-y-3">
            {data.groupChats.map((group, i) => (
              <div key={i} className="flex items-center gap-3 p-3 rounded-lg bg-[var(--bg)] border border-[var(--border)]">
                <span className="text-lg">{group.channel === "feishu" ? "📱" : "🎮"}</span>
                <div className="flex-1">
                  <div className="text-xs text-[var(--text-muted)] mb-1">
                    {group.channel === "feishu" ? t("home.feishuGroup") : t("home.discordChannel")} · {group.groupId.split(":")[1]}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {group.agents.map((a) => (
                      <span key={a.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-[var(--card)] border border-[var(--border)]">
                        {a.emoji} {a.name}
                      </span>
                    ))}
                  </div>
                </div>
                <span className="text-xs text-[var(--text-muted)]">{group.agents.length} {t("home.bots")}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Fallback 信息 */}
      {data.defaults.fallbacks.length > 0 && (
        <div className="mt-8 p-4 rounded-xl border border-[var(--border)] bg-[var(--card)]">
          <h2 className="text-sm font-semibold text-[var(--text-muted)] mb-2">
            {t("home.fallbackModels")}
          </h2>
          <div className="flex flex-wrap gap-2">
            {data.defaults.fallbacks.map((f, i) => (
              <ModelBadge key={i} model={f} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
