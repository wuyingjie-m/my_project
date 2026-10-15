import path from "path";
import { readJsonFileSync } from "@/lib/json";
import { OPENCLAW_CONFIG_PATH, OPENCLAW_HOME } from "@/lib/openclaw-paths";

/**
 * 最小化的 provider chat 调用：复用 model-probe 的配置读取与鉴权头逻辑，
 * 供日报总结等文本生成场景使用（与 test-model 的探活不同，这里要拿回完整文本）。
 */

interface ProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  authHeader?: boolean | string;
  headers?: Record<string, string>;
}

export interface ModelRef {
  providerId: string;
  modelId: string;
}

export function resolveDefaultModelRef(): { primary: ModelRef | null; fallbacks: ModelRef[] } {
  const toRef = (s: unknown): ModelRef | null => {
    if (typeof s !== "string" || !s.includes("/") || s === "unknown") return null;
    const [providerId, ...rest] = s.split("/");
    return providerId && rest.length ? { providerId, modelId: rest.join("/") } : null;
  };
  let primary: ModelRef | null = null;
  let fallbacks: ModelRef[] = [];
  try {
    const cfg = readJsonFileSync<any>(OPENCLAW_CONFIG_PATH);
    const m = cfg?.agents?.defaults?.model;
    if (typeof m === "string") primary = toRef(m);
    else if (m && typeof m === "object") {
      primary = toRef(m.primary);
      if (Array.isArray(m.fallbacks)) fallbacks = m.fallbacks.map(toRef).filter(Boolean) as ModelRef[];
    }
  } catch {}
  return { primary, fallbacks };
}

function pickAuthHeader(providerCfg: ProviderConfig, apiKey: string): Record<string, string> {
  const out: Record<string, string> = {};
  const authHeader = providerCfg.authHeader;
  const api = providerCfg.api;
  if (typeof authHeader === "string" && authHeader.trim()) {
    out[authHeader.trim()] = apiKey;
    return out;
  }
  if (authHeader === false) {
    out["x-api-key"] = apiKey;
    return out;
  }
  if (api === "anthropic-messages") {
    out["x-api-key"] = apiKey;
    out["Authorization"] = `Bearer ${apiKey}`;
    return out;
  }
  out["Authorization"] = `Bearer ${apiKey}`;
  return out;
}

export interface ChatCompleteParams {
  modelRef: ModelRef;
  system: string;
  user: string;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
}

export async function chatComplete(params: ChatCompleteParams): Promise<string> {
  const providers = readJsonFileSync<any>(path.join(OPENCLAW_HOME, "agents", "main", "agent", "models.json"))?.providers || {};
  const providerCfg: ProviderConfig | undefined =
    providers[params.modelRef.providerId] ||
    (Object.entries(providers).find(([k]) => k.toLowerCase() === params.modelRef.providerId.toLowerCase())?.[1] as
      | ProviderConfig
      | undefined);
  if (!providerCfg?.baseUrl || !providerCfg.apiKey) {
    throw new Error(`Provider ${params.modelRef.providerId} not configured (baseUrl/apiKey missing)`);
  }
  // OpenClaw 核心会在运行时做 env 替换；直连 HTTP 拿到的是未解析占位符（如 DEEPSEEK_API_KEY），直接跳过
  if (/^[A-Z][A-Z0-9_]{7,}$/.test(providerCfg.apiKey)) {
    throw new Error(`Provider ${params.modelRef.providerId} apiKey is an unresolved env placeholder`);
  }
  const api = providerCfg.api || "openai-completions";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(providerCfg.headers || {}),
    ...pickAuthHeader(providerCfg, providerCfg.apiKey),
  };
  const timeoutMs = params.timeoutMs ?? 90_000;
  const maxAttempts = 2; // 限流自动等待重试一次

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let url: string;
      let body: any;
      if (api === "anthropic-messages") {
        if (!headers["anthropic-version"]) headers["anthropic-version"] = "2023-06-01";
        url = `${providerCfg.baseUrl.replace(/\/+$/, "")}/v1/messages`;
        body = {
          model: params.modelRef.modelId,
          max_tokens: params.maxTokens ?? 1200,
          temperature: params.temperature ?? 0.3,
          system: params.system,
          messages: [{ role: "user", content: params.user }],
        };
      } else {
        url = `${providerCfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
        body = {
          model: params.modelRef.modelId,
          max_tokens: params.maxTokens ?? 1200,
          temperature: params.temperature ?? 0.3,
          messages: [
            { role: "system", content: params.system },
            { role: "user", content: params.user },
          ],
        };
      }
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
      });
      if (!resp.ok) {
        let detail = `HTTP ${resp.status}`;
        try {
          const payload = await resp.json();
          detail = payload?.error?.message || payload?.message || payload?.error || detail;
        } catch {}
        detail = String(detail).slice(0, 200);
        // 限流：等待后重试一次（GLM/DeepSeek 常见“您的账户已达到速率限制”）
        if (resp.status === 429 || /速率限制|请求频率|rate.?limit|并发/i.test(detail)) {
          if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, 25_000));
            continue;
          }
          throw new Error(`rate limited after retry: ${detail}`);
        }
        throw new Error(`${params.modelRef.providerId}/${params.modelRef.modelId}: ${detail}`);
      }
      const payload = await resp.json();
      let text = "";
      if (api === "anthropic-messages") {
        text = (Array.isArray(payload?.content) ? payload.content : [])
          .filter((b: any) => b?.type === "text" && typeof b.text === "string")
          .map((b: any) => b.text)
          .join("\n");
      } else {
        text = payload?.choices?.[0]?.message?.content || "";
      }
      if (!text.trim()) {
        const finish = payload?.choices?.[0]?.finish_reason || "unknown";
        throw new Error(`Empty completion (finish_reason=${finish})`);
      }
      return text.trim();
    } catch (err: any) {
      if (err?.name === "AbortError") {
        throw new Error(`LLM request timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("LLM request failed");
}
