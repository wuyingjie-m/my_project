// lib/skills.ts
import { readdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface SkillInfo {
  name: string;
  path: string;
  version: string;
  description: string;
  status: 'running' | 'disabled' | 'error';
  lastRun: string | null;
}

export function scanSkills(skillsDir: string): SkillInfo[] {
  if (!existsSync(skillsDir)) {
    return [];
  }
  
  let entries: { name: string; isDirectory: () => boolean }[] = [];
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  
  const skills: SkillInfo[] = [];
  
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    
    const skillPath = join(skillsDir, entry.name);
    const skillMdPath = join(skillPath, 'SKILL.md');
    
    let description = '无描述';
    let version = 'unknown';
    
    if (existsSync(skillMdPath)) {
      try {
        const content = readFileSync(skillMdPath, 'utf-8');
        const titleMatch = content.match(/^#\s+(.+)/m);
        const versionMatch = content.match(/version:\s*(.+)/i);
        description = titleMatch?.[1] || entry.name;
        version = versionMatch?.[1] || 'unknown';
      } catch {
        description = entry.name;
      }
    }
    
    skills.push({
      name: entry.name,
      path: skillPath,
      version,
      description,
      status: 'running',
      lastRun: null,
    });
  }
  
  return skills;
}
