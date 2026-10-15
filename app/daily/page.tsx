// app/daily/page.tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n, localeToBcp47 } from '@/lib/i18n';

// 与总览页 Agent 任务追踪同源的数据：/api/agent-activity 下所有实例、所有 agent 的定时任务
interface CronJob {
  key: string;
  jobId: string;
  label: string;
  isRunning: boolean;
  lastRunAt: number;
  nextRunAt?: number;
  durationMs?: number;
  lastStatus: 'success' | 'running' | 'failed';
  lastSummary?: string;
  consecutiveFailures: number;
  enabled?: boolean;
}

interface SubagentActivityEvent {
  key: string;
  text: string;
  at: number;
}

interface SubagentInfo {
  toolId: string;
  label: string;
  activityEvents?: SubagentActivityEvent[];
}

interface AgentActivity {
  activityKey: string;
  instanceId: string;
  instanceName: string;
  agentId: string;
  name: string;
  emoji: string;
  state: 'idle' | 'working' | 'waiting' | 'offline';
  lastActive: number;
  subagents?: SubagentInfo[];
  cronJobs?: CronJob[];
}

interface TrackedJob extends CronJob {
  agentName: string;
  agentEmoji: string;
  instanceName: string;
}

const REFRESH_MS = 30_000;

function isToday(ms: number, now: Date): boolean {
  if (!ms) return false;
  const d = new Date(ms);
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function formatClock(ms: number, locale: string): string {
  if (!ms) return '-';
  return new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

function DailyBoard() {
  const { t, locale } = useI18n();
  const [jobs, setJobs] = useState<TrackedJob[]>([]);
  const [agents, setAgents] = useState<AgentActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState('');
  const [speaking, setSpeaking] = useState(false);
  const [utterance, setUtterance] = useState<SpeechSynthesisUtterance | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 汇总所有实例、所有 agent 的定时任务（停用的任务不计入统计）
  const fetchJobs = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch('/api/agent-activity?includeInstances=1', { cache: 'no-store' });
      const data = await res.json();
      setAgents((data.agents || []) as AgentActivity[]);
      const aggregated: TrackedJob[] = [];
      for (const agent of (data.agents || []) as AgentActivity[]) {
        for (const job of agent.cronJobs || []) {
          if (job.enabled === false) continue;
          aggregated.push({
            ...job,
            agentName: agent.name,
            agentEmoji: agent.emoji || '🤖',
            instanceName: agent.instanceName || '',
          });
        }
      }
      aggregated.sort((a, b) => b.lastRunAt - a.lastRunAt);
      setJobs(aggregated);
      setLoadError(null);
      setUpdatedAt(new Date().toLocaleTimeString('zh-CN'));
    } catch (error) {
      console.error('Failed to fetch agent activity:', error);
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchJobs();
    timerRef.current = setInterval(() => fetchJobs(true), REFRESH_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [fetchJobs]);

  // 互斥分类：今日已完成 / 今日暂失败 / 待开始（其余，含正在运行的；09-23 按用户要求去掉"进行中"档）
  const now = new Date();
  const settled = jobs.filter((j) => !j.isRunning);
  const completedJobs = settled.filter((j) => j.lastStatus === 'success' && isToday(j.lastRunAt, now));
  const failedJobs = settled.filter((j) => j.lastStatus === 'failed' && isToday(j.lastRunAt, now));
  const pendingCount = Math.max(0, jobs.length - completedJobs.length - failedJobs.length);
  const agentCount = new Set(jobs.map((j) => `${j.instanceName}:${j.agentName}`)).size;

  const reportText = (() => {
    if (jobs.length === 0) return t('daily.reportEmpty');
    const summary = t('daily.reportSummary')
      .replace('{total}', String(jobs.length))
      .replace('{completed}', String(completedJobs.length))
      .replace('{failed}', String(failedJobs.length))
      .replace('{pending}', String(pendingCount));
    if (failedJobs.length === 0) return `${summary} ${t('daily.reportAllGood')}`;
    const failures = t('daily.reportFailures')
      .replace('{count}', String(failedJobs.length))
      .replace('{items}', failedJobs.map((j) => j.label).join(locale === 'en' ? '; ' : '、'));
    return `${summary} ${failures}`;
  })();

  const speak = () => {
    if (!('speechSynthesis' in window)) {
      alert(t('daily.noSpeechSupport'));
      return;
    }

    if (speaking && utterance) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }

    const u = new SpeechSynthesisUtterance(reportText);
    u.lang = localeToBcp47(locale);
    u.rate = 1.0;

    u.onstart = () => setSpeaking(true);
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);

    setUtterance(u);
    window.speechSynthesis.speak(u);
  };

  const today = new Date().toLocaleDateString(localeToBcp47(locale), {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });

  return (
    <main className="min-h-screen p-4 md:p-8 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-4 gap-2">
        <div>
          <h1 className="text-2xl font-bold">📅 {t('daily.title')}</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">{today}</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => fetchJobs()}
            disabled={loading}
            className="px-3 py-2 rounded-lg bg-[var(--card)] border border-[var(--border)] text-sm hover:border-[var(--accent)] transition disabled:opacity-50"
            title={t('daily.report')}
          >
            {loading ? '⏳' : '🔄'}
          </button>
          <button
            onClick={speak}
            disabled={loading || jobs.length === 0}
            className={`px-4 py-2 rounded-lg font-medium text-sm transition-all flex items-center gap-2 ${
              speaking
                ? 'bg-red-500 hover:bg-red-600 text-white'
                : 'bg-blue-500 hover:bg-blue-600 text-white'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {speaking ? (
              <>
                <span>⏹️</span> {t('daily.stop')}
              </>
            ) : (
              <>
                <span>🎤</span> {t('daily.report')}
              </>
            )}
          </button>
        </div>
      </div>

      <p className="text-xs text-[var(--text-muted)] mb-4">
        {jobs.length > 0
          ? t('daily.jobSummary')
              .replace('{total}', String(jobs.length))
              .replace('{agents}', String(agentCount))
          : t('daily.noJobs')}
        {updatedAt ? ` · ${t('home.updatedAt')} ${updatedAt}` : ''}
      </p>

      {loadError && (
        <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-400">
          ⚠️ {t('daily.loadError')}：{loadError}
        </div>
      )}

      {/* 定时任务状态统计 */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-[var(--card)] rounded-xl border border-[var(--border)] p-4 text-center">
          <div className="text-2xl font-bold text-green-400">{completedJobs.length}</div>
          <div className="text-xs text-[var(--text-muted)]">{t('daily.completed')}</div>
        </div>
        <div className="bg-[var(--card)] rounded-xl border border-[var(--border)] p-4 text-center">
          <div className="text-2xl font-bold text-red-400">{failedJobs.length}</div>
          <div className="text-xs text-[var(--text-muted)]">{t('daily.tempFailed')}</div>
        </div>
        <div className="bg-[var(--card)] rounded-xl border border-[var(--border)] p-4 text-center">
          <div className="text-2xl font-bold text-gray-400">{pendingCount}</div>
          <div className="text-xs text-[var(--text-muted)]">{t('daily.pending')}</div>
        </div>
      </div>

      {/* 今日记录：失败的定时任务 */}
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-sm font-semibold text-[var(--text)]">🚨 {t('daily.failedRecords')}</h2>
        {failedJobs.length > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400 font-medium">
            {failedJobs.length}
          </span>
        )}
      </div>
      <div className="bg-[var(--card)] rounded-xl border border-[var(--border)] overflow-hidden mb-4">
        {loading ? (
          <div className="p-8 text-center text-[var(--text-muted)]">{t('common.loading')}</div>
        ) : failedJobs.length === 0 ? (
          <div className="p-8 text-center text-[var(--text-muted)]">
            {t('daily.noFailedRecords')}
          </div>
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {failedJobs.map((job) => (
              <div
                key={`${job.instanceName}:${job.agentName}:${job.jobId}`}
                className="p-4 flex items-start gap-3"
              >
                <span className="text-lg mt-0.5">❌</span>
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-[var(--text)]">{job.label}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-sky-500/15 text-sky-400 border border-sky-500/20">
                      {job.agentEmoji} {job.agentName}
                    </span>
                    {job.instanceName && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--border)] text-[var(--text-muted)]">
                        {job.instanceName}
                      </span>
                    )}
                    {job.consecutiveFailures > 0 && (
                      <span className="text-[10px] text-red-400">
                        {t('daily.consecutiveFailures').replace('{count}', String(job.consecutiveFailures))}
                      </span>
                    )}
                  </div>
                  {job.lastSummary && (
                    <p className="text-xs text-[var(--text-muted)] mt-1 break-words">{job.lastSummary}</p>
                  )}
                  <p className="text-[10px] text-[var(--text-muted)] mt-1 opacity-70">
                    {formatClock(job.lastRunAt, locale === 'zh' ? 'zh-CN' : locale)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {speaking && (
        <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/30 text-xs text-blue-400">
          🎤 {t('daily.speakingHint')}
        </div>
      )}
      {/* Agent 任务追踪（仅长期定时任务，一次性任务不统计） */}
      {agents.some((a) => a.state !== 'offline' || (a.cronJobs && a.cronJobs.length > 0)) && (
        <div className="mt-6 p-4 rounded-xl border border-[var(--border)] bg-[var(--card)]">
          <h2 className="text-sm font-semibold text-[var(--text-muted)] mb-3">📋 {t('home.agentTaskTracking')}</h2>
          <div className="space-y-2">
            {agents
              .filter((a) => a.state !== 'offline' || (a.cronJobs && a.cronJobs.length > 0))
              .map((agent) => (
                <div key={agent.activityKey || `${agent.instanceId || 'default'}:${agent.agentId}`} className="flex items-start gap-3 p-3 rounded-lg bg-[var(--bg)] border border-[var(--border)]">
                  <span className="text-lg leading-none mt-0.5">{agent.emoji || '🤖'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-[var(--text)]">{agent.name}</span>
                      {agent.instanceName && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-sky-500/15 text-sky-400 border border-sky-500/20">
                          {agent.instanceName}
                        </span>
                      )}
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                        agent.state === 'working' ? 'bg-emerald-500/20 text-emerald-400' :
                        agent.state === 'waiting' ? 'bg-amber-500/20 text-amber-400' :
                        'bg-[var(--border)] text-[var(--text-muted)]'
                      }`}>
                        {agent.state === 'working'
                          ? t('home.agentTaskState.working')
                          : agent.state === 'waiting'
                            ? t('home.agentTaskState.waiting')
                            : t('home.agentTaskState.idle')}
                      </span>
                    </div>
                    {agent.subagents && agent.subagents.length > 0 ? (
                      <div className="space-y-1">
                        <div className="text-[10px] uppercase tracking-wide opacity-60">{t('home.agentTaskSubtasks')}</div>
                        {agent.subagents.map((sub, i) => (
                          <div key={i} className="text-xs text-[var(--text-muted)]">
                            <span className="text-[var(--accent)] mr-1">↳</span>
                            <span className="font-medium text-[var(--text)]">{sub.label}</span>
                            {sub.activityEvents && sub.activityEvents.length > 0 && (
                              <span className="ml-2 opacity-70">— {sub.activityEvents[sub.activityEvents.length - 1].text}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs text-[var(--text-muted)] opacity-60">{t('home.agentTaskNoSubtasks')}</div>
                    )}
                    {agent.cronJobs && agent.cronJobs.length > 0 ? (
                      <div className="space-y-1 mt-2 pt-2 border-t border-[var(--border)]">
                        <div className="text-[10px] uppercase tracking-wide opacity-60">{t('home.agentTaskCron')}</div>
                        {agent.cronJobs.map((cron) => (
                          <div key={cron.key} className="text-xs text-[var(--text-muted)]">
                            <div className="flex items-center gap-2">
                              <span className="text-yellow-400">⏰</span>
                              <span className="font-medium text-[var(--text)]">{cron.label}</span>
                              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                                cron.lastStatus === 'running'
                                  ? 'bg-sky-500/20 text-sky-400'
                                  : cron.lastStatus === 'failed'
                                    ? 'bg-red-500/20 text-red-400'
                                    : 'bg-emerald-500/20 text-emerald-400'
                              }`}>
                                {cron.lastStatus === 'running'
                                  ? t('home.agentTaskCronState.running')
                                  : cron.lastStatus === 'failed'
                                    ? t('home.agentTaskCronState.failed')
                                    : t('home.agentTaskCronState.success')}
                              </span>
                              {cron.consecutiveFailures > 0 && (
                                <span className="text-[10px] text-red-400">
                                  {t('daily.consecutiveFailures').replace('{count}', String(cron.consecutiveFailures))}
                                </span>
                              )}
                            </div>
                            <div className="ml-5 opacity-70">
                              {cron.lastSummary || t('home.agentTaskCronNoSummary')}
                            </div>
                            <div className="ml-5 mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-[10px] opacity-60">
                              {cron.durationMs !== undefined && (
                                <span>{t('home.agentTaskCronDuration')} {Math.max(1, Math.round(cron.durationMs / 1000))}s</span>
                              )}
                              {cron.nextRunAt ? (
                                <span>
                                  {t('home.agentTaskCronNextRun')} {new Date(cron.nextRunAt).toLocaleTimeString(locale === 'zh' ? 'zh-CN' : locale, { hour: '2-digit', minute: '2-digit' })}
                                </span>
                              ) : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs text-[var(--text-muted)] opacity-60 mt-2">{t('home.agentTaskNoCron')}</div>
                    )}
                  </div>
                  <div className="text-[10px] text-[var(--text-muted)] whitespace-nowrap">
                    {agent.lastActive ? new Date(agent.lastActive).toLocaleTimeString(locale === 'zh' ? 'zh-CN' : locale, { hour: '2-digit', minute: '2-digit' }) : ''}
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

    </main>
  );
}

export default function DailyPage() {
  return <DailyBoard />;
}
