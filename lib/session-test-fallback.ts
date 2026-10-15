import { execOpenclaw, parseJsonFromMixedOutput } from "@/lib/openclaw-cli";

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
  if (parsed?.status === "ok") {
    const summary = typeof parsed?.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : "completed";
    return `OK (${summary}, CLI fallback)`;
  }
  return (stdout || "(no reply)").trim().slice(0, 200);
}

function classifyCliResult(
  parsed: any,
  stdout: string,
  elapsed: number,
): { ok: boolean; reply?: string; error?: string; elapsed: number } {
  const error = parsed?.error?.message || parsed?.error;
  if (typeof error === "string" && error.trim()) {
    return { ok: false, error: error.trim().slice(0, 300), elapsed };
  }

  if (parsed?.status === "timeout" && parsed?.providerStarted === true) {
    const provider = parsed?.result?.meta?.agentMeta?.provider;
    const model = parsed?.result?.meta?.agentMeta?.model;
    const modelLabel = [provider, model].filter(Boolean).join("/");
    return {
      ok: true,
      reply: `Agent session reached${modelLabel ? ` (${modelLabel})` : ""}; provider response exceeded health-check timeout`,
      elapsed,
    };
  }

  if (parsed?.status === "ok" || parsed?.ok === true || parsed?.result) {
    return { ok: true, reply: extractCliReply(parsed, stdout), elapsed };
  }

  return { ok: true, reply: extractCliReply(parsed, stdout), elapsed };
}

export async function testSessionViaCli(
  agentId: string,
  options: { configPath?: string; gatewayPort?: string | number; gatewayToken?: string } = {},
): Promise<{ ok: boolean; reply?: string; error?: string; elapsed: number }> {
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
      "5",
    ], {
      configPath: options.configPath,
      gatewayPort: options.gatewayPort,
      gatewayToken: options.gatewayToken,
      timeoutMs: 6_000,
    });
    const elapsed = Date.now() - startTime;
    const parsed = parseJsonFromMixedOutput(`${stdout}\n${stderr || ""}`);
    return classifyCliResult(parsed, stdout, elapsed);
  } catch (err: any) {
    const elapsed = Date.now() - startTime;
    const stdout = typeof err?.stdout === "string" ? err.stdout : "";
    const stderr = typeof err?.stderr === "string" ? err.stderr : "";
    const parsed = parseJsonFromMixedOutput(`${stdout}\n${stderr || ""}`);
    if (parsed) return classifyCliResult(parsed, stdout, elapsed);
    const error = (stderr || stdout || err?.message || "CLI fallback failed").trim();
    return { ok: false, error: error.slice(0, 300), elapsed };
  }
}

export function shouldFallbackToCli(resp: Response, rawText: string): boolean {
  const text = rawText.trim();
  return resp.status === 404 || text === "Not Found";
}

export function parseApiJsonSafely(rawText: string): any {
  if (!rawText) return null;
  try {
    return JSON.parse(rawText);
  } catch {
    return null;
  }
}
