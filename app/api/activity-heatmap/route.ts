import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { discoverOpenClawInstances, getOpenClawInstance, getInstanceAgentIds } from "@/lib/openclaw-instances";

let cache: { key: string; data: any; ts: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000;

function buildHeatmapData(instanceId?: string | null) {
  const instances = instanceId ? [getOpenClawInstance(instanceId)] : discoverOpenClawInstances();
  const result: { agentId: string; grid: number[][] }[] = [];
  for (const instance of instances) for (const agentId of getInstanceAgentIds(instance)) {
    const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
    const sessionsDir = path.join(instance.homeDir, "agents", agentId, "sessions");
    let files: string[] = [];
    try { files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl") && !f.includes(".deleted.")); } catch {}
    for (const file of files) {
      let content = "";
      try { content = fs.readFileSync(path.join(sessionsDir, file), "utf8"); } catch { continue; }
      for (const line of content.split("\n")) {
        try {
          const entry = JSON.parse(line);
          if (entry.type !== "message" || entry.message?.role !== "assistant" || !entry.timestamp) continue;
          const dt = new Date(new Date(entry.timestamp).toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
          grid[dt.getDay() === 0 ? 6 : dt.getDay() - 1][dt.getHours()]++;
        } catch {}
      }
    }
    result.push({ agentId: `${instance.id}:${agentId}`, grid });
  }
  return { agents: result };
}

export async function GET(req: Request) {
  const instanceId = new URL(req.url).searchParams.get("instanceId");
  const key = instanceId || "all";
  if (cache && cache.key === key && Date.now() - cache.ts < CACHE_TTL) return NextResponse.json(cache.data);
  const data = buildHeatmapData(instanceId);
  cache = { key, data, ts: Date.now() };
  return NextResponse.json(data);
}
