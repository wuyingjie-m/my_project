import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { execOpenclaw, parseOpenclawJsonOutput } from "@/lib/openclaw-cli";
import { configuredAgentEntries, discoverOpenClawInstances, type OpenClawInstance } from "@/lib/openclaw-instances";
const PROBE_TIMEOUT_MS = 8_000;

type AgentConfig = {
  id: string;
  model?: string;
};

type LoadedOpenClawInstance = OpenClawInstance & {
  config: any;
};

function loadAgentList(config: any, openclawHome: string, includeMain: boolean): AgentConfig[] {
  let agentList: AgentConfig[] = configuredAgentEntries(config);
  if (agentList.length > 0) {
    return includeMain ? agentList : agentList.filter((agent) => agent.id !== "main");
  }

  try {
    const agentsDir = path.join(openclawHome, "agents");
    const dirs = fs.readdirSync(agentsDir, { withFileTypes: true });
    agentList = dirs
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => ({ id: d.name }));
  } catch {}

  if (!includeMain) {
    agentList = agentList.filter((agent) => agent.id !== "main");
    return agentList;
  }
  if (agentList.length === 0) return [{ id: "main" }];
  return agentList;
}

function parseApiJsonSafely(rawText: string): any {
  if (!rawText) return null;
  try {
    return JSON.parse(rawText);
  } catch {
    return null;
  }
}

function extractCliReply(parsed: any, stdout: string): string {
  const candidates = [
    parsed?.reply,
    parsed?.text,
    parsed?.outputText,
    parsed?.result?.reply,
    parsed?.result?.text,
    parsed?.response?.text,
    parsed?.response?.output_text,
    parsed?.message,
  ];
  const hit = candidates.find((value) => typeof value === "string" && value.trim());
  if (hit) return hit.trim().slice(0, 200);
  return (stdout || "OK").trim().slice(0, 200);
}

function classifyCliModelProbe(
  instance: LoadedOpenClawInstance,
  agentId: string,
  model: string,
  parsed: any,
  stdout: string,
  elapsed: number,
) {
  const error = parsed?.error?.message || parsed?.error;
  if (typeof error === "string" && error.trim()) {
    return {
      instanceId: instance.id,
      instanceName: instance.name,
      agentId,
      model,
      ok: false,
      error: error.trim().slice(0, 500),
      elapsed,
      status: "error",
      mode: "agent",
      precision: "agent",
      source: "openclaw_agent_cli_probe",
    };
  }

  if (parsed?.status === "timeout" && parsed?.providerStarted === true) {
    const effective = parsed?.result?.meta?.terminalReceipt?.effective;
    const effectiveModel = [effective?.provider, effective?.model].filter(Boolean).join("/");
    return {
      instanceId: instance.id,
      instanceName: instance.name,
      agentId,
      model,
      ok: true,
      text: `Model reached${effectiveModel ? `: ${effectiveModel}` : ""}; response exceeded ${Math.round(PROBE_TIMEOUT_MS / 1000)}s health-check timeout`,
      elapsed,
      status: "slow",
      mode: "agent",
      precision: "agent",
      source: "openclaw_agent_cli_probe",
    };
  }

  return {
    instanceId: instance.id,
    instanceName: instance.name,
    agentId,
    model,
    ok: true,
    text: extractCliReply(parsed, stdout),
    elapsed,
    status: "ok",
    mode: "agent",
    precision: "agent",
    source: "openclaw_agent_cli_probe",
  };
}

async function testBoundModelViaCli(
  instance: LoadedOpenClawInstance,
  agentId: string,
  model: string,
) {
  const gatewayPort = instance.config?.gateway?.port || 18789;
  const gatewayToken = instance.config?.gateway?.auth?.token || "";
  const startTime = Date.now();
  try {
    const { stdout, stderr } = await execOpenclaw([
      "agent",
      "--agent",
      agentId,
      "--message",
      "Health check: reply with OK",
      "--json",
      "--timeout",
      String(Math.round(PROBE_TIMEOUT_MS / 1000)),
    ], {
      configPath: instance.configPath,
      gatewayPort,
      gatewayToken,
      timeoutMs: PROBE_TIMEOUT_MS + 5000,
    });
    const parsed = parseOpenclawJsonOutput(stdout, stderr);
    return classifyCliModelProbe(instance, agentId, model, parsed, stdout, Date.now() - startTime);
  } catch (err: any) {
    const stdout = typeof err?.stdout === "string" ? err.stdout : "";
    const stderr = typeof err?.stderr === "string" ? err.stderr : "";
    const parsed = parseOpenclawJsonOutput(stdout, stderr);
    if (parsed) {
      return classifyCliModelProbe(instance, agentId, model, parsed, stdout, Date.now() - startTime);
    }
    return {
      instanceId: instance.id,
      instanceName: instance.name,
      agentId,
      model,
      ok: false,
      error: (stderr || stdout || err?.message || "CLI model probe failed").trim().slice(0, 500),
      elapsed: Date.now() - startTime,
      status: "error",
      mode: "agent",
      precision: "agent",
      source: "openclaw_agent_cli_probe",
    };
  }
}

async function testBoundModelViaGateway(
  instance: LoadedOpenClawInstance,
  agentId: string,
  model: string,
) {
  const gatewayPort = instance.config?.gateway?.port || 18789;
  const gatewayToken = instance.config?.gateway?.auth?.token || "";
  const startTime = Date.now();
  try {
    const resp = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${gatewayToken}`,
        "x-openclaw-agent-id": agentId,
        "x-openclaw-session-key": `agent:${agentId}:main`,
      },
      body: JSON.stringify({
        model: `openclaw:${agentId}`,
        messages: [{ role: "user", content: "Health check: reply with OK" }],
        max_tokens: 64,
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    const rawText = await resp.text();
    const data = parseApiJsonSafely(rawText);
    const elapsed = Date.now() - startTime;
    if (!resp.ok) {
      if (resp.status === 404 || rawText.trim() === "Not Found") {
        return testBoundModelViaCli(instance, agentId, model);
      }
      return {
        instanceId: instance.id,
        instanceName: instance.name,
        agentId,
        model,
        ok: false,
        error: data?.error?.message || rawText || `HTTP ${resp.status}`,
        elapsed,
        status: `http_${resp.status}`,
        mode: "agent",
        precision: "agent",
        source: "openclaw_agent_probe",
      };
    }

    const reply = data?.choices?.[0]?.message?.content || "";
    return {
      instanceId: instance.id,
      instanceName: instance.name,
      agentId,
      model,
      ok: true,
      text: reply.slice(0, 200) || "OK",
      elapsed,
      status: "ok",
      mode: "agent",
      precision: "agent",
      source: "openclaw_agent_probe",
    };
  } catch (err: any) {
    const isTimeout = err?.name === "TimeoutError" || err?.name === "AbortError";
    return {
      instanceId: instance.id,
      instanceName: instance.name,
      agentId,
      model,
      ok: false,
      error: isTimeout ? `Timeout (${Math.round(PROBE_TIMEOUT_MS / 1000)}s)` : (err?.message || "Gateway model probe failed"),
      elapsed: Date.now() - startTime,
      status: isTimeout ? "timeout" : "error",
      mode: "agent",
      precision: "agent",
      source: "openclaw_agent_probe",
    };
  }
}

export async function POST() {
  try {
    const results = [];
    const instances = discoverOpenClawInstances();
    for (const instance of instances) {
      const raw = fs.readFileSync(instance.configPath, "utf-8");
      const config = JSON.parse(raw);
      const defaults = config?.agents?.defaults || {};
      const defaultModel = typeof defaults.model === "string"
        ? defaults.model
        : defaults.model?.primary || "unknown";

      const agentList = loadAgentList(config, instance.homeDir, true);
      if (agentList.length === 0) continue;

      const instanceResults = agentList.map((agent) => {
        const startTime = Date.now();
        const rawModel: any = agent.model;
        const modelStr = typeof rawModel === "string" ? rawModel : (rawModel?.primary || defaultModel);
        const provider = modelStr.includes("/") ? modelStr.split("/", 1)[0] : "";
        const allowed = Array.isArray(config?.models?.allowed) ? config.models.allowed : [];
        const knownAllowed = allowed.length === 0 || allowed.includes(modelStr);
        return {
          instanceId: instance.id,
          instanceName: instance.name,
          agentId: agent.id,
          model: modelStr,
          ok: Boolean(modelStr && modelStr !== "unknown" && knownAllowed),
          text: modelStr && modelStr !== "unknown"
            ? `Bound model: ${modelStr}${provider ? ` (${provider})` : ""}`
            : undefined,
          error: !modelStr || modelStr === "unknown"
            ? "No bound model found"
            : knownAllowed
              ? undefined
              : `Model is not in allowed list: ${modelStr}`,
          elapsed: Date.now() - startTime,
          status: modelStr && modelStr !== "unknown" && knownAllowed ? "ok" : "error",
          mode: "config",
          precision: "binding",
          source: "openclaw_config_probe",
        };
      });
      results.push(...instanceResults);
    }

    return NextResponse.json({ results });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function GET() {
  return POST();
}
