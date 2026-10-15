import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { parseApiJsonSafely, shouldFallbackToCli, testSessionViaCli } from "@/lib/session-test-fallback";
import { shouldHidePlatformChannel } from "@/lib/platforms";
import { configuredAgentEntries, discoverOpenClawInstances } from "@/lib/openclaw-instances";

interface DmSessionResult {
  instanceId: string;
  instanceName: string;
  agentId: string;
  platform: string;
  ok: boolean;
  detail?: string;
  error?: string;
  elapsed: number;
}

function loadAgentList(config: any, openclawHome: string, includeMain: boolean): Array<{ id: string }> {
  let agentList = configuredAgentEntries(config).map((agent) => ({ id: agent.id }));
  if (agentList.length === 0) {
    try {
      const agentsDir = path.join(openclawHome, "agents");
      const dirs = fs.readdirSync(agentsDir, { withFileTypes: true });
      agentList = dirs
        .filter((d: any) => d.isDirectory() && !d.name.startsWith("."))
        .map((d: any) => ({ id: d.name }));
    } catch {}
  }
  if (!includeMain) return agentList.filter((agent: any) => agent.id !== "main");
  if (agentList.length === 0) return [{ id: "main" }];
  return agentList;
}

function getDmUser(openclawHome: string, agentId: string, platform: string): string | null {
  try {
    const sessionsPath = path.join(openclawHome, `agents/${agentId}/sessions/sessions.json`);
    const raw = fs.readFileSync(sessionsPath, "utf-8");
    const sessions = JSON.parse(raw);
    let bestId: string | null = null;
    let bestTime = 0;
    const pattern = platform === "feishu"
      ? /^agent:[^:]+:feishu:direct:(ou_[a-f0-9]+)$/
      : new RegExp(`^agent:[^:]+:${platform}:direct:(.+)$`);
    for (const [key, val] of Object.entries(sessions)) {
      const m = key.match(pattern);
      if (m) {
        const updatedAt = (val as any).updatedAt || 0;
        if (updatedAt > bestTime) {
          bestTime = updatedAt;
          bestId = m[1];
        }
      }
    }
    return bestId;
  } catch {
    return null;
  }
}

async function testDmSession(
  instanceId: string,
  instanceName: string,
  agentId: string,
  platform: string,
  sessionKey: string,
  gatewayPort: number,
  gatewayToken: string,
  configPath: string,
): Promise<DmSessionResult> {
  const startTime = Date.now();
  try {
    const resp = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${gatewayToken}`,
        "x-openclaw-agent-id": agentId,
        "x-openclaw-session-key": sessionKey,
      },
      body: JSON.stringify({
        model: `openclaw:${agentId}`,
        messages: [{ role: "user", content: "Health check: reply with OK" }],
        max_tokens: 64,
      }),
      signal: AbortSignal.timeout(8000),
    });

    const rawText = await resp.text();
    const data = parseApiJsonSafely(rawText);
    const elapsed = Date.now() - startTime;

    if (!resp.ok) {
      if (shouldFallbackToCli(resp, rawText)) {
        const fallback = await testSessionViaCli(agentId, { configPath, gatewayPort, gatewayToken });
        return fallback.ok
          ? { instanceId, instanceName, agentId, platform, ok: true, detail: `${fallback.reply || "OK"} · DM fallback`, elapsed: fallback.elapsed }
          : { instanceId, instanceName, agentId, platform, ok: false, error: fallback.error || "Gateway route not found", elapsed: fallback.elapsed };
      }
      return { instanceId, instanceName, agentId, platform, ok: false, error: data?.error?.message || rawText || JSON.stringify(data), elapsed };
    }

    const reply = data.choices?.[0]?.message?.content || "";
    return { instanceId, instanceName, agentId, platform, ok: true, detail: reply.slice(0, 200) || "(no reply)", elapsed };
  } catch (err: any) {
    return { instanceId, instanceName, agentId, platform, ok: false, error: err.message, elapsed: Date.now() - startTime };
  }
}

export async function POST() {
  try {
    const results: DmSessionResult[] = [];
    const instances = discoverOpenClawInstances();
    const childAgentIds = new Set<string>();
    for (const instance of instances) {
      if (instance.id === "default") continue;
      try {
        const config = JSON.parse(fs.readFileSync(instance.configPath, "utf-8"));
        const agents = configuredAgentEntries(config);
        for (const agent of agents) {
          if (agent?.id && agent.id !== "main") childAgentIds.add(agent.id);
        }
      } catch {}
    }

    for (const instance of instances) {
      const raw = fs.readFileSync(instance.configPath, "utf-8");
      const config = JSON.parse(raw);
      const gatewayPort = config.gateway?.port || 18789;
      const gatewayToken = config.gateway?.auth?.token || "";
      const channels = config.channels || {};
      const bindings = config.bindings || [];
      let agentList = loadAgentList(config, instance.homeDir, instance.id === "default");
      if (instance.id === "default") {
        agentList = agentList.filter((agent) => agent.id === "main" || !childAgentIds.has(agent.id));
      }

      const platformsToTest = Array.from(new Set([
        ...Object.entries(channels)
          .filter(([name, cfg]) => cfg && typeof cfg === "object" && (cfg as any).enabled !== false && !shouldHidePlatformChannel(name, channels))
          .map(([name]) => name),
        ...bindings
          .map((b: any) => b?.match?.channel)
          .filter((name: unknown): name is string => typeof name === "string" && name.length > 0 && !shouldHidePlatformChannel(name, channels)),
      ]));

      for (const agent of agentList) {
        const id = agent.id;
        for (const platform of platformsToTest) {
          const ch = channels[platform];
          if (ch && ch.enabled === false) continue;

          const isMain = id === "main";
          const hasBinding = bindings.some(
            (b: any) => b.agentId === id && b.match?.channel === platform
          );
          if (!isMain && !hasBinding) continue;

          const dmUser = getDmUser(instance.homeDir, id, platform);
          if (!dmUser) continue;

          const sessionKey = `agent:${id}:${platform}:direct:${dmUser}`;
          const r = await testDmSession(instance.id, instance.name, id, platform, sessionKey, gatewayPort, gatewayToken, instance.configPath);
          results.push(r);
        }
      }
    }

    return NextResponse.json({ results });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function GET() {
  return POST();
}
