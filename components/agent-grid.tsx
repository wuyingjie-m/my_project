// components/agent-grid.tsx
'use client';

import { useEffect, useState } from 'react';
import { AgentCard } from './agent-card';
import { AgentStatus } from '@/lib/agents';

export function AgentGrid() {
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchAgents() {
      try {
        const res = await fetch('/api/agents');
        const data = await res.json();
        setAgents(data.agents || []);
      } catch (error) {
        console.error('Failed to fetch agents:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchAgents();
    // 每 10 秒刷新一次
    const interval = setInterval(fetchAgents, 10000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return <div className="text-center py-8 text-gray-500">加载中...</div>;
  }

  if (agents.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500">
        暂无 Agent 数据
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {agents.map((agent) => (
        <AgentCard key={agent.id} agent={agent} />
      ))}
    </div>
  );
}
