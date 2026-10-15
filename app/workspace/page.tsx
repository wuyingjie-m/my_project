// app/workspace/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { useI18n, localeToBcp47, type Locale } from '@/lib/i18n';

interface AgentState {
  agentId: string;
  state: 'working' | 'online' | 'idle' | 'offline';
  lastActive: number | null;
}

interface Skill {
  name: string;
  description: string;
  version: string;
  status: string;
}

function AgentCard({
  agent,
  t,
  locale,
}: {
  agent: AgentState;
  t: (key: string) => string;
  locale: Locale;
}) {
  const stateLabels: Record<AgentState['state'], string> = {
    working: t('agent.status.working'),
    online: t('agent.status.online'),
    idle: t('agent.status.idle'),
    offline: t('agent.status.offline'),
  };
  const stateEmojis: Record<AgentState['state'], string> = {
    working: '🔥',
    online: '🟢',
    idle: '😴',
    offline: '⚫',
  };
  const stateColors: Record<AgentState['state'], string> = {
    working: 'bg-green-500',
    online: 'bg-blue-500',
    idle: 'bg-yellow-500',
    offline: 'bg-gray-500',
  };

  const label = stateLabels[agent.state] || stateLabels.offline;
  const emoji = stateEmojis[agent.state] || stateEmojis.offline;
  const color = stateColors[agent.state] || stateColors.offline;
  const lastActiveText = agent.lastActive
    ? new Date(agent.lastActive).toLocaleTimeString(localeToBcp47(locale), {
        hour: '2-digit',
        minute: '2-digit',
      })
    : t('workspace.noRecord');

  return (
    <div className="bg-[var(--card)] rounded-xl border border-[var(--border)] p-4 hover:border-[var(--accent)]/50 transition-all">
      <div className="flex items-center gap-3 mb-3">
        <div className={`w-3 h-3 rounded-full ${color}`} />
        <span className="text-2xl">{emoji}</span>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-sm truncate">{agent.agentId}</h3>
          <p className="text-xs text-[var(--text-muted)]">{label}</p>
        </div>
      </div>
      <div className="text-xs text-[var(--text-muted)]">
        {t('workspace.lastActive')} {lastActiveText}
      </div>
    </div>
  );
}

function SkillCard({ skill, t }: { skill: Skill; t: (key: string) => string }) {
  return (
    <div className="bg-[var(--card)] rounded-xl border border-[var(--border)] p-3 hover:border-[var(--accent)]/50 transition-all">
      <div className="flex items-start justify-between gap-2 mb-2">
        <h4 className="font-medium text-sm truncate">{skill.name}</h4>
        <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
          skill.status === 'running'
            ? 'bg-green-500/20 text-green-400'
            : 'bg-gray-500/20 text-gray-400'
        }`}>
          {skill.status === 'running' ? t('workspace.skillRunning') : t('workspace.skillDisabled')}
        </span>
      </div>
      <p className="text-xs text-[var(--text-muted)] line-clamp-2">
        {skill.description || t('skills.noDesc')}
      </p>
      <p className="text-[10px] text-[var(--accent)] mt-2">
        v{skill.version}
      </p>
    </div>
  );
}

export default function WorkspacePage() {
  const { t, locale } = useI18n();
  const [agents, setAgents] = useState<AgentState[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(new Date());

  useEffect(() => {
    async function fetchData() {
      try {
        const [agentRes, skillsRes] = await Promise.all([
          fetch('/api/agent-status'),
          fetch('/api/skills'),
        ]);
        const agentData = await agentRes.json();
        const skillsData = await skillsRes.json();

        if (Array.isArray(skillsData.skills)) {
          setSkills(skillsData.skills.map((s: { name?: string; id?: string; description?: string; version?: string }) => ({
            name: s.name || s.id || 'unknown',
            description: s.description || '',
            version: s.version || 'unknown',
            status: 'running',
          })));
        }

        setAgents(agentData.statuses || []);
      } catch (error) {
        console.error('Failed to fetch data:', error);
      } finally {
        setLoading(false);
        setLastRefresh(new Date());
      }
    }

    fetchData();
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, []);

  const workingCount = agents.filter(a => a.state === 'working').length;
  const onlineCount = agents.filter(a => a.state === 'online' || a.state === 'working').length;
  const refreshTime = lastRefresh.toLocaleTimeString(localeToBcp47(locale));

  return (
    <main className="min-h-screen p-4 md:p-8 max-w-7xl mx-auto">
      <div className="flex flex-col gap-4 mb-8 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold">🤖 {t('nav.workspace')}</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            {t('workspace.subtitle').replace('{time}', refreshTime)}
          </p>
        </div>
        <div className="flex gap-3">
          <div className="px-3 py-1.5 rounded-lg bg-[var(--card)] border border-[var(--border)] text-xs">
            <span className="text-[var(--text-muted)]">{t('workspace.online')}</span>
            <span className="font-semibold ml-1">{onlineCount}/{agents.length}</span>
          </div>
          <div className="px-3 py-1.5 rounded-lg bg-[var(--card)] border border-[var(--border)] text-xs">
            <span className="text-[var(--text-muted)]">{t('workspace.workingCount')}</span>
            <span className="font-semibold ml-1 text-green-400">{workingCount}</span>
          </div>
        </div>
      </div>

      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-4">📊 {t('workspace.agentStatus')}</h2>
        {loading ? (
          <div className="text-center py-8 text-[var(--text-muted)]">{t('common.loading')}</div>
        ) : agents.length === 0 ? (
          <div className="text-center py-8 text-[var(--text-muted)] rounded-xl border border-[var(--border)] bg-[var(--card)]">
            {t('workspace.noAgents')}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {agents.map((agent) => (
              <AgentCard key={agent.agentId} agent={agent} t={t} locale={locale} />
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">📦 {t('workspace.installedSkills')}</h2>
          <span className="text-xs text-[var(--text-muted)]">
            {t('workspace.totalSkills').replace('{count}', String(skills.length))}
          </span>
        </div>
        {loading ? (
          <div className="text-center py-8 text-[var(--text-muted)]">{t('common.loading')}</div>
        ) : skills.length === 0 ? (
          <div className="text-center py-8 text-[var(--text-muted)] rounded-xl border border-[var(--border)] bg-[var(--card)]">
            {t('workspace.noSkills')}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {skills.map((skill) => (
              <SkillCard key={skill.name} skill={skill} t={t} />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
