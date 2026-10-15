import fs from "fs";
import path from "path";
import { OPENCLAW_HOME } from "@/lib/openclaw-paths";
import { loadDiskCache, saveDiskCache } from "@/lib/disk-cache";
import {
  collectAgentDailyFacts,
  resolveInstance,
  type AgentDailyFacts,
} from "@/lib/agent-daily-source";
import { chatComplete, resolveDefaultModelRef, type ModelRef } from "@/lib/chat-complete";

/**
 * Agent 日报生成与缓存：
 * - 生成模型优先 zhipuglm/GLM-5.3-flash（快），失败后回退实例配置的 primary/fallbacks
 * - 日报内容侧重 bug 现象与修复链路，作为部门知识库素材
 * - 成功结果落盘两处：.api-cache（接口缓存）+ /data/knowledge/agent-daily-report/<实例>/<agent>/<日期>.md
 */

const TODAY_TTL_MS = 10 * 60_000;
const FACTS_TEXT_BUDGET = 16_000;
const KNOWLEDGE_DIR = process.env.AGENT_DAILY_KNOWLEDGE_DIR || "/data/knowledge/agent-daily-report";

const SYSTEM_PROMPT = `你是一名严谨的工作日报撰写助手，产出将沉淀到部门知识库。请根据提供的「机器人指定日期会话记录素材」，撰写一份简体中文工作日报。
要求：
1. 汇总当天处理过的主要任务，合并同类项，按重要性排序；每项任务写清楚：做了什么、用了什么方法或工具解决、结果如何；
2. 重点写「问题与修复」：素材中的报错、异常、失败尝试及最终解决方案，按「问题现象 → 原因分析 → 修复方法 → 结果验证」的链路完整记录，这是知识库最核心的部分；未能解决的问题也要如实记录，便于后续跟进；
3. 单独整理「业务认知」：素材中体现的业务规则、数据口径、表或系统的更新时间与频率、权限边界、外部系统行为等与报错无关但长期有用的事实，每条一句话陈述；当天没有则省略；
4. 详略得当：重要任务和有价值的 bug 修复展开写（各2-4句），纯琐碎操作合并一笔带过；禁止编造素材中不存在的内容；
5. 输出 Markdown，仅使用以下结构：
## 主要任务
- **任务名**：方法与结果（2-6 条）
## 问题与修复
- **问题现象**：原因 → 修复方法 → 结果验证（每条问题一项，当天没有问题则省略本节）
## 业务认知
- ...（当天学到的业务规则/数据口径/表与系统更新规律/权限边界/外部系统行为等事实，每条一句；没有则省略本节）
## 待跟进
- ...（仅有未解决事项时保留，没有则省略）
6. 全文控制在 300-900 字，直接陈述事实，不要出现"根据记录"之类的元描述。`;

function safeCacheKey(instanceId: string, agentId: string, date: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `agent-daily--${clean(instanceId)}--${clean(agentId)}--${clean(date)}`;
}

function buildFactsText(facts: AgentDailyFacts): string {
  const parts: string[] = [];
  parts.push(`【日期】${facts.date}`);
  parts.push(`【机器人】${facts.instanceName}/${facts.agentId}`);
  if (facts.userTasks.length > 0) {
    parts.push(`【用户提出的任务/请求】\n${facts.userTasks.map((t, i) => `${i + 1}. ${t}`).join("\n")}`);
  }
  if (facts.cronRuns.length > 0) {
    parts.push(
      `【定时任务执行】\n${facts.cronRuns
        .map((r) => `- ${r.name}：${r.status === "failed" ? "失败" : "完成"}${r.summary ? `，摘要：${r.summary}` : ""}`)
        .join("\n")}`,
    );
  }
  if (facts.spawnLabels.length > 0) {
    parts.push(`【派发的子任务】\n${facts.spawnLabels.map((s) => `- ${s}`).join("\n")}`);
  }
  if (facts.assistantExcerpts.length > 0) {
    parts.push(`【助手回复摘录】\n${facts.assistantExcerpts.map((s) => `- ${s}`).join("\n")}`);
  }
  const toolEntries = Object.entries(facts.toolCounts).sort((a, b) => b[1] - a[1]);
  if (toolEntries.length > 0) {
    parts.push(`【工具调用统计】${toolEntries.map(([n, c]) => `${n}:${c}次`).join(", ")}${facts.toolErrorTotal > 0 ? `（其中失败${facts.toolErrorTotal}次，注意从摘录中找出这些失败的原因与修复过程）` : ""}`);
  }
  let text = parts.join("\n\n");
  if (text.length > FACTS_TEXT_BUDGET) text = `${text.slice(0, FACTS_TEXT_BUDGET)}\n（素材过长已截断）`;
  return text;
}

async function generateReport(facts: AgentDailyFacts): Promise<{ report: string; model: string }> {
  // 1) 速度优先：GLM flash；可用环境变量 AGENT_DAILY_MODEL 覆盖 2) 实例配置的 primary+fallbacks 兑底
  const refs: ModelRef[] = [];
  const pushRef = (ref: ModelRef | null) => {
    if (ref && !refs.some((r) => r.providerId === ref.providerId && r.modelId === ref.modelId)) refs.push(ref);
  };
  pushRef({ providerId: "zhipuglm", modelId: "GLM-5.3-flash" });
  const envModel = process.env.AGENT_DAILY_MODEL;
  if (envModel && envModel.includes("/")) {
    const [providerId, ...rest] = envModel.split("/");
    pushRef({ providerId, modelId: rest.join("/") });
  }
  const { primary, fallbacks } = resolveDefaultModelRef();
  for (const ref of [primary, ...fallbacks]) pushRef(ref);
  if (refs.length === 0) throw new Error("No model configured (agents.defaults.model missing)");

  const errors: string[] = [];
  for (const ref of refs) {
    try {
      const report = await chatComplete({
        modelRef: ref,
        system: SYSTEM_PROMPT,
        user: buildFactsText(facts),
        timeoutMs: 150_000,
        maxTokens: 8000,
        temperature: 0.3,
      });
      return { report, model: `${ref.providerId}/${ref.modelId}` };
    } catch (err) {
      errors.push(`${ref.providerId}/${ref.modelId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(errors.join(" || ") || "LLM generate failed");
}

/** 知识库目录里的实例段：default 实例用其真实主目录名（如 openclaw_TeamS），其余本来就是目录名 */
function instanceSegment(instanceId: string): string {
  if (instanceId !== "default") return instanceId;
  return path.basename(path.dirname(OPENCLAW_HOME));
}

function writeKnowledgeFile(data: DailyReportData): string {
  try {
    const dir = path.join(KNOWLEDGE_DIR, instanceSegment(data.instanceId), data.agentId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${data.date}.md`);
    const header = [
      `# Agent 日报 · ${data.agentId}（${instanceSegment(data.instanceId)}）`,
      "",
      `- 日期：${data.date}`,
      `- 统计：会话 ${data.stats.sessions} · 任务消息 ${data.stats.tasks} · 工具调用 ${data.stats.toolCalls}（失败 ${data.stats.toolErrors}）· 定时任务 ${data.stats.cronJobs}（昨日实际执行 ${data.stats.cronRuns}）`,
      `- 生成时间：${new Date(data.generatedAt).toLocaleString("zh-CN")} · 模型：${data.model || "-"}`,
      `- 来源：OpenClaw-bot-review-furnace 自动生成（素材为该机器人当日会话记录），供部门知识库参考`,
      "",
    ].join("\n");
    fs.writeFileSync(file, `${header}${data.report}\n`);
    return file;
  } catch {
    return "";
  }
}

export async function buildDailyReport(instanceId: string, agentId: string, date: string): Promise<DailyReportData> {
  const instance = resolveInstance(instanceId);
  const facts = await collectAgentDailyFacts(instance, agentId, date);
  const base: DailyReportData = {
    agentId,
    instanceId,
    date,
    hasActivity: facts.hasActivity,
    report: "",
    model: "",
    error: "",
    filePath: "",
    stats: {
      sessions: facts.sessionsScanned,
      tasks: facts.userMessageTotal,
      toolCalls: facts.toolCallTotal,
      cronRuns: facts.cronRuns.length,
      cronJobs: facts.cronRegistryCount,
      toolErrors: facts.toolErrorTotal,
    },
    fallbackTasks: facts.userTasks.slice(0, 20),
    cronRuns: facts.cronRuns,
    generatedAt: Date.now(),
  };
  if (!facts.hasActivity) return base;
  try {
    const { report, model } = await generateReport(facts);
    const data: DailyReportData = { ...base, report, model };
    data.filePath = writeKnowledgeFile(data);
    return data;
  } catch (err: any) {
    // 不缓存 LLM 错误结果；携带原始任务列表供前端兜底
    return { ...base, error: err?.message || "LLM generate failed" };
  }
}

export interface DailyReportData {
  agentId: string;
  instanceId: string;
  date: string;
  hasActivity: boolean;
  report: string;
  model: string;
  error: string;
  filePath: string;
  stats: { sessions: number; tasks: number; toolCalls: number; cronRuns: number; cronJobs: number; toolErrors: number };
  fallbackTasks: string[];
  cronRuns: { name: string; status: string; summary: string }[];
  generatedAt: number;
}

const memCache = new Map<string, { data: DailyReportData; ts: number }>();
const inflightMap = new Map<string, Promise<DailyReportData>>();

function memCacheGet(key: string, isToday: boolean): DailyReportData | null {
  const hit = memCache.get(key);
  if (!hit) return null;
  if (isToday && Date.now() - hit.ts >= TODAY_TTL_MS) return null;
  return hit.data;
}

/** 带缓存的生成入口：历史日期结果永久缓存（不可变），今天 10 分钟 TTL；refresh=true 强制重新生成 */
export async function generateAndCacheReport(
  instanceId: string,
  agentId: string,
  date: string,
  opts: { refresh?: boolean } = {},
): Promise<DailyReportData> {
  const cacheKey = safeCacheKey(instanceId, agentId, date);
  const isToday = date === new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

  if (!opts.refresh) {
    const mem = memCacheGet(cacheKey, isToday);
    if (mem) return mem;
    const disk = loadDiskCache<DailyReportData>(cacheKey);
    if (disk?.data && (!isToday || Date.now() - disk.ts < TODAY_TTL_MS)) {
      memCache.set(cacheKey, { data: disk.data, ts: disk.ts });
      return disk.data;
    }
  }

  const inflight = inflightMap.get(cacheKey);
  if (inflight) return inflight;

  const task = buildDailyReport(instanceId, agentId, date)
    .then((data) => {
      // 仅缓存成功结果（无 error），失败下次自动重试
      if (!data.error) {
        const entry = { data, ts: Date.now() };
        memCache.set(cacheKey, entry);
        saveDiskCache(cacheKey, entry);
      }
      return data;
    })
    .catch((err: any): DailyReportData => ({
      agentId,
      instanceId,
      date,
      hasActivity: false,
      report: "",
      model: "",
      error: err?.message || "collect failed",
      filePath: "",
      stats: { sessions: 0, tasks: 0, toolCalls: 0, cronRuns: 0, cronJobs: 0, toolErrors: 0 },
      fallbackTasks: [],
      cronRuns: [],
      generatedAt: Date.now(),
    }));

  inflightMap.set(cacheKey, task);
  try {
    return await task;
  } finally {
    inflightMap.delete(cacheKey);
  }
}

export { isoYesterday } from "@/lib/agent-daily-source";
