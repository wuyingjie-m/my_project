import { NextResponse } from "next/server";
import { configuredAgentEntries, discoverOpenClawInstances, getInstanceAgentIds } from "@/lib/openclaw-instances";
import { parseApiJsonSafely, shouldFallbackToCli, testSessionViaCli } from "@/lib/session-test-fallback";

function hasEmbeddedHttpError(reply: string) {
  return /\bHTTP\s*(4\d{2}|5\d{2})\b/i.test(reply);
}

export async function POST() {
  const jobs = discoverOpenClawInstances().flatMap((instance) => {
    const configured = configuredAgentEntries(instance.config);
    const agentIds = configured.length ? configured.map((agent) => agent.id) : getInstanceAgentIds(instance);
    return agentIds.map((agentId) => ({ instance, agentId }));
  });
  const gatewayChecks = new Map<string, Promise<{ ok: boolean; detail?: string; error?: string; elapsed: number }>>();
  function checkGateway(instance: (typeof jobs)[number]["instance"]): Promise<{ ok: boolean; detail?: string; error?: string; elapsed: number }> {
    const cached = gatewayChecks.get(instance.id);
    if (cached) return cached;
    const started = Date.now();
    const promise = fetch(`http://127.0.0.1:${instance.gatewayPort}/chat${instance.gatewayToken ? `?token=${encodeURIComponent(instance.gatewayToken)}` : ""}`, {
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(3000),
    }).then(async (resp) => ({
      ok: resp.status >= 200 && resp.status < 400,
      detail: `Gateway reachable on :${instance.gatewayPort}`,
      error: resp.status >= 200 && resp.status < 400 ? undefined : `Gateway HTTP ${resp.status}`,
      elapsed: Date.now() - started,
    })).catch((err: any) => ({
      ok: false,
      error: err?.message || "Gateway unreachable",
      elapsed: Date.now() - started,
    }));
    gatewayChecks.set(instance.id, promise);
    return promise;
  }
  const results = await Promise.all(jobs.map(async ({ instance, agentId }) => {
      const started = Date.now();
      const sessionKey = `agent:${agentId}:main`;
      try {
        const resp = await fetch(`http://127.0.0.1:${instance.gatewayPort}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${instance.gatewayToken}`,
            "x-openclaw-agent-id": agentId,
            "x-openclaw-session-key": sessionKey,
          },
          body: JSON.stringify({ model: `openclaw:${agentId}`, messages: [{ role: "user", content: "Health check: reply with OK" }], max_tokens: 64 }),
          signal: AbortSignal.timeout(12000),
        });
        const raw = await resp.text();
        const data = parseApiJsonSafely(raw);
        const elapsed = Date.now() - started;
        if (!resp.ok && shouldFallbackToCli(resp, raw)) {
          const gateway = await checkGateway(instance);
          return {
            instanceId: instance.id,
            instanceName: instance.name,
            agentId,
            ok: gateway.ok,
            reply: gateway.ok ? `${gateway.detail}; session ${sessionKey}` : undefined,
            error: gateway.error,
            elapsed: gateway.elapsed,
          };
        } else {
          const reply = String(data?.choices?.[0]?.message?.content || "").slice(0, 200);
          return { instanceId: instance.id, instanceName: instance.name, agentId, ok: resp.ok && !hasEmbeddedHttpError(reply), reply, error: resp.ok ? (hasEmbeddedHttpError(reply) ? reply : undefined) : (data?.error?.message || raw || "API error"), elapsed };
        }
      } catch (err: any) {
        return { instanceId: instance.id, instanceName: instance.name, agentId, ok: false, error: err?.message || "Unknown error", elapsed: Date.now() - started };
      }
    }));
  return NextResponse.json({ results });
}

export async function GET() {
  return POST();
}
