import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { clearConfigCache } from "@/lib/config-cache";
import { clearDiskCache } from "@/lib/disk-cache";
import { callOpenclawGateway, resolveConfigSnapshotHash } from "@/lib/openclaw-cli";
import { getOpenClawInstance, type OpenClawInstance } from "@/lib/openclaw-instances";

const GATEWAY_CALL_TIMEOUT_MS = 15000;
const GATEWAY_RECOVERY_TIMEOUT_MS = 45000;
const GATEWAY_RECOVERY_POLL_MS = 1000;

type ConfigSnapshot = {
  valid?: boolean;
  hash?: string;
  raw?: string | null;
  config?: any;
};

const SESSION_MODEL_FIELDS_TO_CLEAR = [
  "providerOverride",
  "modelOverride",
  "authProfileOverride",
  "authProfileOverrideSource",
  "authProfileOverrideCompactionCount",
  "fallbackNoticeSelectedModel",
  "fallbackNoticeActiveModel",
  "fallbackNoticeReason",
  "claudeCliSessionId",
  "modelProvider",
  "model",
] as const;

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapGatewayResult<T>(payload: any): T {
  if (isPlainObject(payload) && "result" in payload) {
    return payload.result as T;
  }
  return payload as T;
}

function normalizeErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  return "Unknown error";
}

function statusForError(message: string): number {
  const lower = message.toLowerCase();
  if (lower.includes("config changed since last load")) return 409;
  if (lower.includes("missing") || lower.includes("invalid") || lower.includes("not found") || lower.includes("must")) return 400;
  if (
    lower.includes("gateway closed") ||
    lower.includes("timeout") ||
    lower.includes("econn") ||
    lower.includes("not running") ||
    lower.includes("abnormal closure")
  ) {
    return 503;
  }
  return 500;
}

function findAgentConfigEntry(config: any, agentId: string): Record<string, any> | null {
  // 网关 Schema：per-agent 配置在 agents.entries.<agentId>；agents.list 不是合法键（会被 config 校验拒绝）
  const entries = isPlainObject(config?.agents?.entries) ? config.agents.entries : null;
  if (entries && isPlainObject(entries[agentId])) return entries[agentId];
  const agentList = Array.isArray(config?.agents?.list) ? config.agents.list : null;
  if (agentList) {
    const entry = agentList.find((agent: any) => agent && agent.id === agentId);
    if (isPlainObject(entry)) return entry;
  }
  return null;
}

function addModelRef(set: Set<string>, value: unknown): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (!trimmed || !trimmed.includes("/")) return;
  set.add(trimmed);
}

function collectKnownModels(config: any): Set<string> {
  const models = new Set<string>();

  const providers = isPlainObject(config?.models?.providers) ? config.models.providers : {};
  for (const [providerId, provider] of Object.entries(providers)) {
    const providerModels = Array.isArray((provider as any)?.models) ? (provider as any).models : [];
    for (const model of providerModels) {
      addModelRef(models, `${providerId}/${model?.id ?? ""}`);
    }
  }

  const defaultsModel = config?.agents?.defaults?.model;
  if (typeof defaultsModel === "string") {
    addModelRef(models, defaultsModel);
  } else if (isPlainObject(defaultsModel)) {
    addModelRef(models, defaultsModel.primary);
    const fallbacks = Array.isArray(defaultsModel.fallbacks) ? defaultsModel.fallbacks : [];
    for (const fallback of fallbacks) addModelRef(models, fallback);
  }

  const defaultsModels = isPlainObject(config?.agents?.defaults?.models) ? config.agents.defaults.models : {};
  for (const modelKey of Object.keys(defaultsModels)) {
    addModelRef(models, modelKey);
  }

  const agentList = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  for (const agent of agentList) {
    if (!agent) continue;
    addModelRef(models, agent.model);
    if (isPlainObject(agent.model)) {
      addModelRef(models, agent.model.primary);
      addModelRef(models, agent.model.default);
    }
  }

  const agentEntries = isPlainObject(config?.agents?.entries) ? config.agents.entries : {};
  for (const agent of Object.values(agentEntries)) {
    if (!isPlainObject(agent)) continue;
    addModelRef(models, agent.model);
    if (isPlainObject(agent.model)) {
      addModelRef(models, agent.model.primary);
      addModelRef(models, agent.model.default);
    }
  }

  return models;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getConfigSnapshot(instance: OpenClawInstance): Promise<ConfigSnapshot> {
  return unwrapGatewayResult<ConfigSnapshot>(
    await callOpenclawGateway("config.get", {}, GATEWAY_CALL_TIMEOUT_MS, { configPath: instance.configPath, gatewayPort: instance.gatewayPort }),
  );
}

async function waitForPatchedModel(instance: OpenClawInstance, agentId: string, model: string): Promise<void> {
  const deadline = Date.now() + GATEWAY_RECOVERY_TIMEOUT_MS;
  let lastError = "";

  while (Date.now() < deadline) {
    await sleep(GATEWAY_RECOVERY_POLL_MS);
    try {
      const snapshot = await getConfigSnapshot(instance);
      const config = snapshot?.config;
      const agentEntry = findAgentConfigEntry(config, agentId);
      const appliedModel = agentEntry?.model;
      const applied =
        (typeof appliedModel === "string" && appliedModel.trim() === model) ||
        (isPlainObject(appliedModel) && appliedModel.primary === model);
      if (applied) {
        return;
      }
    } catch (err) {
      lastError = normalizeErrorMessage(err);
    }
  }

  throw new Error(lastError || "Timed out waiting for Gateway to apply the new model");
}

function clearAgentSessionModelState(instance: OpenClawInstance, agentId: string): void {
  const sessionsPath = path.join(instance.agentsDir, agentId, "sessions", "sessions.json");
  if (!fs.existsSync(sessionsPath)) return;

  const raw = fs.readFileSync(sessionsPath, "utf8");
  const sessions = JSON.parse(raw);
  if (!isPlainObject(sessions)) return;

  let changed = false;
  for (const value of Object.values(sessions)) {
    if (!isPlainObject(value)) continue;
    for (const field of SESSION_MODEL_FIELDS_TO_CLEAR) {
      if (Object.prototype.hasOwnProperty.call(value, field)) {
        delete value[field];
        changed = true;
      }
    }
  }

  if (!changed) return;

  const tmpPath = `${sessionsPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(sessions, null, 2), "utf8");
  fs.renameSync(tmpPath, sessionsPath);
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const agentId = String(body?.agentId || "").trim();
    const model = String(body?.model || "").trim();
    const instance = getOpenClawInstance(body?.instanceId);

    if (!agentId || !model) {
      return NextResponse.json({ ok: false, error: "Missing agentId or model" }, { status: 400 });
    }

    const snapshot = await getConfigSnapshot(instance);
    if (snapshot?.valid === false || !isPlainObject(snapshot?.config)) {
      return NextResponse.json({ ok: false, error: "Gateway config is invalid or unavailable" }, { status: 400 });
    }

    const baseHash = resolveConfigSnapshotHash(snapshot);
    if (!baseHash) {
      return NextResponse.json({ ok: false, error: "Missing baseHash from config snapshot" }, { status: 500 });
    }

    const config = snapshot.config;
    const agentEntry = findAgentConfigEntry(config, agentId);
    if (!agentEntry) {
      return NextResponse.json({ ok: false, error: `Agent not found in agents.entries: ${agentId}` }, { status: 404 });
    }

    const knownModels = collectKnownModels(config);
    if (!knownModels.has(model)) {
      return NextResponse.json({ ok: false, error: `Unknown model: ${model}` }, { status: 400 });
    }

    // 网关 config Schema：per-agent 模型写在 agents.entries.<agentId>.model；
    // agents.list 不是合法键（invalid config: agents: Unrecognized key: "list"）
    // 若现值是 {primary, fallbacks} 对象：只替换 primary、保留 fallbacks（直接覆写成字符串会
    // 触发保护性拒绝 "config.patch would remove entries from array path(s)"）
    const currentModel = agentEntry?.model;
    const modelValue = isPlainObject(currentModel)
      ? { ...currentModel, primary: model }
      : model;
    const patch = {
      agents: {
        entries: {
          [agentId]: {
            model: modelValue,
          },
        },
      },
    };

    await callOpenclawGateway(
      "config.patch",
      {
        raw: JSON.stringify(patch),
        baseHash,
        note: `Dashboard updated ${agentId} model to ${model}`,
      },
      GATEWAY_CALL_TIMEOUT_MS,
      { configPath: instance.configPath, gatewayPort: instance.gatewayPort },
    );

    clearConfigCache();
    clearDiskCache("config");
    await waitForPatchedModel(instance, agentId, model);
    clearAgentSessionModelState(instance, agentId);
    clearConfigCache();
    clearDiskCache("config");

    return NextResponse.json({
      ok: true,
      agentId,
      model,
      applied: true,
      resetSessions: true,
    });
  } catch (err) {
    const error = normalizeErrorMessage(err);
    return NextResponse.json({ ok: false, error }, { status: statusForError(error) });
  }
}
