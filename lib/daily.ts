// lib/daily.ts
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface DailyItem {
  time: string;
  content: string;
  status: 'completed' | 'in-progress' | 'pending';
  agent?: string;
}

export function getTodayItems(): DailyItem[] {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const memoryDir = join(process.env.HOME || '', '.openclaw/workspace/memory');
  const dailyPath = join(memoryDir, `${today}.md`);
  
  if (!existsSync(dailyPath)) {
    return [];
  }
  
  let content = '';
  try {
    content = readFileSync(dailyPath, 'utf-8');
  } catch {
    return [];
  }
  
  const items: DailyItem[] = [];
  const lines = content.split('\n');
  
  for (const line of lines) {
    // 匹配 - [x] 或 - [ ] 格式
    const match = line.match(/^-\s+\[([ x])\]\s+(.+)/);
    if (!match) continue;
    
    const status = match[1] === 'x' ? 'completed' : 'pending';
    const text = match[2];
    
    // 提取时间（如果存在）
    const timeMatch = text.match(/\[([\d: -]+)\]/);
    const time = timeMatch?.[1] || '';
    const contentText = text.replace(/\[[\d: -]+\]\s*/, '').trim();
    
    items.push({
      time,
      content: contentText,
      status,
    });
  }
  
  return items;
}
