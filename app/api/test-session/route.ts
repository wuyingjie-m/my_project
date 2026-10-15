import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getOpenClawInstance } from "@/lib/openclaw-instances";
import { parseApiJsonSafely, shouldFallbackToCli, testSessionViaCli } from "@/lib/session-test-fallback";

async function probeGatewayChat(port: number, token: string, timeoutMs = 3000) {
  const started = Date.now();
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/chat${token ? `?token=${encodeURIComponent(token)}` : ""}`, {
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      ok: resp.status >= 200 && resp.status < 400,
      elapsed: Date.now() - started,
      error: resp.status >= 200 && resp.status < 400 ? undefined : `Gateway HTTP ${resp.status}`,
    };
  } catch (err: any) {
    return { ok: false, elapsed: Date.now() - started, error: err?.message || "Gateway unreachable" };
  }
}

export async function POST(req: Request) {
  try {
    const { sessionKey, agentId, instanceId } = await req.json();
    if (!sessionKey || !agentId) {
      return NextResponse.json({ error: "Missing sessionKey or agentId" }, { status: 400 });
    }

    // Read gateway config
    const instance = getOpenClawInstance(instanceId);
    const gatewayPort = instance.gatewayPort;
    const gatewayToken = instance.gatewayToken;

    const startTime = Date.now();

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${gatewayToken}`,
        "x-openclaw-agent-id": agentId,
        "x-openclaw-session-key": sessionKey,
      };

      const resp = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
        method: "POST",
        headers,
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
          const gateway = await probeGatewayChat(gatewayPort, gatewayToken);
          return NextResponse.json({
            status: gateway.ok ? "ok" : "error",
            sessionKey,
            elapsed: gateway.elapsed,
            reply: gateway.ok ? `Gateway reachable; session ${sessionKey}` : undefined,
            error: gateway.error,
          });
        }
        return NextResponse.json({
          status: "error",
          sessionKey,
          elapsed,
          error: data?.error?.message || rawText || JSON.stringify(data),
        });
      }

      const reply = data.choices?.[0]?.message?.content || "";
      return NextResponse.json({
        status: "ok",
        sessionKey,
        elapsed,
        reply: reply.slice(0, 200) || "(no reply)",
      });
    } catch (err: any) {
      const elapsed = Date.now() - startTime;
      const isTimeout = err.name === "TimeoutError" || err.name === "AbortError";
      return NextResponse.json({
        status: "error",
        sessionKey,
        elapsed,
        error: isTimeout ? "Timeout: agent not responding (8s)" : (err.message || "Unknown error").slice(0, 300),
      });
    }
  } catch (err: any) {
    return NextResponse.json({ status: "error", error: err.message }, { status: 500 });
  }
}
