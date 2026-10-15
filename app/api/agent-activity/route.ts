import { NextResponse } from 'next/server'
import { promises as fs, existsSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import { parseJsonText } from '@/lib/json'
import { OPENCLAW_AGENTS_DIR, OPENCLAW_CONFIG_PATH, OPENCLAW_HOME } from '@/lib/openclaw-paths'
import { loadDiskCache, saveDiskCache } from '@/lib/disk-cache'

export const dynamic = 'force-dynamic'
export const revalidate = 0
const SESSION_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
const MAX_PARENT_SESSIONS_TO_PARSE = 12
const ORPHAN_FALLBACK_WINDOW_MS = 15 * 60 * 1000
const SUBAGENT_MAX_ACTIVE_MS = 10 * 60 * 1000
const SUBAGENT_ACTIVITY_EVENT_LIMIT = 6
const SUBAGENT_ACTIVITY_TEXT_MAX_LEN = 80
const execFileAsync = promisify(execFile)
const CRON_CACHE_TTL_MS = 60_000
const cronJobsCache = new Map<string, { jobs: CronStoreJob[]; loadedAt: number }>()
let cronCliQueue: Promise<void> = Promise.resolve()

function runCronCliExclusive<T>(operation: () => Promise<T>): Promise<T> {
  const result = cronCliQueue.then(operation, operation)
  cronCliQueue = result.then(() => undefined, () => undefined)
  return result
}

function normalizeIdentityValue(rawValue: string): string | null {
  let value = rawValue.trim()
  if (!value) return null

  const placeholder = /^[_*`~\s]*\((?:your|pick|choose|fill|todo|tbd|填写|选择|待)[^)]*\)[_*`~\s]*/iu
  while (placeholder.test(value)) {
    value = value.replace(placeholder, '').replace(/^[-:：,，\s]+/, '').trim()
  }
  if (!value) return null

  const wrapped = value.match(/^([_*`])(.+)\1$/)
  if (wrapped) value = wrapped[2].trim()

  return value || null
}

function isEmojiLike(value: string): boolean {
  return /\p{Extended_Pictographic}/u.test(value) || /[\u{1F1E6}-\u{1F1FF}]{2}/u.test(value)
}

function normalizeIdentityEmoji(rawEmoji: unknown): string | null {
  if (typeof rawEmoji !== 'string') return null
  const emoji = normalizeIdentityValue(rawEmoji)
  if (!emoji || !isEmojiLike(emoji)) return null
  return emoji
}

type SessionsIndex = Record<string, { sessionId?: string; updatedAt?: number }>
type CronStoreJob = {
  id: string
  agentId?: string
  ownerAgentId?: string
  sessionKey?: string
  name?: string
  displayName?: string
  enabled?: boolean
  payload?: { kind?: string; message?: string; text?: string }
  state?: {
    nextRunAtMs?: number
    lastRunAtMs?: number
    lastDurationMs?: number
    lastStatus?: string
    lastRunStatus?: string
    lastError?: string
    lastDiagnosticSummary?: string
    runningAtMs?: number
    consecutiveErrors?: number
  }
}

export interface SubagentActivityEvent {
  key: string
  text: string
  at: number
}

export interface SubagentInfo {
  toolId: string
  label: string
  sessionKey?: string
  childSessionKey?: string
  activityEvents?: SubagentActivityEvent[]
}

export interface CronJobInfo {
  key: string
  jobId: string
  label: string
  isRunning: boolean
  lastRunAt: number
  nextRunAt?: number
  durationMs?: number
  lastStatus: 'success' | 'running' | 'failed'
  lastSummary?: string
  consecutiveFailures: number
  enabled?: boolean
}

export interface AgentActivity {
  activityKey: string
  instanceId: string
  instanceName: string
  agentId: string
  name: string
  emoji: string
  state: 'idle' | 'working' | 'waiting' | 'offline'
  currentTool?: string
  toolStatus?: string
  lastActive: number
  subagents?: SubagentInfo[]
  cronJobs?: CronJobInfo[]
  lastTask?: string
}

type AgentConfigEntry = {
  id: string
  name?: string
  emoji?: string
  identity?: { emoji?: string }
}

type OpenClawInstance = {
  id: string
  name: string
  configPath: string
  homeDir: string
  agentsDir: string
  isPrimary: boolean
}

type LoadedOpenClawInstance = OpenClawInstance & { config: any }

function configuredAgentEntries(config: any): AgentConfigEntry[] {
  const list = Array.isArray(config?.agents?.list)
    ? config.agents.list.filter((agent: any) => agent && typeof agent.id === 'string' && agent.id)
    : []
  if (list.length > 0) return list

  const entries = config?.agents?.entries
  if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
    return Object.entries(entries).map(([id, value]) => ({
      id,
      ...(value && typeof value === 'object' ? value : {}),
    })) as AgentConfigEntry[]
  }

  return []
}

async function discoverOpenClawInstances(includeInstances: boolean): Promise<OpenClawInstance[]> {
  const primary: OpenClawInstance = {
    id: 'default',
    name: '主实例',
    configPath: OPENCLAW_CONFIG_PATH,
    homeDir: OPENCLAW_HOME,
    agentsDir: OPENCLAW_AGENTS_DIR,
    isPrimary: true,
  }
  if (!includeInstances) return [primary]

  const instancesDir = process.env.OPENCLAW_INSTANCES_DIR || (process.platform === 'linux' ? '/data/agent' : path.join(OPENCLAW_HOME, 'instances'))
  const primaryInstanceId = path.basename(path.dirname(OPENCLAW_HOME))
  if (!existsSync(instancesDir)) return [primary]

  try {
    const entries = await fs.readdir(instancesDir, { withFileTypes: true })
    const children = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .filter((entry) => entry.name !== primaryInstanceId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry): OpenClawInstance[] => {
        const instanceRoot = path.join(instancesDir, entry.name)
        const candidates = [
          path.join(instanceRoot, '.openclaw', 'openclaw.json'),
          path.join(instanceRoot, 'openclaw.json'),
        ]
        const configPath = candidates.find((candidate) => existsSync(candidate))
        if (!configPath) return []
        const homeDir = path.dirname(configPath)
        return [{
          id: entry.name,
          name: entry.name,
          configPath,
          homeDir,
          agentsDir: path.join(homeDir, 'agents'),
          isPrimary: false,
        }]
      })
    return [primary, ...children]
  } catch (error) {
    console.error('Failed to discover OpenClaw instances:', error)
    return [primary]
  }
}

async function loadAgentList(config: any, agentsDir: string): Promise<AgentConfigEntry[]> {
  const configured = configuredAgentEntries(config)
  if (configured.length > 0) return configured

  try {
    if (!existsSync(agentsDir)) return []
    const dirs = await fs.readdir(agentsDir, { withFileTypes: true })
    return dirs
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => ({ id: entry.name }))
  } catch {
    return []
  }
}

function isSubtaskDescription(desc: string): boolean {
  const d = desc.toLowerCase()
  return desc.startsWith('Subtask:') || desc.startsWith('子任务') || d.includes('subtask')
}

function isSpawnTool(name: string): boolean {
  return name === 'sessions_spawn' || name === 'session_spawn'
}

function pickSubagentLabel(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return 'Subtask'
  const args = raw as Record<string, unknown>
  if (typeof args.label === 'string' && args.label.trim()) return args.label.trim()
  if (typeof args.task === 'string' && args.task.trim()) return args.task.trim()
  if (typeof args.description === 'string' && args.description.trim()) return args.description.trim()
  return 'Subtask'
}

function extractCompletedSubagentLabel(text: string): string | null {
  if (!text) return null
  const patterns = [
    /A subagent task\s+”([^”]+)”\s+just completed/i,
    /A subagent task\s+'([^']+)'\s+just completed/i,
    /subagent task\s+”([^”]+)”\s+.*completed/i,
    /subagent task\s+'([^']+)'\s+.*completed/i,
    /子任务[“”]([^””]+)[“”].{0,12}完成/,
  ]
  for (const p of patterns) {
    const m = text.match(p)
    if (m?.[1]?.trim()) return m[1].trim()
  }
  return null
}

/**
 * Extract agentId from “✅ Subagent {agentId} finished” pattern in assistant messages.
 * e.g. “✅ Subagent agentxq finished” → “agentxq”
 */
function extractFinishedSubagentId(text: string): string | null {
  if (!text) return null
  const m = text.match(/(?:✅|☑️|✓)\s*Subagent\s+(\S+)\s+finished/i)
  return m?.[1]?.trim() ?? null
}

/**
 * Given a finished agentId, remove matching subtasks from activeSubtasks.
 * Matches on childSessionKey containing “:agentId:” (e.g. “agent:agentxq:subagent:xxx”).
 */
function removeFinishedSubagentById(
  agentId: string,
  activeSubtasks: Map<string, { label: string; at: number; childSessionKey?: string }>,
): void {
  for (const [id, state] of activeSubtasks.entries()) {
    if (state.childSessionKey && state.childSessionKey.includes(`:${agentId}:`)) {
      activeSubtasks.delete(id)
      return
    }
  }
}

function parseRecordTimestamp(record: unknown): number {
  if (!record || typeof record !== 'object') return 0
  const rec = record as Record<string, unknown>
  if (typeof rec.timestamp === 'string') {
    const t = Date.parse(rec.timestamp)
    if (Number.isFinite(t)) return t
  }
  if (typeof rec.timestamp === 'number' && Number.isFinite(rec.timestamp)) return rec.timestamp
  const msg = rec.message
  if (msg && typeof msg === 'object') {
    const m = msg as Record<string, unknown>
    if (typeof m.timestamp === 'string') {
      const t = Date.parse(m.timestamp)
      if (Number.isFinite(t)) return t
    }
    if (typeof m.timestamp === 'number' && Number.isFinite(m.timestamp)) return m.timestamp
  }
  return 0
}

function normalizeActivityText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const compact = raw.replace(/\s+/g, ' ').trim()
  if (!compact) return null
  return compact.length > SUBAGENT_ACTIVITY_TEXT_MAX_LEN
    ? `${compact.slice(0, SUBAGENT_ACTIVITY_TEXT_MAX_LEN - 1)}…`
    : compact
}

function normalizeCronLabel(raw: unknown, fallbackKey: string): string {
  if (typeof raw === 'string' && raw.trim()) {
    return raw.replace(/^Cron:\s*/i, '').trim() || fallbackKey
  }
  return fallbackKey
}

function truncateSummary(raw: string, maxLen = 120): string {
  const compact = raw.replace(/\s+/g, ' ').trim()
  if (!compact) return ''
  return compact.length > maxLen ? `${compact.slice(0, maxLen - 1)}…` : compact
}

function resolveCronStorePath(config: any, openclawHome: string): string {
  const raw = typeof config?.cron?.store === 'string' ? config.cron.store.trim() : ''
  if (!raw) return path.join(openclawHome, 'cron', 'jobs.json')
  if (raw.startsWith('~')) return path.join(process.env.USERPROFILE || process.env.HOME || '', raw.slice(1))
  return path.isAbsolute(raw) ? raw : path.resolve(openclawHome, raw)
}

async function readSqliteActivity(agentsDir: string, agentId: string): Promise<{ lastActive: number; running: number }> {
  const dbPath = path.join(agentsDir, agentId, 'agent', 'openclaw-agent.sqlite')
  if (!existsSync(dbPath)) return { lastActive: 0, running: 0 }
  try {
    const { stdout } = await execFileAsync('sqlite3', [
      '-json',
      dbPath,
      "SELECT COALESCE(MAX(COALESCE(last_activity_at,last_interaction_at,updated_at)),0) AS lastActive, COALESCE(SUM(CASE WHEN status='running' THEN 1 ELSE 0 END),0) AS running FROM session_nodes;",
    ], { timeout: 5000, maxBuffer: 256 * 1024 })
    const row = JSON.parse(stdout.trim() || '[]')?.[0]
    return {
      lastActive: Number(row?.lastActive || 0),
      running: Number(row?.running || 0),
    }
  } catch {
    return { lastActive: 0, running: 0 }
  }
}

function parseMaybeJson(raw: unknown): any {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/** 只读文件尾部：大 transcript 全量读是主要耗时来源，而状态/活跃推断只需最后若干消息。 */
async function readTextTail(filePath: string, maxBytes: number): Promise<string> {
  try {
    const stat = await fs.stat(filePath)
    if (stat.size <= maxBytes) return await fs.readFile(filePath, 'utf8')
    const handle = await fs.open(filePath, 'r')
    try {
      const buf = Buffer.alloc(maxBytes)
      const { bytesRead } = await handle.read(buf, 0, maxBytes, stat.size - maxBytes)
      let text = buf.toString('utf8', 0, bytesRead)
      const firstNewline = text.indexOf('\n')
      if (firstNewline >= 0) text = text.slice(firstNewline + 1)
      return text
    } finally {
      await handle.close()
    }
  } catch {
    return ''
  }
}

async function readSqliteCronJobs(openclawHome: string): Promise<CronStoreJob[]> {
  const dbPath = path.join(openclawHome, 'state', 'openclaw.sqlite')
  if (!existsSync(dbPath)) return []

  try {
    const { stdout } = await execFileAsync('sqlite3', [
      '-json',
      dbPath,
      [
        'SELECT job_id, declaration_key, owner_agent_id, agent_id, name, enabled, payload_kind,',
        'job_json, state_json, runtime_updated_at_ms, updated_at',
        'FROM cron_jobs ORDER BY COALESCE(owner_agent_id, agent_id, \'\'), sort_order, updated_at DESC;',
      ].join(' '),
    ], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })
    const rows = JSON.parse(stdout.trim() || '[]')
    if (!Array.isArray(rows)) return []

    return rows.map((row: any): CronStoreJob | null => {
      const jobJson = parseMaybeJson(row?.job_json)
      const stateJson = parseMaybeJson(row?.state_json)
      const payload = isPlainObject(jobJson?.payload) ? jobJson.payload : { kind: row?.payload_kind }
      const id = typeof jobJson?.id === 'string' && jobJson.id ? jobJson.id : String(row?.job_id || '')
      if (!id) return null
      return {
        ...jobJson,
        id,
        agentId: typeof row?.agent_id === 'string' && row.agent_id ? row.agent_id : jobJson?.agentId,
        ownerAgentId: typeof row?.owner_agent_id === 'string' && row.owner_agent_id ? row.owner_agent_id : jobJson?.ownerAgentId,
        name: typeof jobJson?.displayName === 'string' && jobJson.displayName
          ? jobJson.displayName
          : typeof row?.name === 'string'
            ? row.name
            : jobJson?.name,
        displayName: typeof jobJson?.displayName === 'string' ? jobJson.displayName : undefined,
        enabled: Number(row?.enabled) !== 0 && jobJson?.enabled !== false,
        payload,
        state: isPlainObject(stateJson) ? stateJson : (isPlainObject(jobJson?.state) ? jobJson.state : {}),
      }
    }).filter((job): job is CronStoreJob => job !== null)
  } catch (error) {
    console.error(`Failed to read SQLite cron jobs from ${dbPath}:`, error)
    return []
  }
}

async function loadCronJobs(instance: LoadedOpenClawInstance): Promise<CronStoreJob[]> {
  const { config, configPath, homeDir, id } = instance
  const cached = cronJobsCache.get(configPath)
  if (cached && Date.now() - cached.loadedAt < CRON_CACHE_TTL_MS) return cached.jobs

  const sqliteJobs = await readSqliteCronJobs(homeDir)
  if (sqliteJobs.length > 0) {
    cronJobsCache.set(configPath, { jobs: sqliteJobs, loadedAt: Date.now() })
    return sqliteJobs
  }

  const storePath = resolveCronStorePath(config, homeDir)
  if (existsSync(storePath)) {
    try {
      const raw = await fs.readFile(storePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed?.jobs)) {
        const jobs = parsed.jobs.filter(Boolean)
        cronJobsCache.set(configPath, { jobs, loadedAt: Date.now() })
        return jobs
      }
    } catch {
      // Fall through to the OpenClaw CLI. Newer OpenClaw versions may use
      // SQLite while retaining jobs.json as a legacy selector path.
    }
  }

  // OpenClaw 2026.6+ can persist the cron registry in state/openclaw.sqlite.
  // Reading through the CLI keeps this dashboard compatible with both the
  // legacy JSON store and the current Gateway-backed store.
  try {
    return await runCronCliExclusive(async () => {
      const refreshed = cronJobsCache.get(configPath)
      if (refreshed && Date.now() - refreshed.loadedAt < CRON_CACHE_TTL_MS) return refreshed.jobs

      const command = process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw'
      const cliEnv = { ...process.env }
      // OPENCLAW_HOME is this dashboard's resolved data directory. It is not
      // an OpenClaw CLI variable; forwarding it makes the CLI append another
      // .openclaw segment (for example, ~/.openclaw/.openclaw).
      delete cliEnv.OPENCLAW_HOME
      cliEnv.OPENCLAW_CONFIG_PATH = configPath
      const gatewayPort = config?.gateway?.port
      if (typeof gatewayPort === 'number' || (typeof gatewayPort === 'string' && gatewayPort.trim())) {
        cliEnv.OPENCLAW_GATEWAY_PORT = String(gatewayPort)
      } else {
        delete cliEnv.OPENCLAW_GATEWAY_PORT
      }
      const { stdout } = await execFileAsync(command, ['cron', 'list', '--json', '--timeout', '10000'], {
        env: cliEnv,
        windowsHide: true,
        // Windows exposes npm-installed CLIs as .cmd shims.
        shell: process.platform === 'win32',
        maxBuffer: 4 * 1024 * 1024,
        timeout: 30_000,
      })
      const jsonStart = stdout.indexOf('{')
      if (jsonStart < 0) return []
      const parsed = JSON.parse(stdout.slice(jsonStart))
      const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs.filter(Boolean) : []
      cronJobsCache.set(configPath, { jobs, loadedAt: Date.now() })
      return jobs
    })
  } catch (error) {
    console.error(`Failed to load cron jobs for OpenClaw instance ${id}:`, error)
    return cronJobsCache.get(configPath)?.jobs || []
  }
}

function inferCronOwnerAgentId(job: CronStoreJob): string {
  if (typeof job.ownerAgentId === 'string' && job.ownerAgentId.trim()) return job.ownerAgentId.trim()
  if (typeof job.agentId === 'string' && job.agentId.trim()) return job.agentId.trim()
  if (typeof job.sessionKey === 'string' && job.sessionKey.startsWith('agent:')) {
    const parts = job.sessionKey.split(':')
    if (parts[1]?.trim()) return parts[1].trim()
  }
  return 'main'
}

function deriveCronSummaryFromJob(job: CronStoreJob): string | undefined {
  const lastError = typeof job.state?.lastError === 'string' ? truncateSummary(job.state.lastError) : ''
  if (lastError) return lastError
  const diagnosticSummary = typeof job.state?.lastDiagnosticSummary === 'string'
    ? truncateSummary(job.state.lastDiagnosticSummary)
    : ''
  if (diagnosticSummary) return diagnosticSummary
  const payloadText =
    typeof job.payload?.message === 'string'
      ? job.payload.message
      : typeof job.payload?.text === 'string'
        ? job.payload.text
        : ''
  return payloadText ? truncateSummary(payloadText) : undefined
}

function mapCronStatus(status: string | undefined): 'success' | 'running' | 'failed' {
  const normalized = (status || '').trim().toLowerCase()
  if (normalized === 'error' || normalized === 'failed') return 'failed'
  if (normalized === 'running') return 'running'
  return 'success'
}

function inferCronStatusFromTranscript(lines: string[], updatedAt: number): {
  isRunning: boolean
  lastStatus: 'success' | 'running' | 'failed'
  lastSummary?: string
  durationMs?: number
} {
  let lastAssistantText: string | undefined
  let lastAssistantError: string | undefined
  let lastToolError: string | undefined
  let lastToolText: string | undefined
  let sawTerminalAssistant = false
  let sawToolUseWithoutResult = false
  let firstAt = 0
  let lastAt = 0

  for (const line of lines) {
    let record: any
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const msg = record?.message
    if (!msg || typeof msg !== 'object') continue
    const at = parseRecordTimestamp(record)
    if (at > 0 && (firstAt === 0 || at < firstAt)) firstAt = at
    if (at > lastAt) lastAt = at

    if (record.type === 'message') {
      const role = typeof msg.role === 'string' ? msg.role : ''
      const blocks = Array.isArray(msg.content) ? msg.content : []

      if (role === 'assistant') {
        for (const block of blocks) {
          if (!block || typeof block !== 'object') continue
          const b = block as Record<string, unknown>
          if ((b.type === 'toolCall' || b.type === 'tool_use') && typeof b.name === 'string') {
            sawToolUseWithoutResult = true
          }
          if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
            lastAssistantText = truncateSummary(b.text)
          }
        }
        if (typeof msg.errorMessage === 'string' && msg.errorMessage.trim()) {
          lastAssistantError = truncateSummary(msg.errorMessage)
        }
        const stopReason = typeof msg.stopReason === 'string' ? msg.stopReason : ''
        if (stopReason === 'stop' || stopReason === 'error') {
          sawTerminalAssistant = true
        }
      }

      if (role === 'toolResult') {
        const details = isPlainObject(msg.details) ? msg.details : null
        const status = typeof details?.status === 'string' ? details.status : ''
        if (status.toLowerCase() === 'error' || msg.isError === true) {
          const detailError =
            typeof details?.error === 'string' && details.error.trim()
              ? details.error
              : typeof details?.aggregated === 'string' && details.aggregated.trim()
                ? details.aggregated
                : ''
          if (detailError) lastToolError = truncateSummary(detailError)
        } else {
          const detailText =
            typeof details?.aggregated === 'string' && details.aggregated.trim()
              ? details.aggregated
              : Array.isArray(msg.content)
                ? msg.content
                    .map((block: any) => (block?.type === 'text' && typeof block.text === 'string') ? block.text : '')
                    .join(' ')
                : ''
          if (detailText.trim()) lastToolText = truncateSummary(detailText)
        }
        sawToolUseWithoutResult = false
      }
    }
  }

  if (lastAssistantError || lastToolError) {
    return {
      isRunning: false,
      lastStatus: 'failed',
      lastSummary: lastAssistantError || lastToolError,
      durationMs: firstAt > 0 && lastAt >= firstAt ? lastAt - firstAt : undefined,
    }
  }

  if (sawTerminalAssistant && lastAssistantText) {
    return {
      isRunning: false,
      lastStatus: 'success',
      lastSummary: lastAssistantText,
      durationMs: firstAt > 0 && lastAt >= firstAt ? lastAt - firstAt : undefined,
    }
  }

  const recentlyUpdated = updatedAt > 0 && Date.now() - updatedAt <= 2 * 60 * 1000
  if (sawToolUseWithoutResult || recentlyUpdated) {
    return {
      isRunning: true,
      lastStatus: 'running',
      lastSummary: lastAssistantText || lastToolText,
      durationMs: firstAt > 0 ? Math.max(0, Date.now() - firstAt) : undefined,
    }
  }

  return {
    isRunning: false,
    lastStatus: lastToolText ? 'success' : 'running',
    lastSummary: lastAssistantText || lastToolText,
    durationMs: firstAt > 0 && lastAt >= firstAt ? lastAt - firstAt : undefined,
  }
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function extractChildSessionKeyFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const data = payload as Record<string, unknown>
  const direct = data.childSessionKey
  if (typeof direct === 'string' && direct.includes(':subagent:')) return direct

  const details = data.details
  if (details && typeof details === 'object') {
    const fromDetails = (details as Record<string, unknown>).childSessionKey
    if (typeof fromDetails === 'string' && fromDetails.includes(':subagent:')) return fromDetails
  }
  return null
}

function extractChildSessionKeyFromText(rawText: unknown): string | null {
  if (typeof rawText !== 'string' || !rawText.trim()) return null
  try {
    const parsed = JSON.parse(rawText)
    return extractChildSessionKeyFromPayload(parsed)
  } catch {
    const match = rawText.match(/agent:[^:\s]+:subagent:[a-f0-9-]+/i)
    return match ? match[0] : null
  }
}

function extractChildSessionKeyFromToolResultMessage(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null
  const msg = message as Record<string, unknown>
  const fromPayload = extractChildSessionKeyFromPayload(msg)
  if (fromPayload) return fromPayload

  const content = msg.content
  if (!Array.isArray(content)) return null
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const text = (block as Record<string, unknown>).text
    const fromText = extractChildSessionKeyFromText(text)
    if (fromText) return fromText
  }
  return null
}

function getSubagentSessionIdFromKey(sessionKey: string): string | null {
  const idx = sessionKey.indexOf(':subagent:')
  if (idx < 0) return null
  const sessionId = sessionKey.slice(idx + ':subagent:'.length).trim()
  return sessionId || null
}

function resolveSubagentSessionId(
  childSessionKey: string,
  sessionsIndex?: SessionsIndex,
): string | null {
  const fromIndex = sessionsIndex?.[childSessionKey]?.sessionId
  if (typeof fromIndex === 'string' && fromIndex.trim()) return fromIndex.trim()
  return getSubagentSessionIdFromKey(childSessionKey)
}

async function parseSubagentActivityEvents(
  agentSessionsDir: string,
  childSessionKey: string,
  sessionsIndex?: SessionsIndex,
): Promise<SubagentActivityEvent[]> {
  const sessionId = resolveSubagentSessionId(childSessionKey, sessionsIndex)
  if (!sessionId) return []
  const transcriptPath = path.join(agentSessionsDir, `${sessionId}.jsonl`)
  if (!existsSync(transcriptPath)) return []

  try {
    const content = await readTextTail(transcriptPath, 128 * 1024)
    const lines = content.split('\n').filter(l => l.trim())
    const events: SubagentActivityEvent[] = []
    for (let i = 0; i < lines.length; i++) {
      let record: any
      try {
        record = JSON.parse(lines[i])
      } catch {
        continue
      }
      if (record?.type !== 'message' || !record?.message) continue
      const at = parseRecordTimestamp(record)
      const msg = record.message
      const role = typeof msg.role === 'string' ? msg.role : ''
      const blocks = Array.isArray(msg.content) ? msg.content : []
      if (role === 'assistant') {
        for (let bi = 0; bi < blocks.length; bi++) {
          const block = blocks[bi]
          if (!block || typeof block !== 'object') continue
          const b = block as Record<string, unknown>

          if ((b.type === 'toolCall' || b.type === 'tool_use') && typeof b.name === 'string' && b.name) {
            events.push({
              key: `${record.id || i}:tool:${b.id || bi}`,
              text: `tool: ${b.name}`,
              at,
            })
            continue
          }

          if (b.type === 'text') {
            const normalized = normalizeActivityText(b.text)
            if (!normalized) continue
            events.push({
              key: `${record.id || i}:msg:${bi}`,
              text: normalized,
              at,
            })
          }
        }
        continue
      }

      if (role === 'toolResult') {
        const toolName = typeof msg.toolName === 'string' ? msg.toolName.trim() : ''
        const details = (msg.details && typeof msg.details === 'object')
          ? (msg.details as Record<string, unknown>)
          : null
        const status = typeof details?.status === 'string' ? details.status : ''
        if (toolName) {
          const statusTail = status ? ` (${status})` : ''
          events.push({
            key: `${record.id || i}:result:${msg.toolCallId || ''}`,
            text: `result: ${toolName}${statusTail}`,
            at,
          })
        }
        for (let bi = 0; bi < blocks.length; bi++) {
          const block = blocks[bi]
          if (!block || typeof block !== 'object') continue
          const normalized = normalizeActivityText((block as Record<string, unknown>).text)
          if (!normalized) continue
          events.push({
            key: `${record.id || i}:result-text:${bi}`,
            text: normalized,
            at,
          })
        }
        continue
      }

      if (role === 'user') {
        for (let bi = 0; bi < blocks.length; bi++) {
          const block = blocks[bi]
          if (!block || typeof block !== 'object') continue
          const normalized = normalizeActivityText((block as Record<string, unknown>).text)
          if (!normalized) continue
          events.push({
            key: `${record.id || i}:user:${bi}`,
            text: `task: ${normalized}`,
            at,
          })
        }
      }
    }

    events.sort((a, b) => a.at - b.at)
    const deduped: SubagentActivityEvent[] = []
    const recentTextAt = new Map<string, number>()
    for (const event of events) {
      const lastAt = recentTextAt.get(event.text)
      // Skip near-duplicate text emitted within 1.5s from the same subagent timeline.
      if (typeof lastAt === 'number' && Math.abs(event.at - lastAt) <= 1500) continue
      recentTextAt.set(event.text, event.at)
      deduped.push(event)
    }
    return deduped.slice(-SUBAGENT_ACTIVITY_EVENT_LIMIT)
  } catch {
    return []
  }
}

async function parseSubagentsFromSessionFile(
  agentSessionsDir: string,
  filePath: string,
  sessionKey: string,
  sessionsIndex?: SessionsIndex,
): Promise<SubagentInfo[]> {
  const subagents: SubagentInfo[] = []
  try {
    const content = await readTextTail(filePath, 512 * 1024)
    const lines = content.split('\n').filter(l => l.trim())

    const activeSubtasks = new Map<string, { label: string; at: number; childSessionKey?: string; acceptedAt?: number }>()
    const spawnToolIds = new Set<string>()
    /** toolIds whose spawn was accepted and are awaiting a text response from parent */
    const pendingResponseIds = new Set<string>()

    for (const line of lines) {
      try {
        const record = JSON.parse(line)
        const eventAt = parseRecordTimestamp(record)

        // Legacy format
        if (record.type === 'assistant' && record.message?.content) {
          const blocks = Array.isArray(record.message.content) ? record.message.content : []
          for (const block of blocks) {
            if (block.type === 'text' && typeof block.text === 'string') {
              const finishedId = extractFinishedSubagentId(block.text)
              if (finishedId) { removeFinishedSubagentById(finishedId, activeSubtasks); pendingResponseIds.clear() }
              if (pendingResponseIds.size > 0) {
                for (const id of pendingResponseIds) activeSubtasks.delete(id)
                pendingResponseIds.clear()
              }
              continue
            }
            if (block.type !== 'tool_use' || typeof block.id !== 'string' || !block.id) continue
            if (typeof block.name === 'string' && isSpawnTool(block.name)) {
              activeSubtasks.set(block.id, { label: pickSubagentLabel(block.input), at: eventAt })
              spawnToolIds.add(block.id)
              continue
            }
            if (typeof block.input?.description === 'string' && isSubtaskDescription(block.input.description)) {
              activeSubtasks.set(block.id, { label: block.input.description, at: eventAt })
            }
          }
        }
        if (record.type === 'user' && record.message?.content) {
          const blocks = Array.isArray(record.message.content) ? record.message.content : []
          for (const block of blocks) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              if (spawnToolIds.has(block.tool_use_id)) {
                const childSessionKey = extractChildSessionKeyFromToolResultMessage(block)
                if (childSessionKey && activeSubtasks.has(block.tool_use_id)) {
                  const prev = activeSubtasks.get(block.tool_use_id)!
                  activeSubtasks.set(block.tool_use_id, { ...prev, childSessionKey })
                }
                continue
              }
              activeSubtasks.delete(block.tool_use_id)
            }
          }
        }

        // New format
        if (record.type === 'message' && record.message) {
          const msg = record.message
          const role = typeof msg.role === 'string' ? msg.role : ''
          const blocks = Array.isArray(msg.content) ? msg.content : []
          if (role === 'assistant') {
            for (const block of blocks) {
              // Check text blocks for completion signals
              if (block?.type === 'text' && typeof block.text === 'string') {
                // Pattern 1: "✅ Subagent {agentId} finished"
                const finishedId = extractFinishedSubagentId(block.text)
                if (finishedId) { removeFinishedSubagentById(finishedId, activeSubtasks); pendingResponseIds.clear() }
                // Pattern 2: any assistant text reply clears spawns that were awaiting a response
                // (handles custom responses like "✅ 已叫起 agentdev！", "起來了！", etc.)
                if (pendingResponseIds.size > 0) {
                  for (const id of pendingResponseIds) activeSubtasks.delete(id)
                  pendingResponseIds.clear()
                }
                continue
              }
              if (block?.type === 'toolCall' && typeof block.id === 'string' && block.id) {
                if (typeof block.name === 'string' && isSpawnTool(block.name)) {
                  activeSubtasks.set(block.id, { label: pickSubagentLabel(block.arguments), at: eventAt })
                  spawnToolIds.add(block.id)
                } else if (typeof block.arguments?.description === 'string' && isSubtaskDescription(block.arguments.description)) {
                  activeSubtasks.set(block.id, { label: block.arguments.description, at: eventAt })
                }
              } else if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.input?.description === 'string') {
                if (isSubtaskDescription(block.input.description)) activeSubtasks.set(block.id, { label: block.input.description, at: eventAt })
              }
            }
          } else if (role === 'toolResult') {
            const toolCallId = typeof msg.toolCallId === 'string' ? msg.toolCallId : ''
            const toolName = typeof msg.toolName === 'string' ? msg.toolName : ''
            if (toolCallId && spawnToolIds.has(toolCallId)) {
              const childSessionKey = extractChildSessionKeyFromToolResultMessage(msg)
              if (activeSubtasks.has(toolCallId)) {
                const prev = activeSubtasks.get(toolCallId)!
                activeSubtasks.set(toolCallId, { ...prev, childSessionKey: childSessionKey || prev.childSessionKey, acceptedAt: eventAt })
                pendingResponseIds.add(toolCallId)
              }
              continue
            }
            if (toolCallId && !isSpawnTool(toolName) && !spawnToolIds.has(toolCallId)) {
              activeSubtasks.delete(toolCallId)
            }
          } else if (role === 'user') {
            const text = blocks
              .map((b: { type?: string; text?: string }) => (b?.type === 'text' && typeof b.text === 'string') ? b.text : '')
              .join('\n')
            const completedLabel = extractCompletedSubagentLabel(text)
            if (completedLabel) {
              for (const [id, state] of activeSubtasks.entries()) {
                if (state.label === completedLabel || state.label.includes(completedLabel) || completedLabel.includes(state.label)) {
                  activeSubtasks.delete(id)
                  break
                }
              }
            }
          }
        }
      } catch {
        // Skip bad line
      }
    }

    const now = Date.now()
    const SPAWN_ACCEPTED_TIMEOUT_MS = 3 * 60 * 1000 // 3 min after spawn accepted — fallback
    for (const [toolId, state] of activeSubtasks.entries()) {
      if (state.at > 0 && now - state.at > SUBAGENT_MAX_ACTIVE_MS) continue
      if (state.acceptedAt && now - state.acceptedAt > SPAWN_ACCEPTED_TIMEOUT_MS) continue
      const label = state.label
      let activityEvents: SubagentActivityEvent[] | undefined
      if (state.childSessionKey) {
        activityEvents = await parseSubagentActivityEvents(agentSessionsDir, state.childSessionKey, sessionsIndex)
      }
      subagents.push({
        toolId,
        label,
        sessionKey,
        childSessionKey: state.childSessionKey,
        activityEvents: activityEvents && activityEvents.length > 0 ? activityEvents : undefined,
      })
    }
  } catch {
    // Ignore parse errors
  }
  return subagents
}

/** Parse subagents from all parent sessions (main/direct/group/openai/cron etc.), grouped by session */
async function parseSubagents(agentSessionsDir: string, agentId: string): Promise<SubagentInfo[]> {
  const allSubagents: SubagentInfo[] = []
  try {
    const cutoff = Date.now() - SESSION_LOOKBACK_MS
    const sessionFiles: Array<{ sessionKey: string; filePath: string; updatedAt: number }> = []
    const knownFilePaths = new Set<string>()
    const subagentSessionIds = new Set<string>()
    let sessionsIndex: SessionsIndex = {}
    const sessionsIndexPath = path.join(agentSessionsDir, 'sessions.json')
    if (existsSync(sessionsIndexPath)) {
      try {
        const sessionsIndexRaw = await fs.readFile(sessionsIndexPath, 'utf8')
        sessionsIndex = JSON.parse(sessionsIndexRaw) as SessionsIndex
        for (const [sessionKey, meta] of Object.entries(sessionsIndex)) {
          if (!meta || typeof meta.sessionId !== 'string' || !meta.sessionId) continue
          if (sessionKey.includes(':subagent:')) {
            subagentSessionIds.add(meta.sessionId)
            continue
          }
          const filePath = path.join(agentSessionsDir, `${meta.sessionId}.jsonl`)
          if (!existsSync(filePath)) continue
          let updatedAt = 0
          if (typeof meta.updatedAt === 'number' && meta.updatedAt > 0) {
            updatedAt = meta.updatedAt
          } else {
            try {
              const stat = await fs.stat(filePath)
              updatedAt = stat.mtimeMs
            } catch {
              updatedAt = 0
            }
          }
          if (updatedAt > 0 && updatedAt < cutoff) continue
          sessionFiles.push({ sessionKey, filePath, updatedAt })
          knownFilePaths.add(filePath)
        }
      } catch {
        // Ignore index parse errors
      }
    }

    // Fallback: include recent parent session files that are missing in sessions.json mapping.
    try {
      const orphanCutoff = Date.now() - ORPHAN_FALLBACK_WINDOW_MS
      const files = await fs.readdir(agentSessionsDir)
      for (const file of files) {
        if (!/\.jsonl(?:\.reset\..*)?$/.test(file) || file.includes('.deleted.')) continue
        if (file.startsWith('probe-')) continue
        const filePath = path.join(agentSessionsDir, file)
        if (knownFilePaths.has(filePath)) continue
        const sessionId = file.slice(0, -'.jsonl'.length)
        if (subagentSessionIds.has(sessionId)) continue
        const stat = await fs.stat(filePath)
        if (stat.mtimeMs < orphanCutoff) continue
        if (stat.mtimeMs < cutoff) continue
        sessionFiles.push({
          sessionKey: `agent:${agentId}:orphan:${sessionId}`,
          filePath,
          updatedAt: stat.mtimeMs,
        })
      }
    } catch {
      // Ignore fallback scan errors
    }

    sessionFiles.sort((a, b) => b.updatedAt - a.updatedAt)
    const candidates = sessionFiles.slice(0, MAX_PARENT_SESSIONS_TO_PARSE)
    const nested = await Promise.all(candidates.map((s) => parseSubagentsFromSessionFile(agentSessionsDir, s.filePath, s.sessionKey, sessionsIndex)))
    const dedupe = new Set<string>()
    for (const list of nested) {
      for (const sub of list) {
        const key = `${sub.sessionKey || ''}::${sub.toolId}`
        if (dedupe.has(key)) continue
        dedupe.add(key)
        allSubagents.push(sub)
      }
    }
  } catch {
    // Ignore parse errors
  }
  return allSubagents
}

async function parseCronJobs(agentSessionsDir: string, cronJobsForAgent: CronStoreJob[]): Promise<CronJobInfo[]> {
  if (cronJobsForAgent.length === 0) return []

  // The cron store is authoritative. A job must be shown even before its
  // first run, so sessions.json is only optional enrichment for run details.
  let sessionsIndex: Record<string, any> = {}
  if (agentSessionsDir) {
    const sessionsIndexPath = path.join(agentSessionsDir, 'sessions.json')
    if (existsSync(sessionsIndexPath)) {
      try {
        sessionsIndex = JSON.parse(await fs.readFile(sessionsIndexPath, 'utf8')) as Record<string, any>
      } catch {
        // A missing/corrupt session index must not hide registered cron jobs.
        sessionsIndex = {}
      }
    }
  }

  const cronJobs: CronJobInfo[] = []

  for (const job of cronJobsForAgent) {
    // 一次性任务（schedule.kind === "at"）不做统计：仅保留长期循环任务
    const scheduleKind = typeof (job as any)?.schedule?.kind === 'string' ? (job as any).schedule.kind : ''
    if (scheduleKind === 'at') continue

    const entries = Object.entries(sessionsIndex)
      .filter(([sessionKey, meta]) => sessionKey.includes(`:cron:${job.id}`) && meta && typeof (meta as any).sessionId === 'string')
      .map(([sessionKey, meta]) => ({
        sessionKey,
        sessionId: (meta as any).sessionId as string,
        updatedAt: typeof (meta as any).updatedAt === 'number' ? (meta as any).updatedAt : 0,
        label: typeof (meta as any).label === 'string' ? (meta as any).label : undefined,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)

    const latest = entries[0]
    let transcriptStatus: ReturnType<typeof inferCronStatusFromTranscript> | null = null

    if (latest) {
      const transcriptPath = path.join(agentSessionsDir, `${latest.sessionId}.jsonl`)
      if (existsSync(transcriptPath)) {
        const transcript = await readTextTail(transcriptPath, 256 * 1024)
        transcriptStatus = inferCronStatusFromTranscript(transcript.split('\n').filter((line) => line.trim()), latest.updatedAt)
      }
    }

    const fallbackLabel = latest?.sessionKey?.split(':cron:')[1] || job.id
    const state = job.state || {}
    cronJobs.push({
      key: latest?.sessionKey?.includes(':run:') ? latest.sessionKey.split(':run:')[0] : latest?.sessionKey || `agent:${inferCronOwnerAgentId(job)}:cron:${job.id}`,
      jobId: job.id,
      label: normalizeCronLabel(job.name || latest?.label, fallbackLabel),
      isRunning: transcriptStatus?.isRunning || mapCronStatus(state.lastStatus) === 'running',
      lastRunAt: typeof state.lastRunAtMs === 'number' ? state.lastRunAtMs : latest?.updatedAt || 0,
      nextRunAt: typeof state.nextRunAtMs === 'number' ? state.nextRunAtMs : undefined,
      durationMs: typeof state.lastDurationMs === 'number' ? state.lastDurationMs : transcriptStatus?.durationMs,
      lastStatus: transcriptStatus?.lastStatus || mapCronStatus(state.lastStatus),
      lastSummary: transcriptStatus?.lastSummary || deriveCronSummaryFromJob(job),
      consecutiveFailures: typeof state.consecutiveErrors === 'number' ? state.consecutiveErrors : 0,
      enabled: job.enabled !== false,
    })
  }

  cronJobs.sort((a, b) => b.lastRunAt - a.lastRunAt)
  return cronJobs
}


/**
 * Extract the actual user-typed text from a session message block.
 *
 * Handles three formats:
 * 1. Subagent spawn: contains "[Subagent Task]: ..." — extract what follows the label
 * 2. Channel message (Telegram etc.): injected "Conversation info" + "Sender" code fences
 *    before the real text — extract what comes after the last ``` fence
 * 3. Fallback: strip XML context blocks and leading timestamp
 */
function extractUserText(rawText: string): string | null {
  // Strip XML context injections first (relevant-memories etc.)
  const noXml = rawText.replace(/<[a-z][\s\S]*?<\/[a-z][^>]*>/gi, '')

  // Strategy 1: subagent task — "[Subagent Task]: ..."
  const subagentMatch = noXml.match(/\[Subagent Task\]:\s*([\s\S]+)/)
  if (subagentMatch) {
    return subagentMatch[1].replace(/\s+/g, ' ').trim().slice(0, 500)
  }

  // Strategy 2: channel message — text after last ``` fence
  const lastFence = rawText.lastIndexOf('```')
  if (lastFence !== -1) {
    const afterFence = rawText.slice(lastFence + 3).trim()
    if (afterFence.length > 3) {
      return afterFence.replace(/\s+/g, ' ').trim().slice(0, 500)
    }
  }

  // Strategy 3: strip timestamp prefix and return remaining
  const noTs = noXml.replace(/^\[[^\]]{5,40}\]\s*/, '').trim()
  const text = noTs.replace(/\s+/g, ' ').trim()
  return text.length > 5 ? text.slice(0, 500) : null
}

/**
 * Extract the last user message text from a session file — used as the agent's "last task".
 *
 * Priority:
 * 1. The original subagent spawn task ("[Subagent Task]: ...") — scan from the start
 * 2. Most recent real user message — scan from the end, skip system notifications
 */
async function extractLastUserTask(sessionFilePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(sessionFilePath, 'utf8')
    const allLines = content.split('\n').filter(l => l.trim())

    // Pass 1: find the first [Subagent Task] (set at spawn time, stable throughout session)
    for (const line of allLines.slice(0, 40)) {
      try {
        const record = JSON.parse(line)
        if (record.type !== 'message' || !record.message) continue
        if (record.message.role !== 'user') continue
        const blocks = Array.isArray(record.message.content) ? record.message.content : []
        for (const block of blocks) {
          if (block?.type !== 'text' || typeof block.text !== 'string') continue
          if (!block.text.includes('[Subagent Task]')) continue
          const text = extractUserText(block.text)
          if (text) return text
        }
      } catch { /* skip */ }
    }

    // Pass 2: most recent real user message (direct agents, e.g. main)
    const skipPhrases = ['A completed subagent task', 'Action:\n', 'END_UNTRUSTED_CHILD_RESULT', 'Continue where you left off']
    const recent = allLines.slice(-80)
    for (let i = recent.length - 1; i >= 0; i--) {
      try {
        const record = JSON.parse(recent[i])
        if (record.type !== 'message' || !record.message) continue
        if (record.message.role !== 'user') continue
        const blocks = Array.isArray(record.message.content) ? record.message.content : []
        for (const block of blocks) {
          if (block?.type !== 'text' || typeof block.text !== 'string') continue
          if (skipPhrases.some(p => block.text.includes(p))) continue
          const text = extractUserText(block.text)
          if (text) return text
        }
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }
  return null
}

/**
 * Read last N lines of a JSONL session file and determine the agent's true working state.
 *
 * Logic:
 *  - Last message role is 'toolResult'  → working (parent about to process tool output)
 *  - Last assistant stopReason is 'toolUse' → working (tool call in flight)
 *  - Last assistant stopReason is 'stop'   → idle (turn completed, waiting for next input)
 *  - Fallback: time-based heuristic
 */
async function detectStateFromSession(
  sessionFilePath: string,
  now: number,
  lastActive: number,
): Promise<'idle' | 'working' | 'offline'> {
  if (lastActive === 0) return 'offline'

  const OFFLINE_MS = 10 * 60 * 1000   // idle > 10 min → offline
  const WORKING_MAX_MS = 10 * 60 * 1000 // working > 10 min → force idle
  const timeDiff = now - lastActive

  // Last activity > 10 min ago → offline regardless of session content
  if (timeDiff > OFFLINE_MS) return 'offline'

  try {
    const content = await fs.readFile(sessionFilePath, 'utf8')
    const lines = content.split('\n').filter(l => l.trim()).slice(-50)

    let lastRole: string | null = null
    let lastStopReason: string | null = null

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const record = JSON.parse(lines[i])
        if (record.type !== 'message' || !record.message) continue
        const { role, stopReason } = record.message
        if (!lastRole) lastRole = role ?? null
        if (role === 'assistant') {
          lastStopReason = stopReason ?? null
          break
        }
      } catch { /* skip malformed line */ }
    }

    // Work completed → idle ONLY if the last message itself was the assistant finishing
    if (lastRole === 'assistant' && lastStopReason === 'stop') return 'idle'
    // New user/tool message after assistant stop, or tool call in flight → working
    if (lastRole === 'user' || lastRole === 'toolResult' || lastStopReason === 'toolUse') {
      return timeDiff <= WORKING_MAX_MS ? 'working' : 'idle'
    }
    // assistant with no stopReason = mid-generation (streaming), treat as working
    if (lastRole === 'assistant' && !lastStopReason) {
      return timeDiff <= WORKING_MAX_MS ? 'working' : 'idle'
    }
  } catch { /* file unreadable — fall through */ }

  // Fallback within the 10-min window
  return timeDiff <= 2 * 60 * 1000 ? 'working' : 'idle'
}

async function loadInstanceAgentActivity(
  instance: LoadedOpenClawInstance,
  childClaimedAgentIds: Set<string>,
): Promise<AgentActivity[]> {
  const { configPath, agentsDir, config } = instance
  const agents: AgentActivity[] = []

  try {
    if (existsSync(configPath)) {
      let agentList = await loadAgentList(config, agentsDir)
      if (instance.isPrimary && configuredAgentEntries(config).length === 0) {
        agentList = agentList.filter((agent) => agent.id === 'main' || !childClaimedAgentIds.has(agent.id))
      }
      const liveCronJobs = await loadCronJobs(instance)
      for (const job of liveCronJobs) {
        const ownerId = inferCronOwnerAgentId(job)
        if (!agentList.some((agent) => agent.id === ownerId)) agentList.push({ id: ownerId })
      }
      if (agentList.length > 0) {
        const now = Date.now()

        for (const agent of agentList) {
          let lastActive = 0
          let mostRecentSessionFile: string | null = null
          let agentSessionsDir = ''
          const sqliteActivity = await readSqliteActivity(agentsDir, agent.id)
          lastActive = sqliteActivity.lastActive

          // Resolve emoji: IDENTITY.md > agent.json > openclaw.json > default
          let agentJsonEmoji: string | undefined
          if (existsSync(agentsDir)) {
            // 1. Read from workspace IDENTITY.md ("- **Emoji:** 🌸")
            const workspaceDir = typeof (agent as any).workspace === 'string' ? (agent as any).workspace : null
            if (workspaceDir) {
              const identityPath = path.join(workspaceDir, 'IDENTITY.md')
              if (existsSync(identityPath)) {
                try {
                  const identityRaw = await fs.readFile(identityPath, 'utf8')
                  const emojiLine = identityRaw.split(/\r?\n/).find((line) => /\*\*Emoji:\*\*/.test(line))
                  const m = emojiLine?.match(/\*\*Emoji:\*\*\s*(.*)$/)
                  if (m) {
                    const emoji = normalizeIdentityEmoji(m[1])
                    if (emoji) agentJsonEmoji = emoji
                  }
                } catch { /* ignore */ }
              }
            }
            // 2. Fallback: read from agent's agent.json emoji field
            if (!agentJsonEmoji) {
              const agentJsonPath = path.join(agentsDir, agent.id, 'agent', 'agent.json')
              if (existsSync(agentJsonPath)) {
                try {
                  const raw = await fs.readFile(agentJsonPath, 'utf8')
                  const parsed = JSON.parse(raw)
                  const emoji = normalizeIdentityEmoji(parsed?.emoji)
                  if (emoji) {
                    agentJsonEmoji = emoji
                  }
                } catch { /* ignore */ }
              }
            }
          }

          const instanceSessionsDir = path.join(agentsDir, agent.id, 'sessions')
          const sharedSessionsDir = path.join(OPENCLAW_AGENTS_DIR, agent.id, 'sessions')
          agentSessionsDir = existsSync(instanceSessionsDir)
            ? instanceSessionsDir
            : existsSync(sharedSessionsDir)
              ? sharedSessionsDir
              : instanceSessionsDir
          if (existsSync(agentSessionsDir)) {
              // Use JSONL file mtime for lastActive (reliable, updates on every message write).
              // Also build a map from sessionId → filePath using sessions.json, so we can
              // pick the correct file for content-based state detection.
              const sessionIdToFile = new Map<string, string>()
              try {
                const sessionsIndexPath = path.join(agentSessionsDir, 'sessions.json')
                if (existsSync(sessionsIndexPath)) {
                  const raw = await fs.readFile(sessionsIndexPath, 'utf8')
                  const index = JSON.parse(raw) as Record<string, { sessionId?: string }>
                  for (const [, meta] of Object.entries(index)) {
                    if (typeof meta.sessionId === 'string') {
                      sessionIdToFile.set(meta.sessionId, path.join(agentSessionsDir, `${meta.sessionId}.jsonl`))
                    }
                  }
                }
              } catch { /* ignore */ }

              try {
                const files = await fs.readdir(agentSessionsDir)
                for (const file of files) {
                  if (!/\.jsonl(?:\.reset\..*)?$/.test(file) || file.includes('.deleted.')) continue
                  const filePath = path.join(agentSessionsDir, file)
                  const stat = await fs.stat(filePath)
                  if (stat.mtimeMs > lastActive) {
                    lastActive = stat.mtimeMs
                    mostRecentSessionFile = filePath
                  }
                }
              } catch { /* ignore */ }

              // If the most-recent .jsonl is not in sessions.json, keep it when it's
              // recent (< 5 min) — it may be a brand-new session not yet indexed.
              // Only fall back to the sessions.json-indexed file when the un-indexed
              // file is stale, to avoid reading probe/temp files from old runs.
              if (mostRecentSessionFile) {
                const sessionId = path.basename(mostRecentSessionFile, '.jsonl')
                if (!sessionIdToFile.has(sessionId)) {
                  const unindexedAge = now - lastActive
                  if (unindexedAge > 5 * 60 * 1000) {
                    // Stale un-indexed file — prefer the best sessions.json entry
                    let bestMtime = 0
                    for (const [, fp] of sessionIdToFile) {
                      try {
                        const s = await fs.stat(fp)
                        if (s.mtimeMs > bestMtime) {
                          bestMtime = s.mtimeMs
                          mostRecentSessionFile = fp
                        }
                      } catch { /* ignore */ }
                    }
                    if (bestMtime > 0) lastActive = bestMtime
                  }
                  // else: keep the un-indexed file — it's a fresh active session
                }
              }
          }

          // Determine state from session content (falls back to time-based)
          let state: 'idle' | 'working' | 'waiting' | 'offline'
          if (mostRecentSessionFile && existsSync(mostRecentSessionFile)) {
            state = await detectStateFromSession(mostRecentSessionFile, now, lastActive)
          } else {
            const timeDiff = now - lastActive
            if (lastActive === 0 || timeDiff > 10 * 60 * 1000) state = 'offline'
            else if (timeDiff <= 2 * 60 * 1000) state = 'working'
            else state = 'idle'
          }
          if (sqliteActivity.running > 0 && lastActive > 0 && now - lastActive <= 15 * 60 * 1000) {
            state = 'working'
          }

          // Parse subagents for online agents
          let subagents: SubagentInfo[] | undefined
          let cronJobs: CronJobInfo[] | undefined
          if (state !== 'offline' && agentSessionsDir && existsSync(agentSessionsDir)) {
            subagents = await parseSubagents(agentSessionsDir, agent.id)
            if (subagents.length === 0) subagents = undefined
          }

          // Cron jobs come from the scheduler registry, not from whether a
          // :cron:<jobId> session has already been created. This keeps newly
          // registered jobs visible and supports dashboard/current-session
          // bindings as well as isolated cron bindings.
          cronJobs = await parseCronJobs(
            agentSessionsDir,
            liveCronJobs.filter((job) => inferCronOwnerAgentId(job) === agent.id),
          )
          if (cronJobs.length === 0) cronJobs = undefined

          // Extract last user task for working agents
          let lastTask: string | undefined
          if (state === 'working' && mostRecentSessionFile && existsSync(mostRecentSessionFile)) {
            lastTask = (await extractLastUserTask(mostRecentSessionFile)) ?? undefined
          }

          agents.push({
            activityKey: `${instance.id}:${agent.id}`,
            instanceId: instance.id,
            instanceName: instance.name,
            agentId: agent.id,
            name: agent.name || agent.id,
            emoji: agentJsonEmoji || normalizeIdentityEmoji(agent.identity?.emoji) || normalizeIdentityEmoji(agent.emoji) || '🤖',
            state,
            lastActive,
            subagents,
            cronJobs,
            lastTask,
          })
        }
      }
    }
  } catch (error) {
    console.error(`Error reading agent activity for OpenClaw instance ${instance.id}:`, error)
  }

  return agents
}

async function collectAgentActivity(request: Request) {
  const includeInstances = new URL(request.url).searchParams.get('includeInstances') === '1'
  const discovered = await discoverOpenClawInstances(includeInstances)
  const loaded = (await Promise.all(discovered.map(async (instance): Promise<LoadedOpenClawInstance | null> => {
    try {
      if (!existsSync(instance.configPath)) return null
      const configContent = await fs.readFile(instance.configPath, 'utf8')
      return { ...instance, config: parseJsonText(configContent) }
    } catch (error) {
      console.error(`Failed to read OpenClaw instance config ${instance.id}:`, error)
      return null
    }
  }))).filter((instance): instance is LoadedOpenClawInstance => instance !== null)

  const childClaimedAgentIds = new Set<string>()
  for (const instance of loaded) {
    if (instance.isPrimary || !Array.isArray(instance.config?.agents?.list)) continue
    for (const agent of instance.config.agents.list) {
      if (agent && typeof agent.id === 'string' && agent.id && agent.id !== 'main') {
        childClaimedAgentIds.add(agent.id)
      }
    }
  }

  const nestedAgents = await Promise.all(
    loaded.map((instance) => loadInstanceAgentActivity(instance, childClaimedAgentIds)),
  )
  const agents = nestedAgents.flat()

  // 返回纯数据对象（而非 NextResponse），供 SWR 缓存层包装
  return { agents }
}

// ===== SWR 响应缓存：立即返回缓存数据，过期后由单个后台任务刷新（单飞去重） =====
// 浏览器刷新/多标签轮询不再各自触发重计算，杜绝请求堆积导致的进程卡死。
const ACTIVITY_CACHE_TTL_MS = 60_000
const ACTIVITY_RECOMPUTE_MIN_MS = 10_000
const ACTIVITY_HARD_BUDGET_MS = 180_000
let activityCache: { data: any; ts: number } | null = loadDiskCache<any>('agent-activity')
let activityRecomputing = false
let activityRecomputeStartedAt = 0

export async function GET(request: Request) {
  const cached = activityCache
  const fresh = !!cached && Date.now() - cached.ts < ACTIVITY_CACHE_TTL_MS

  // 有旧缓存且已过期：立即返回旧数据，后台单飞刷新
  if (cached && !fresh) {
    const stuck = activityRecomputing && Date.now() - activityRecomputeStartedAt > ACTIVITY_HARD_BUDGET_MS
    if (!activityRecomputing || stuck) {
      activityRecomputing = true
      activityRecomputeStartedAt = Date.now()
      collectAgentActivity(request)
        .then((data) => { const entry = { data, ts: Date.now() }; activityCache = entry; saveDiskCache('agent-activity', entry) })
        .catch((err) => console.error('agent-activity background refresh failed:', err))
        .finally(() => { activityRecomputing = false })
    }
    return NextResponse.json(
      cached.data,
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' } },
    )
  }

  // 冷启动（无缓存）：同步计算一次
  if (!cached) {
    const data = await collectAgentActivity(request)
    const entry = { data, ts: Date.now() }
    activityCache = entry
    saveDiskCache('agent-activity', entry)
    return NextResponse.json(
      data,
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' } },
    )
  }

  return NextResponse.json(
    cached.data,
    { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' } },
  )
}
