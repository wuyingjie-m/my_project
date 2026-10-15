"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n";

interface Skill {
  id: string;
  name: string;
  description: string;
  emoji: string;
  source: string;
  usedBy: string[];
}

interface AgentInfo {
  name: string;
  emoji: string;
}

type SkillFilter = "all" | "builtin" | "extension" | "custom" | "workspace";

function normalizeSkill(raw: unknown): Skill | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === "string" ? value.id : "";
  const name = typeof value.name === "string" && value.name.trim() ? value.name : id;
  const source = typeof value.source === "string" && value.source.trim() ? value.source : "custom";

  if (!id) return null;

  return {
    id,
    name,
    description: typeof value.description === "string" ? value.description : "",
    emoji: typeof value.emoji === "string" && value.emoji.trim() ? value.emoji : "🧩",
    source,
    usedBy: Array.isArray(value.usedBy)
      ? value.usedBy.filter((agentId): agentId is string => typeof agentId === "string" && agentId.trim().length > 0)
      : [],
  };
}

function normalizeAgents(raw: unknown): Record<string, AgentInfo> {
  if (!raw || typeof raw !== "object") return {};

  const entries = Object.entries(raw as Record<string, unknown>)
    .map(([agentId, info]) => {
      if (!info || typeof info !== "object") return null;
      const value = info as Record<string, unknown>;
      return [
        agentId,
        {
          name: typeof value.name === "string" && value.name.trim() ? value.name : agentId,
          emoji: typeof value.emoji === "string" && value.emoji.trim() ? value.emoji : "🤖",
        },
      ] as const;
    })
    .filter((entry): entry is readonly [string, AgentInfo] => Boolean(entry));

  return Object.fromEntries(entries);
}

function getWorkspaceIdFromSource(source: string): string | null {
  if (!source.startsWith("workspace:")) return null;
  return source.slice("workspace:".length) || null;
}

export default function SkillsPage() {
  const { t } = useI18n();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [agents, setAgents] = useState<Record<string, AgentInfo>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<SkillFilter>("all");
  const [workspaceFilter, setWorkspaceFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [skillContent, setSkillContent] = useState<Record<string, string>>({});
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/skills")
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data?.error || `HTTP ${response.status}`);
        }
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        if (data?.error) {
          setError(data.error);
          return;
        }

        const rawSkills = Array.isArray(data?.skills) ? (data.skills as unknown[]) : [];
        const normalizedSkills = rawSkills
          .map(normalizeSkill)
          .filter((skill: Skill | null): skill is Skill => skill !== null);

        setSkills(normalizedSkills);
        setAgents(normalizeAgents(data?.agents));
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedSkill) return;

    const cacheKey = `${selectedSkill.source}:${selectedSkill.id}`;
    if (skillContent[cacheKey]) {
      setContentError(null);
      setContentLoading(false);
      return;
    }

    const controller = new AbortController();
    setContentLoading(true);
    setContentError(null);

    fetch(`/api/skills/content?source=${encodeURIComponent(selectedSkill.source)}&id=${encodeURIComponent(selectedSkill.id)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data?.error || `HTTP ${response.status}`);
        }
        return data;
      })
      .then((data) => {
        const content = typeof data?.content === "string" ? data.content : "";
        setSkillContent((prev) => ({ ...prev, [cacheKey]: content }));
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setContentError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setContentLoading(false);
        }
      });

    return () => controller.abort();
  }, [selectedSkill, skillContent]);

  useEffect(() => {
    if (!selectedSkill) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedSkill(null);
        setContentError(null);
        setContentLoading(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedSkill]);

  const workspaceOptions = useMemo(() => {
    const ids = Array.from(
      new Set(
        skills
          .map((skill) => getWorkspaceIdFromSource(skill.source))
          .filter((workspaceId): workspaceId is string => Boolean(workspaceId))
      )
    ).sort((a, b) => a.localeCompare(b));

    return ids.map((id) => ({
      id,
      label: agents[id]?.name || (id === "main" ? t("skills.workspace.main") : id),
      emoji: agents[id]?.emoji || (id === "main" ? "🏠" : "📁"),
    }));
  }, [agents, skills, t]);

  const filtered = skills.filter((skill) => {
    if (filter === "builtin" && skill.source !== "builtin") return false;
    if (filter === "extension" && !skill.source.startsWith("extension:")) return false;
    if (filter === "custom" && skill.source !== "custom") return false;
    if (filter === "workspace" && !skill.source.startsWith("workspace:")) return false;

    if (workspaceFilter !== "all") {
      const workspaceId = getWorkspaceIdFromSource(skill.source);
      if (workspaceId !== workspaceFilter) return false;
    }

    if (!search) return true;

    const query = search.toLowerCase();
    const workspaceId = getWorkspaceIdFromSource(skill.source) || "";
    const workspaceName = workspaceId ? (agents[workspaceId]?.name || workspaceId).toLowerCase() : "";
    return (
      skill.name.toLowerCase().includes(query) ||
      skill.description.toLowerCase().includes(query) ||
      skill.id.toLowerCase().includes(query) ||
      workspaceName.includes(query) ||
      workspaceId.toLowerCase().includes(query)
    );
  });

  const sourceLabel = (source: string) => {
    if (source === "builtin") return t("skills.source.builtin");
    if (source.startsWith("extension:")) return source.replace("extension:", `${t("skills.extension")}:`);
    if (source.startsWith("workspace:")) {
      const workspaceId = getWorkspaceIdFromSource(source);
      if (!workspaceId) return t("skills.source.workspace");
      if (workspaceId === "main") return `${t("skills.source.workspace")}: ${t("skills.workspace.main")}`;
      return `${t("skills.source.workspace")}: ${agents[workspaceId]?.name || workspaceId}`;
    }
    return t("skills.source.custom");
  };

  const sourceBadgeClass = (source: string) => {
    if (source === "builtin") return "bg-blue-500/20 text-blue-400";
    if (source.startsWith("extension:")) return "bg-purple-500/20 text-purple-400";
    if (source.startsWith("workspace:")) return "bg-amber-500/20 text-amber-300";
    return "bg-green-500/20 text-green-400";
  };

  const selectedSkillCacheKey = selectedSkill ? `${selectedSkill.source}:${selectedSkill.id}` : "";
  const selectedSkillContent = selectedSkill ? skillContent[selectedSkillCacheKey] : "";

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

  const builtinCount = skills.filter((skill) => skill.source === "builtin").length;
  const extensionCount = skills.filter((skill) => skill.source.startsWith("extension:")).length;
  const customCount = skills.filter((skill) => skill.source === "custom").length;
  const workspaceCount = skills.filter((skill) => skill.source.startsWith("workspace:")).length;

  return (
    <main className="min-h-screen p-4 md:p-8 max-w-6xl mx-auto">
      <div className="flex flex-col gap-3 mb-6 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t("skills.title")}</h1>
          <p className="text-[var(--text-muted)] text-sm mt-1">
            {t("skills.totalPrefix")} {skills.length} {t("skills.count")}（{t("skills.builtin")} {builtinCount} / {t("skills.extension")} {extensionCount} / {t("skills.custom")} {customCount} / {t("skills.workspace")} {workspaceCount}）
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/"
            className="px-4 py-2 rounded-lg bg-[var(--card)] border border-[var(--border)] text-sm font-medium hover:border-[var(--accent)] transition"
          >
            {t("common.backOverview")}
          </Link>
        </div>
      </div>

      <div className="flex flex-col gap-3 mb-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:flex-wrap">
          <div className="flex flex-wrap rounded-lg border border-[var(--border)] overflow-hidden">
            {(["all", "builtin", "extension", "custom", "workspace"] as const).map((nextFilter) => (
              <button
                key={nextFilter}
                onClick={() => setFilter(nextFilter)}
                className={`px-3 py-1.5 text-xs font-medium transition cursor-pointer ${
                  filter === nextFilter
                    ? "bg-[var(--accent)] text-[var(--bg)]"
                    : "bg-[var(--card)] text-[var(--text-muted)] hover:text-[var(--text)]"
                }`}
              >
                {nextFilter === "all"
                  ? t("skills.all")
                  : nextFilter === "builtin"
                    ? t("skills.builtin")
                    : nextFilter === "extension"
                      ? t("skills.extension")
                      : nextFilter === "custom"
                        ? t("skills.custom")
                        : t("skills.workspace")}
              </button>
            ))}
          </div>

          {workspaceOptions.length > 0 && (
            <select
              value={workspaceFilter}
              onChange={(event) => setWorkspaceFilter(event.target.value)}
              className="px-3 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--card)] text-sm outline-none focus:border-[var(--accent)] transition w-full md:w-auto"
            >
              <option value="all">{t("skills.workspaceFilter.all")}</option>
              {workspaceOptions.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.emoji} {workspace.label}
                </option>
              ))}
            </select>
          )}

          <input
            type="text"
            placeholder={t("skills.search")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="px-3 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--card)] text-sm outline-none focus:border-[var(--accent)] transition w-full md:w-64"
          />
          <span className="text-xs text-[var(--text-muted)]">
            {t("skills.showing")} {filtered.length} {t("skills.unit")}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.length === 0 ? (
          <div className="col-span-full rounded-xl border border-[var(--border)] bg-[var(--card)] p-8 text-center text-[var(--text-muted)] text-sm">
            {t("common.noData")}
          </div>
        ) : (
          filtered.map((skill) => {
            const workspaceId = getWorkspaceIdFromSource(skill.source);
            const workspaceAgent = workspaceId ? agents[workspaceId] : null;
            return (
              <button
                key={`${skill.source}-${skill.id}`}
                type="button"
                onClick={() => setSelectedSkill(skill)}
                className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 hover:border-[var(--accent)]/50 transition text-left cursor-pointer"
              >
                <div className="flex items-start justify-between mb-2 gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xl shrink-0">{skill.emoji}</span>
                    <span className="font-semibold text-sm truncate">{skill.name}</span>
                  </div>
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium shrink-0 ${sourceBadgeClass(skill.source)}`}>
                    {sourceLabel(skill.source)}
                  </span>
                </div>
                <p className="text-xs text-[var(--text-muted)] line-clamp-2 mb-3 min-h-[2.5em]">
                  {skill.description || t("skills.noDesc")}
                </p>
                {workspaceId && (
                  <div className="mb-3 text-[11px] text-[var(--text-muted)] flex flex-wrap items-center gap-2">
                    <span className="px-2 py-0.5 rounded bg-[var(--bg)] border border-[var(--border)]">
                      {(workspaceAgent?.emoji || (workspaceId === "main" ? "🏠" : "📁"))} {workspaceAgent?.name || (workspaceId === "main" ? t("skills.workspace.main") : workspaceId)}
                    </span>
                    <span className="font-mono text-[10px] text-[var(--text-muted)]/80">{skill.source}</span>
                  </div>
                )}
                <div className="mb-3 text-[10px] text-[var(--accent)]">
                  {t("skills.viewSource")}
                </div>
                {skill.usedBy.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {skill.usedBy.map((agentId) => {
                      const agent = agents[agentId];
                      return (
                        <span
                          key={agentId}
                          className="px-1.5 py-0.5 rounded bg-[var(--bg)] text-[10px] font-medium"
                        >
                          {agent?.emoji || "🤖"} {agent?.name || agentId}
                        </span>
                      );
                    })}
                  </div>
                )}
              </button>
            );
          })
        )}
      </div>

      {selectedSkill && (
        <div className="fixed inset-0 z-[70]">
          <button
            type="button"
            className="absolute inset-0 bg-black/60"
            aria-label={t("common.close")}
            onClick={() => {
              setSelectedSkill(null);
              setContentError(null);
              setContentLoading(false);
            }}
          />
          <div className="absolute inset-x-4 inset-y-6 md:inset-x-10 lg:inset-x-24 xl:inset-x-40 rounded-2xl border border-[var(--border)] bg-[var(--card)] shadow-2xl flex flex-col overflow-hidden">
            <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate">{selectedSkill.emoji} {selectedSkill.name}</div>
                <div className="text-xs text-[var(--text-muted)]">{t("skills.contentTitle")}</div>
                <div className="text-[10px] text-[var(--text-muted)] mt-1">{sourceLabel(selectedSkill.source)}</div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelectedSkill(null);
                  setContentError(null);
                  setContentLoading(false);
                }}
                className="px-3 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg)] text-sm hover:border-[var(--accent)] transition"
              >
                {t("common.close")}
              </button>
            </div>
            <div className="flex-1 overflow-auto bg-[var(--bg)]/40">
              {contentLoading && !selectedSkillContent ? (
                <div className="p-4 text-sm text-[var(--text-muted)]">{t("skills.loadingContent")}</div>
              ) : contentError ? (
                <div className="p-4 text-sm text-red-400">{t("skills.contentLoadFailed")}: {contentError}</div>
              ) : (
                <pre className="p-4 text-xs md:text-sm leading-6 whitespace-pre-wrap break-words text-[var(--text)] font-mono">
                  {selectedSkillContent}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
