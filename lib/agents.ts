// lib/agents.ts
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

export interface AgentStatus {
  id: string;
  name: string;
  emoji: string;
  status: 'working' | 'idle' | 'thinking' | 'waiting';
  mood: 'happy' | 'neutral' | 'busy' | 'tired' | 'thinking';
  currentTask: string;
  uptime: number;
  lastActive: string;
}

export function getAgents(): AgentStatus[] {
  const configPath = process.env.OPENCLAW_CONFIG_PATH
    || join(process.env.OPENCLAW_HOME || process.env.HOME || '', 'openclaw.json');
  
  if (!existsSync(configPath)) {
    return [];
  }
  
  let config: any = {};
  try {
    config = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return [];
  }
  
  // 从配置中提取 Agent 信息
  const agents = Object.entries(config.agents || {}).map(([id, agent]: [string, any]) => ({
    id,
    name: agent.name || id,
    emoji: agent.emoji || '🤖',
    status: 'idle' as const,
    mood: 'neutral' as const,
    currentTask: '等待指令',
    uptime: 0,
    lastActive: new Date().toISOString(),
  }));
  
  return agents;
}
