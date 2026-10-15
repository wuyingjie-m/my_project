// components/agent-card.tsx
'use client';

import { AgentStatus } from '@/lib/agents';

interface AgentCardProps {
  agent: AgentStatus;
}

const STATUS_LABELS: Record<string, string> = {
  working: '工作中',
  idle: '空闲',
  thinking: '思考中',
  waiting: '等待指令',
};

const MOOD_EMOJIS: Record<string, string> = {
  happy: '😊',
  neutral: '😐',
  busy: '🔥',
  tired: '😴',
  thinking: '🤯',
};

export function AgentCard({ agent }: AgentCardProps) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-4 border border-gray-200 dark:border-gray-700 hover:shadow-lg transition-shadow">
      <div className="flex items-center gap-3 mb-3">
        <span className="text-3xl">{agent.emoji}</span>
        <div>
          <h3 className="font-semibold text-lg">{agent.name}</h3>
          <span className="text-sm text-gray-500">{agent.id}</span>
        </div>
      </div>
      
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-600 dark:text-gray-400">状态：</span>
          <span className="text-sm font-medium">
            {STATUS_LABELS[agent.status] || agent.status}
          </span>
        </div>
        
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-600 dark:text-gray-400">心情：</span>
          <span className="text-lg">{MOOD_EMOJIS[agent.mood] || '😐'}</span>
        </div>
        
        <div className="pt-2 border-t border-gray-100 dark:border-gray-700">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            当前：{agent.currentTask}
          </p>
        </div>
      </div>
    </div>
  );
}
