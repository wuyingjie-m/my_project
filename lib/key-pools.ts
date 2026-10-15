import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { discoverOpenClawInstances, getInstanceAgentIds, configuredAgentEntries } from "@/lib/openclaw-instances";

export type Usage = { inputTokens: number; outputTokens: number; totalTokens: number };

export type AgentKeyInfo = {
  instanceId: string;
  instanceName: string;
  homeDir: string;
  agentId: string;
  name: string;
  provider: string;
  profileId: string;
  keyTail: string;
  keyLen: number;
  source: "per-agent" | "shared";
};

type Profiles = Record<string, { provider?: string; key?: string }>;

function readProfilesSqlite(dbPath: string): Profiles | null {
  try {
    if (!fs.existsSync(dbPath)) return null;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare("SELECT store_json FROM auth_profile_store WHERE store_key='primary'").all() as Array<{ store_json: string }>;
      for (const r of rows) {
        const parsed = JSON.parse(r.store_json);
        if (parsed && typeof parsed === "object" && parsed.profiles) return parsed.profiles as Profiles;
      }
    } finally {
      try { db.close(); } catch {}
    }
  } catch {}
  return null;
}

function readSharedProfiles(homeDir: string): Profiles | null {
  try {
    // homeDir 语义 = <root>/.openclaw（见 openclaw-instances.ts：agentsDir = homeDir + "/agents"）
    const dbPath = path.join(homeDir, "state", "openclaw.sqlite");
    if (!fs.existsSync(dbPath)) return null;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare("SELECT value_json FROM config_machine_state WHERE state_key='authProfiles.store'").all() as Array<{ value_json: string }>;
      for (const r of rows) {
        const parsed = JSON.parse(r.value_json);
        if (parsed && typeof parsed === "object" && parsed.profiles) return parsed.profiles as Profiles;
      }
    } finally {
      try { db.close(); } catch {}
    }
  } catch {}
  return null;
}

function pick(profiles: Profiles | null, providerPref = "zhipuglm") {
  if (!profiles) return null;
  const ids = Object.keys(profiles);
  const id = ids.find((x) => x === `${providerPref}:manual`) || ids.find((x) => x.startsWith(`${providerPref}:`)) || ids[0];
  if (!id) return null;
  const p = profiles[id];
  if (!p || !p.key) return null;
  return { profileId: id, provider: p.provider || id.split(":")[0], key: String(p.key) };
}

export function readAgentKeyInfos(): AgentKeyInfo[] {
  const out: AgentKeyInfo[] = [];
  for (const instance of discoverOpenClawInstances()) {
    const sharedPick = pick(readSharedProfiles(instance.homeDir));
    for (const agentId of getInstanceAgentIds(instance)) {
      const perAgentProfiles = readProfilesSqlite(path.join(instance.homeDir, "agents", agentId, "agent", "openclaw-agent.sqlite"));
      const perAgent = pick(perAgentProfiles);
      // 目标 provider（zhipuglm）命中优先：per-agent 库只剩其它 provider（如 deepseek）时，
      // 不得用 ids[0] 兜底遮蔽共享层的 zhipuglm key（QD 2026-10-13 回读假失败根因）
      const picked = perAgent?.provider === "zhipuglm" ? perAgent
        : sharedPick?.provider === "zhipuglm" ? sharedPick
        : (perAgent || sharedPick);
      const entry = configuredAgentEntries(instance.config).find((a) => a.id === agentId);
      out.push({
        instanceId: instance.id,
        instanceName: instance.name,
        homeDir: instance.homeDir,
        agentId,
        name: entry?.name || agentId,
        provider: picked?.provider || "",
        profileId: picked?.profileId || "",
        keyTail: picked ? String(picked.key).slice(-6) : "",
        keyLen: picked ? String(picked.key).length : 0,
        source: picked === perAgent && perAgent ? "per-agent" : "shared",
      });
    }
  }
  return out;
}

export function groupPools(infos: AgentKeyInfo[]) {
  const pools: Array<{ provider: string; keyTail: string; keyLen: number; members: AgentKeyInfo[] }> = [];
  const byId = new Map<string, { provider: string; keyTail: string; keyLen: number; members: AgentKeyInfo[] }>();
  for (const a of infos) {
    if (!a.keyTail) continue;
    const id = `${a.provider}:${a.keyTail}:${a.keyLen}`;
    let pool = byId.get(id);
    if (!pool) {
      pool = { provider: a.provider, keyTail: a.keyTail, keyLen: a.keyLen, members: [] };
      byId.set(id, pool);
      pools.push(pool);
    }
    pool.members.push(a);
  }
  return pools;
}

// 5小时窗口 usage：直查 transcript_events（bounded by cutoff），JSONL 兜底场景（无 sqlite）返回 0
export function usageSince(homeDir: string, agentId: string, sinceMs: number, untilMs?: number): Usage {
  const out: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const dbPath = path.join(homeDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
  if (!fs.existsSync(dbPath)) return out;
  let db: InstanceType<typeof DatabaseSync> | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 3000");
    const iso = new Date(sinceMs).toISOString();
    const rows = db
      .prepare(
        untilMs
          ? "SELECT created_at, event_json FROM transcript_events WHERE ((typeof(created_at)='integer' AND created_at >= ?) OR (typeof(created_at)='text' AND created_at >= ?)) AND ((typeof(created_at)='integer' AND created_at < ?) OR (typeof(created_at)='text' AND created_at < ?))"
          : "SELECT created_at, event_json FROM transcript_events WHERE (typeof(created_at)='integer' AND created_at >= ?) OR (typeof(created_at)='text' AND created_at >= ?)"
      )
      .all(...(untilMs ? [sinceMs, iso, untilMs, new Date(untilMs).toISOString()] : [sinceMs, iso])) as Array<{ created_at: number | string; event_json: string }>;
    for (const r of rows) {
      const ts = typeof r.created_at === "number" ? r.created_at : Date.parse(String(r.created_at));
      if (!ts || ts < sinceMs) continue;
      if (untilMs && ts >= untilMs) continue;
      let e: any;
      try { e = JSON.parse(r.event_json); } catch { continue; }
      const u = e?.message?.usage;
      if (e?.type !== "message" || e?.message?.role !== "assistant" || !u) continue;
      out.inputTokens += Number(u.input) || 0;
      out.outputTokens += Number(u.output) || 0;
      out.totalTokens += Number(u.totalTokens) || 0;
    }
  } catch {
  } finally {
    try { db?.close(); } catch {}
  }
  return out;
}

// 额度周起始：每周日 resetTime（默认 20:06）后开启新一周；时区固定 UTC+8
export function quotaWeekStart(now = new Date(), resetDow = 0, resetTime = "20:06", tzOffsetHours = 8): string {
  const SHIFT = tzOffsetHours * 3600_000;
  const local = new Date(now.getTime() + SHIFT);
  const [hh, mm] = resetTime.split(":").map(Number);
  const localMs = local.getTime();
  const localMidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const dow = local.getUTCDay();
  const daysSinceResetDay = (dow - resetDow + 7) % 7;
  const thisResetMidnight = localMidnight - daysSinceResetDay * 86400_000;
  const thisResetMoment = thisResetMidnight + (hh * 60 + mm) * 60_000;
  const startLocalMidnight = localMs >= thisResetMoment ? thisResetMidnight : thisResetMidnight - 7 * 86400_000;
  return new Date(startLocalMidnight).toISOString().slice(0, 10);
}

export function nextResetIso(now = new Date(), resetDow = 0, resetTime = "20:06", tzOffsetHours = 8): string {
  const SHIFT = tzOffsetHours * 3600_000;
  const local = new Date(now.getTime() + SHIFT);
  const [hh, mm] = resetTime.split(":").map(Number);
  const localMs = local.getTime();
  const localMidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const dow = local.getUTCDay();
  const daysUntilResetDay = (resetDow - dow + 7) % 7;
  let nextResetMoment = localMidnight + daysUntilResetDay * 86400_000 + (hh * 60 + mm) * 60_000;
  if (nextResetMoment <= localMs) nextResetMoment += 7 * 86400_000;
  return new Date(nextResetMoment - SHIFT).toISOString();
}
