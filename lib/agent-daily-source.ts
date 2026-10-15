import { promises as fs, existsSync, readdirSync, statSync } from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { OPENCLAW_AGENTS_DIR, OPENCLAW_CONFIG_PATH, OPENCLAW_HOME } from "@/lib/openclaw-paths";

const execFileAsync = promisify(execFile);

/**
 * Agent 昨日日报数据源：扫描指定实例/机器人的会话记录（JSONL），
 * 提取目标日期内的用户任务、助手回复摘录、工具调用、定时任务执行情况。
 * 只读文件，不做任何写入。
 */

export interface InstanceRef {
  id: string;
  name: string;
  agentsDir: string;
  configPath: string;
}

export interface CronRunFact {
  name: string;
  status: "success" | "failed";
  summary: string;
}

export interface AgentDailyFacts {
  date: string;
  agentId: string;
  instanceId: string;
  instanceName: string;
  sessionsScanned: number;
  userTasks: string[];
  cronRuns: CronRunFact[];
  assistantExcerpts: string[];
  toolCounts: Record<string, number>;
  spawnLabels: string[];
  toolCallTotal: number;
  toolErrorTotal: number;
  userMessageTotal: number;
  cronRegistryCount: number;
  hasActivity: boolean;
}

const DAY_MS = 24 * 3600 * 1000;
const MAX_SESSION_FILES = 20;
const READ_TAIL_BYTES = 768 * 1024;
const MAX_USER_TASKS = 40;
const MAX_ASSISTANT_EXCERPTS = 40;
const MAX_CRON_RUNS = 15;
const MAX_SPAWN_LABELS = 20;

export function isoYesterday(now = Date.now()): string {
  return new Date(now - DAY_MS + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export function isoToday(now = Date.now()): string {
  return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export function dayRangeUtcMs(dateStr: string): { start: number; end: number } {
  const start = Date.parse(`${dateStr}T00:00:00+08:00`);
  if (!Number.isFinite(start)) throw new Error(`Invalid date: ${dateStr}`);
  return { start, end: start + DAY_MS };
}

/** 与 /api/config、/api/agent-activity 一致的实例发现：primary="default"，其余=目录名 */
export function discoverInstances(): InstanceRef[] {
  const primary: InstanceRef = {
    id: "default",
    name: "主实例",
    agentsDir: OPENCLAW_AGENTS_DIR,
    configPath: OPENCLAW_CONFIG_PATH,
  };
  const out: InstanceRef[] = [primary];
  const instancesDir = process.env.OPENCLAW_INSTANCES_DIR || "/data/agent";
  try {
    const primaryId = path.basename(path.dirname(OPENCLAW_HOME));
    for (const entry of readdirSync(instancesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === primaryId) continue;
      const root = path.join(instancesDir, entry.name);
      for (const cand of [path.join(root, ".openclaw", "openclaw.json"), path.join(root, "openclaw.json")]) {
        if (existsSync(cand)) {
          out.push({ id: entry.name, name: entry.name, agentsDir: path.join(path.dirname(cand), "agents"), configPath: cand });
          break;
        }
      }
    }
  } catch {}
  return out;
}

/** 从实例 openclaw.json 读取配置的 agent id 列表（agents.list 优先，entries 兑底，空则探测目录） */
export async function loadInstanceAgentIds(instance: InstanceRef): Promise<string[]> {
  try {
    const raw = await fs.readFile(instance.configPath, "utf8");
    const cfg = JSON.parse(raw);
    let ids: string[] = [];
    if (Array.isArray(cfg?.agents?.list)) {
      ids = cfg.agents.list.filter((a: any) => a && typeof a.id === "string" && a.id).map((a: any) => a.id);
    } else if (cfg?.agents?.entries && typeof cfg.agents.entries === "object" && !Array.isArray(cfg.agents.entries)) {
      ids = Object.keys(cfg.agents.entries);
    }
    if (ids.length > 0) return ids;
  } catch {}
  try {
    const agentsDir = path.join(instance.agentsDir);
    if (existsSync(agentsDir)) {
      return readdirSync(agentsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name);
    }
  } catch {}
  return [];
}

export function resolveInstance(instanceId: string): InstanceRef {
  const list = discoverInstances();
  return list.find((i) => i.id === instanceId) || list[0];
}

function parseRecordTimestamp(record: any): number {
  if (!record || typeof record !== "object") return 0;
  const direct = record.timestamp;
  if (typeof direct === "string") {
    const t = Date.parse(direct);
    if (Number.isFinite(t)) return t;
  } else if (typeof direct === "number" && Number.isFinite(direct)) {
    return direct;
  }
  const msg = record?.message;
  if (msg && typeof msg === "object") {
    if (typeof msg.timestamp === "string") {
      const t = Date.parse(msg.timestamp);
      if (Number.isFinite(t)) return t;
    } else if (typeof msg.timestamp === "number" && Number.isFinite(msg.timestamp)) {
      return msg.timestamp;
    }
  }
  return 0;
}

const NOISE_PHRASES = [
  "A completed subagent task",
  "A subagent task",
  "Subagent Task",
  "END_UNTRUSTED_CHILD_RESULT",
  "Continue where you left off",
  "HEARTBEAT",
  "[heartbeats]",
  "Action:",
];

/** 清洗用户消息：去 XML 上下文注入、fence 包装、时间戳前缀、系统通知 */
function cleanUserText(rawText: string): string | null {
  const noXml = rawText.replace(/<[a-z][\s\S]*?<\/[a-z][^>]*>/gi, "");
  let text = noXml;
  const subagentMatch = noXml.match(/\[Subagent Task\]:\s*([\s\S]+)/);
  if (subagentMatch) {
    text = subagentMatch[1];
  } else {
    const lastFence = text.lastIndexOf("```");
    if (lastFence !== -1) {
      const after = text.slice(lastFence + 3).trim();
      if (after.length > 3) text = after;
    }
  }
  text = text.replace(/\[\w{3}\s\d{4}-\d{2}-\d{2}[^\]]*\]\s*/g, "").trim();
  if (NOISE_PHRASES.some((p) => text.includes(p))) return null;
  text = text.replace(/\s+/g, " ").trim();
  if (text.length < 8) return null;
  return text.length > 220 ? `${text.slice(0, 219)}…` : text;
}

function blockTexts(content: any): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b: any) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string" && b.text.trim())
    .map((b: any) => b.text as string);
}

/** 只读文件尾部，避免超大 transcript 拖垮请求 */
async function readTextTail(filePath: string, maxBytes: number): Promise<string> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size <= maxBytes) return await fs.readFile(filePath, "utf8");
    const handle = await fs.open(filePath, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buf, 0, maxBytes, stat.size - maxBytes);
      let text = buf.toString("utf8", 0, bytesRead);
      const firstNewline = text.indexOf("\n");
      if (firstNewline >= 0) text = text.slice(firstNewline + 1);
      return text;
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

export async function collectAgentDailyFacts(
  instance: InstanceRef,
  agentId: string,
  dateStr: string,
): Promise<AgentDailyFacts> {
  const { start, end } = dayRangeUtcMs(dateStr);
  const now = Date.now();
  const rangeEnd = Math.min(end, now);

  const instanceSessionsDir = path.join(instance.agentsDir, agentId, "sessions");
  const sharedSessionsDir = path.join(OPENCLAW_AGENTS_DIR, agentId, "sessions");
  const sessionsDir = existsSync(instanceSessionsDir)
    ? instanceSessionsDir
    : existsSync(sharedSessionsDir)
      ? sharedSessionsDir
      : instanceSessionsDir;

  const facts: AgentDailyFacts = {
    date: dateStr,
    agentId,
    instanceId: instance.id,
    instanceName: instance.name,
    sessionsScanned: 0,
    userTasks: [],
    cronRuns: [],
    assistantExcerpts: [],
    toolCounts: {},
    spawnLabels: [],
    toolCallTotal: 0,
    toolErrorTotal: 0,
    userMessageTotal: 0,
    cronRegistryCount: 0,
    hasActivity: false,
  };

  if (!existsSync(sessionsDir)) return facts;

  // 收集候选 transcript：sessions.json 索引 + 最近孤儿子文件，只留 mtime ≥ 当日 0 点的
  type Candidate = { sessionKey: string; filePath: string; mtime: number };
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const indexPath = path.join(sessionsDir, "sessions.json");
  if (existsSync(indexPath)) {
    try {
      const index = JSON.parse(await fs.readFile(indexPath, "utf8")) as Record<string, any>;
      for (const [sessionKey, meta] of Object.entries(index)) {
        const sessionId = (meta as any)?.sessionId;
        if (typeof sessionId !== "string" || !sessionId) continue;
        const filePath = path.join(sessionsDir, `${sessionId}.jsonl`);
        if (!existsSync(filePath)) continue;
        let mtime = typeof (meta as any)?.updatedAt === "number" ? (meta as any).updatedAt : 0;
        if (!mtime) {
          try { mtime = statSync(filePath).mtimeMs; } catch { continue; }
        }
        if (mtime < start) continue;
        candidates.push({ sessionKey, filePath, mtime });
        seen.add(filePath);
      }
    } catch {}
  }
  try {
    for (const file of readdirSync(sessionsDir)) {
      if (!/\.jsonl$/.test(file) || file.includes(".deleted.")) continue;
      const filePath = path.join(sessionsDir, file);
      if (seen.has(filePath)) continue;
      let mtime = 0;
      try { mtime = statSync(filePath).mtimeMs; } catch { continue; }
      if (mtime < start) continue;
      candidates.push({ sessionKey: file.slice(0, -".jsonl".length), filePath, mtime });
    }
  } catch {}

  candidates.sort((a, b) => b.mtime - a.mtime);
  const picked = candidates.slice(0, MAX_SESSION_FILES);

  const taskSeen = new Set<string>();
  let excerptCount = 0;

  for (const cand of picked) {
    const isCronSession = cand.sessionKey.includes(":cron:");
    const content = await readTextTail(cand.filePath, READ_TAIL_BYTES);
    if (!content.trim()) continue;
    facts.sessionsScanned += 1;

    let cronSummary = "";
    let cronFailed = false;

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let record: any;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record?.type !== "message" || !record?.message) continue;
      const at = parseRecordTimestamp(record);
      if (at < start || at >= rangeEnd) continue;

      const msg = record.message;
      const role = typeof msg.role === "string" ? msg.role : "";
      const blocks = Array.isArray(msg.content) ? msg.content : [];

      if (role === "user") {
        for (const text of blockTexts(blocks)) {
          const cleaned = cleanUserText(text);
          if (!cleaned || taskSeen.has(cleaned)) continue;
          taskSeen.add(cleaned);
          facts.userTasks.push(cleaned);
          facts.userMessageTotal += 1;
          if (facts.userTasks.length >= MAX_USER_TASKS) break;
        }
        continue;
      }

      if (role === "assistant") {
        for (const block of blocks) {
          if (!block || typeof block !== "object") continue;
          if ((block.type === "toolCall" || block.type === "tool_use") && typeof block.name === "string" && block.name) {
            facts.toolCounts[block.name] = (facts.toolCounts[block.name] || 0) + 1;
            facts.toolCallTotal += 1;
            if (isSpawnToolName(block.name)) {
              const label = pickSpawnLabel(block.type === "toolCall" ? block.arguments : block.input);
              if (label && facts.spawnLabels.length < MAX_SPAWN_LABELS && !facts.spawnLabels.includes(label)) {
                facts.spawnLabels.push(label);
              }
            }
            continue;
          }
          if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
            if (isCronSession && !cronSummary) cronSummary = compact(block.text, 160);
            if (excerptCount < MAX_ASSISTANT_EXCERPTS) {
              const trimmed = compact(block.text, 400);
              if (trimmed.length >= 30) {
                facts.assistantExcerpts.push(trimmed);
                excerptCount += 1;
              }
            }
          }
        }
        continue;
      }

      if (role === "toolResult") {
        const details = msg.details && typeof msg.details === "object" ? msg.details : null;
        const status = typeof details?.status === "string" ? details.status : "";
        if (status.toLowerCase() === "error" || msg.isError === true) {
          facts.toolErrorTotal += 1;
          if (isCronSession) cronFailed = true;
        }
      }
    }

    if (isCronSession && (cronSummary || cronFailed)) {
      const jobName = cand.sessionKey.split(":cron:")[1] || cand.sessionKey;
      if (facts.cronRuns.length < MAX_CRON_RUNS) {
        facts.cronRuns.push({ name: compact(jobName, 60), status: cronFailed ? "failed" : "success", summary: cronSummary });
      }
    }
  }

  facts.hasActivity =
    facts.userTasks.length > 0 || facts.toolCallTotal > 0 || facts.assistantExcerpts.length > 0 || facts.cronRuns.length > 0;

  // 迁移后的实例（jsonl 已归档进 sqlite）从 transcript_events 表补充/合并
  try {
    await mergeSqliteDailyFacts(path.dirname(sessionsDir), facts, start, rangeEnd);
  } catch {}

  // 定时任务注册数：与总览「Agent 任务追踪」同口径（state/openclaw.sqlite 的 cron_jobs 注册表按 owner 归属计数）
  try {
    const stateDb = path.join(path.dirname(instance.configPath), "state", "openclaw.sqlite");
    if (existsSync(stateDb)) {
      const rows = await sqliteJson(stateDb, "SELECT owner_agent_id, agent_id, job_json FROM cron_jobs;");
      facts.cronRegistryCount = rows.filter((r) => inferCronOwner(r) === agentId).length;
    }
  } catch {}

  facts.hasActivity =
    facts.hasActivity ||
    facts.userTasks.length > 0 ||
    facts.toolCallTotal > 0 ||
    facts.assistantExcerpts.length > 0 ||
    facts.cronRuns.length > 0;
  return facts;
}

/* ── sqlite 路径：读 per-agent openclaw-agent.sqlite 的 transcript_events（只读 SELECT） ── */

async function sqliteJson(dbPath: string, sql: string): Promise<any[]> {
  try {
    const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, sql], {
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const rows = JSON.parse(stdout.trim() || "[]");
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

async function mergeSqliteDailyFacts(
  agentDir: string,
  facts: AgentDailyFacts,
  start: number,
  end: number,
): Promise<void> {
  const dbPath = path.join(agentDir, "agent", "openclaw-agent.sqlite");
  if (!existsSync(dbPath)) return;
  const range = `created_at >= ${start} AND created_at < ${end}`;
  const guard = "json_valid(event_json)=1";

  const sessionCount = await sqliteJson(
    dbPath,
    `SELECT COUNT(DISTINCT session_id) AS n FROM transcript_events WHERE ${range} AND ${guard} AND json_extract(event_json,'$.message.role') IS NOT NULL;`,
  );
  const msgCounts = await sqliteJson(
    dbPath,
    `SELECT json_extract(event_json,'$.message.role') AS role, COUNT(*) AS n FROM transcript_events WHERE ${range} AND ${guard} AND json_extract(event_json,'$.message.role') IS NOT NULL GROUP BY role;`,
  );
  facts.sessionsScanned += Number(sessionCount[0]?.n || 0);
  const userCount = Number(msgCounts.find((r: any) => r.role === "user")?.n || 0);
  facts.userMessageTotal += userCount;

  const userRows = await sqliteJson(
    dbPath,
    `SELECT DISTINCT substr(json_extract(value,'$.text'),1,220) AS t
     FROM (SELECT event_json FROM transcript_events WHERE ${range} AND ${guard} AND json_extract(event_json,'$.message.role')='user') te,
     json_each(te.event_json,'$.message.content')
     WHERE json_extract(value,'$.type')='text' AND length(coalesce(json_extract(value,'$.text'),''))>=8
     LIMIT 60;`,
  );
  const taskSeen = new Set(facts.userTasks);
  for (const row of userRows) {
    const cleaned = typeof row?.t === "string" ? cleanUserText(row.t) : null;
    if (!cleaned || taskSeen.has(cleaned) || facts.userTasks.length >= MAX_USER_TASKS) continue;
    taskSeen.add(cleaned);
    facts.userTasks.push(cleaned);
  }

  const excerptRows = await sqliteJson(
    dbPath,
    `SELECT substr(json_extract(value,'$.text'),1,400) AS s
     FROM (SELECT event_json, created_at FROM transcript_events WHERE ${range} AND ${guard} AND json_extract(event_json,'$.message.role')='assistant' ORDER BY created_at DESC LIMIT 60) te,
     json_each(te.event_json,'$.message.content')
     WHERE json_extract(value,'$.type')='text' AND length(coalesce(json_extract(value,'$.text'),''))>=30
     LIMIT 40;`,
  );
  const excerptSeen = new Set(facts.assistantExcerpts);
  for (const row of excerptRows) {
    if (typeof row?.s !== "string") continue;
    if (excerptSeen.has(row.s) || facts.assistantExcerpts.length >= MAX_ASSISTANT_EXCERPTS) continue;
    excerptSeen.add(row.s);
    facts.assistantExcerpts.push(row.s);
  }

  const toolRows = await sqliteJson(
    dbPath,
    `SELECT json_extract(value,'$.name') AS name, COUNT(*) AS n
     FROM (SELECT event_json FROM transcript_events WHERE ${range} AND ${guard} AND json_extract(event_json,'$.message.role')='assistant') te,
     json_each(te.event_json,'$.message.content')
     WHERE json_extract(value,'$.type') IN ('toolCall','tool_use') AND json_extract(value,'$.name') IS NOT NULL
     GROUP BY name ORDER BY n DESC LIMIT 30;`,
  );
  for (const row of toolRows) {
    if (typeof row?.name !== "string") continue;
    const n = Number(row?.n || 0);
    facts.toolCounts[row.name] = (facts.toolCounts[row.name] || 0) + n;
    facts.toolCallTotal += n;
  }

  const spawnRows = await sqliteJson(
    dbPath,
    `SELECT DISTINCT coalesce(json_extract(value,'$.arguments.label'), json_extract(value,'$.arguments.task'), json_extract(value,'$.arguments.description')) AS label
     FROM (SELECT event_json FROM transcript_events WHERE ${range} AND ${guard} AND json_extract(event_json,'$.message.role')='assistant') te,
     json_each(te.event_json,'$.message.content')
     WHERE json_extract(value,'$.type') IN ('toolCall','tool_use') AND json_extract(value,'$.name') IN ('sessions_spawn','session_spawn')
     LIMIT ${MAX_SPAWN_LABELS};`,
  );
  for (const row of spawnRows) {
    if (typeof row?.label === "string" && row.label.trim() && !facts.spawnLabels.includes(row.label.trim())) {
      facts.spawnLabels.push(compact(row.label, 120));
    }
  }

  const errRow = await sqliteJson(
    dbPath,
    `SELECT COUNT(*) AS n FROM transcript_events WHERE ${range} AND ${guard}
      AND json_extract(event_json,'$.message.role')='toolResult'
      AND (json_extract(event_json,'$.message.isError')=1 OR json_extract(event_json,'$.message.details.status')='error');`,
  );
  facts.toolErrorTotal += Number(errRow[0]?.n || 0);

  // 定时任务：session_key 含 :cron: 的会话，取最后一条助手文本为摘要，错误计数定状态
  const cronSessions = await sqliteJson(
    dbPath,
    `SELECT DISTINCT sw.session_key AS key
     FROM session_windows sw JOIN transcript_events te ON te.session_id = sw.session_id
     WHERE te.${range} AND sw.session_key LIKE '%:cron:%'
     LIMIT ${MAX_CRON_RUNS};`,
  );
  for (const row of cronSessions) {
    if (typeof row?.key !== "string" || facts.cronRuns.length >= MAX_CRON_RUNS) continue;
    const key = row.key;
    const safeKey = key.replace(/'/g, "''");
    const jobId = key.includes(":cron:") ? key.split(":cron:")[1].split(":")[0] : key;
    const summaryRows = await sqliteJson(
      dbPath,
      `SELECT substr(json_extract(value,'$.text'),1,200) AS s
       FROM (SELECT event_json FROM transcript_events WHERE session_id = (SELECT session_id FROM session_windows WHERE session_key = '${safeKey}') AND ${range} AND ${guard} AND json_extract(event_json,'$.message.role')='assistant' ORDER BY created_at DESC LIMIT 3) te,
       json_each(te.event_json,'$.message.content')
       WHERE json_extract(value,'$.type')='text' AND length(coalesce(json_extract(value,'$.text'),''))>0
       LIMIT 1;`,
    );
    const errCount = await sqliteJson(
      dbPath,
      `SELECT COUNT(*) AS n
       FROM transcript_events te WHERE te.session_id = (SELECT session_id FROM session_windows WHERE session_key = '${safeKey}') AND te.${range} AND ${guard}
       AND json_extract(te.event_json,'$.message.role')='toolResult'
       AND (json_extract(te.event_json,'$.message.isError')=1 OR json_extract(te.event_json,'$.message.details.status')='error');`,
    );
    const summary = typeof summaryRows[0]?.s === "string" ? compact(summaryRows[0].s, 160) : "";
    const failed = Number(errCount[0]?.n || 0) > 0;
    if (!summary && !failed) continue;
    const name = compact(jobId, 60);
    if (facts.cronRuns.some((r) => r.name === name)) continue;
    facts.cronRuns.push({ name, status: failed ? "failed" : "success", summary });
  }
}

function isSpawnToolName(name: string): boolean {
  return name === "sessions_spawn" || name === "session_spawn";
}

/** 与 agent-activity 的 inferCronOwnerAgentId 同逻辑：owner_agent_id → agent_id → job_json.sessionKey → main */
function inferCronOwner(row: any): string {
  const owner = typeof row?.owner_agent_id === "string" ? row.owner_agent_id.trim() : "";
  if (owner) return owner;
  const aid = typeof row?.agent_id === "string" ? row.agent_id.trim() : "";
  if (aid) return aid;
  try {
    const job = typeof row?.job_json === "string" ? JSON.parse(row.job_json) : row?.job_json;
    const key = typeof job?.sessionKey === "string" ? job.sessionKey : "";
    if (key.startsWith("agent:")) {
      const parts = key.split(":");
      if (parts[1]?.trim()) return parts[1].trim();
    }
  } catch {}
  return "main";
}

function pickSpawnLabel(args: any): string | null {
  if (!args || typeof args !== "object") return null;
  for (const key of ["label", "task", "description"]) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return compact(v, 120);
  }
  return null;
}

function compact(raw: string, maxLen: number): string {
  const s = raw.replace(/\s+/g, " ").trim();
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}
