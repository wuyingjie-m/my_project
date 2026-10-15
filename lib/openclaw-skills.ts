import fs from "fs";
import path from "path";
import { getOpenclawPackageCandidates, OPENCLAW_CONFIG_PATH, OPENCLAW_HOME } from "@/lib/openclaw-paths";
import { discoverOpenClawInstances, configuredAgentEntries } from "@/lib/openclaw-instances";

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  emoji: string;
  source: string;
  location: string;
  usedBy: string[];
}

export interface SkillAgentInfo {
  name: string;
  emoji: string;
}

function findOpenClawPkg(): string {
  const candidates = getOpenclawPackageCandidates();
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
  }
  return candidates[0];
}

const OPENCLAW_PKG = findOpenClawPkg();

function parseFrontmatter(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!content.startsWith("---")) return result;
  const parts = content.split("---", 3);
  if (parts.length < 3) return result;
  const fm = parts[1];

  const nameMatch = fm.match(/^name:\s*(.+)/m);
  if (nameMatch) result.name = nameMatch[1].trim().replace(/^["']|["']$/g, "");

  const descMatch = fm.match(/^description:\s*["']?(.+?)["']?\s*$/m);
  if (descMatch) result.description = descMatch[1].trim().replace(/^["']|["']$/g, "");

  const emojiMatch = fm.match(/"emoji":\s*"([^"]+)"/);
  if (emojiMatch) result.emoji = emojiMatch[1];

  return result;
}

function readSkillFile(skillMd: string, source: string, id = path.basename(path.dirname(skillMd))): SkillInfo | null {
  if (!fs.existsSync(skillMd)) return null;
  const content = fs.readFileSync(skillMd, "utf-8");
  const fm = parseFrontmatter(content);
  return {
    id,
    name: fm.name || id,
    description: fm.description || "",
    emoji: fm.emoji || "🔧",
    source,
    location: skillMd,
    usedBy: [],
  };
}

function scanSkillsDir(dir: string, source: string): SkillInfo[] {
  const skills: SkillInfo[] = [];
  if (!fs.existsSync(dir)) return skills;
  for (const name of fs.readdirSync(dir).sort()) {
    const skill = readSkillFile(path.join(dir, name, "SKILL.md"), source, name);
    if (skill) skills.push(skill);
  }
  return skills;
}

function getWorkspaceSkillSources(): Array<{ dir: string; source: string }> {
  const sources: Array<{ dir: string; source: string }> = [];
  const seen = new Set<string>();

  const addSource = (dir: string | undefined, source: string) => {
    if (!dir) return;
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    sources.push({ dir: resolved, source });
  };

  for (const instance of discoverOpenClawInstances()) {
    const instanceKey = instance.id === "default" ? "default" : instance.id;
    addSource(path.join(instance.homeDir, "workspace", "skills"), `workspace:${instanceKey}:main`);
    addSource(path.join(instance.homeDir, "workspaces", "main", "skills"), `workspace:${instanceKey}:main`);
    for (const agent of configuredAgentEntries(instance.config)) {
      const workspaceAgent = agent as { id: string; workspace?: string; agentDir?: string };
      const source = `workspace:${instanceKey}:${agent.id}`;
      addSource(workspaceAgent.workspace ? path.join(workspaceAgent.workspace, "skills") : undefined, source);
      addSource(workspaceAgent.agentDir ? path.join(workspaceAgent.agentDir, "skills") : undefined, source);
      addSource(path.join(instance.homeDir, "workspace", agent.id, "skills"), source);
      addSource(path.join(instance.homeDir, "workspaces", agent.id, "skills"), source);
    }
  }

  return sources;
}

function mergeSkillsByLocation(skills: SkillInfo[]): SkillInfo[] {
  const merged = new Map<string, SkillInfo>();

  for (const skill of skills) {
    const key = `${skill.location}::${skill.id}`;
    if (!merged.has(key)) {
      merged.set(key, skill);
      continue;
    }

    const existing = merged.get(key)!;
    existing.usedBy = Array.from(new Set([...existing.usedBy, ...skill.usedBy])).sort();
  }

  return Array.from(merged.values());
}

function getAgentSkillsFromSessions(): Record<string, Set<string>> {
  const result: Record<string, Set<string>> = {};
  for (const instance of discoverOpenClawInstances()) {
    const agentsDir = instance.agentsDir;
    if (!fs.existsSync(agentsDir)) continue;
    const configuredIds = configuredAgentEntries(instance.config).map((agent) => agent.id);
    const agentIds = configuredIds.length
      ? configuredIds
      : fs.readdirSync(agentsDir).filter((name) => !name.startsWith("."));

    for (const agentId of agentIds) {
      const sessionsDir = path.join(agentsDir, agentId, "sessions");
      if (!fs.existsSync(sessionsDir)) continue;

      const jsonlFiles = fs.readdirSync(sessionsDir)
        .filter((file) => /\.jsonl(?:\.reset\..*)?$/.test(file) && !file.includes(".deleted."))
        .sort();
      const skillNames = new Set<string>();

      for (const file of jsonlFiles.slice(-5)) {
        const content = fs.readFileSync(path.join(sessionsDir, file), "utf-8");
        const idx = content.indexOf("skillsSnapshot");
        if (idx < 0) continue;
        const chunk = content.slice(idx, idx + 12000);
        const matches = chunk.matchAll(/\\?"name\\?":\s*\\?"([^"\\]+)\\?"/g);
        for (const match of matches) {
          const name = match[1];
          if (!["exec", "read", "edit", "write", "process", "message", "web_search", "web_fetch",
                "browser", "tts", "gateway", "memory_search", "memory_get", "cron", "nodes",
                "canvas", "session_status", "sessions_list", "sessions_history", "sessions_send",
                "sessions_spawn", "agents_list"].includes(name) && name.length > 1) {
            skillNames.add(name);
          }
        }
      }

      if (skillNames.size > 0) {
        result[`${instance.id}:${agentId}`] = skillNames;
      }
    }
  }

  return result;
}

export function listOpenclawSkills(): { skills: SkillInfo[]; agents: Record<string, SkillAgentInfo>; total: number } {
  const builtinSkills = scanSkillsDir(path.join(OPENCLAW_PKG, "skills"), "builtin");

  const extDir = path.join(OPENCLAW_PKG, "extensions");
  const extSkills: SkillInfo[] = [];
  if (fs.existsSync(extDir)) {
    for (const ext of fs.readdirSync(extDir)) {
      const extSkill = readSkillFile(path.join(extDir, ext, "SKILL.md"), `extension:${ext}`, ext);
      if (extSkill) extSkills.push(extSkill);

      const skillsDir = path.join(extDir, ext, "skills");
      if (fs.existsSync(skillsDir)) {
        extSkills.push(...scanSkillsDir(skillsDir, `extension:${ext}`));
      }
    }
  }

  const customSkills = discoverOpenClawInstances().flatMap((instance) =>
    scanSkillsDir(path.join(instance.homeDir, "skills"), instance.id === "default" ? "custom" : `custom:${instance.id}`),
  );
  const workspaceSkills = getWorkspaceSkillSources().flatMap(({ dir, source }) => scanSkillsDir(dir, source));
  const allSkills = mergeSkillsByLocation([...builtinSkills, ...extSkills, ...customSkills, ...workspaceSkills]);

  let config: any = null;
  try { config = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, "utf-8")); } catch { /* config unavailable */ }

  const agentSkills = getAgentSkillsFromSessions();
  for (const skill of allSkills) {
    for (const [agentId, skills] of Object.entries(agentSkills)) {
      if (skills.has(skill.id) || skills.has(skill.name)) {
        skill.usedBy.push(agentId);
      }
    }
    skill.usedBy = Array.from(new Set(skill.usedBy)).sort();
  }

  const agents: Record<string, SkillAgentInfo> = {};
  for (const instance of discoverOpenClawInstances()) {
    for (const agent of configuredAgentEntries(instance.config)) {
      const agentInfo = agent as {
        id: string;
        name?: string;
        identity?: { name?: string; emoji?: string };
      };
      const key = `${instance.id}:${agentInfo.id}`;
      agents[key] = {
        name: agentInfo.identity?.name || agentInfo.name || agentInfo.id,
        emoji: agentInfo.identity?.emoji || "🤖",
      };
    }
  }

  return { skills: allSkills, agents, total: allSkills.length };
}

export function getOpenclawSkillContent(source: string, id: string): { skill: SkillInfo; content: string } | null {
  const { skills } = listOpenclawSkills();
  const skill = skills.find((entry) => entry.source === source && entry.id === id);
  if (!skill) return null;
  return {
    skill,
    content: fs.readFileSync(skill.location, "utf-8"),
  };
}
