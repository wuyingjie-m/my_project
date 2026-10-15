import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import net from "net";
import { discoverOpenClawInstances, getOpenClawInstance, getInstanceAgentIds, type OpenClawInstance } from "@/lib/openclaw-instances";
import { loadDiskCache, saveDiskCache } from "@/lib/disk-cache";

type AgentState = "working" | "online" | "idle" | "offline";

function gatewayReachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1200, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function getAgentState(instance: OpenClawInstance, agentId: string, gatewayOk: boolean) {
  const sessionsDir = path.join(instance.homeDir, "agents", agentId, "sessions");
  const now = Date.now();
  let lastActive: number | null = null;
  try {
    const sessions = JSON.parse(fs.readFileSync(path.join(sessionsDir, "sessions.json"), "utf8"));
    for (const value of Object.values(sessions) as any[]) {
      if (Number(value?.updatedAt || 0) > (lastActive || 0)) lastActive = Number(value.updatedAt);
    }
  } catch {}
  try {
    for (const file of fs.readdirSync(sessionsDir).filter((name) => /\.jsonl(?:\.reset\..*)?$/.test(name) && !name.includes(".deleted."))) {
      const mtime = fs.statSync(path.join(sessionsDir, file)).mtimeMs;
      if (mtime > (lastActive || 0)) lastActive = mtime;
    }
  } catch {}
  let state: AgentState = gatewayOk ? "online" : "offline";
  if (lastActive) {
    const age = now - lastActive;
    if (gatewayOk) {
      state = age < 3 * 60 * 1000 ? "working" : age < 24 * 60 * 60 * 1000 ? "online" : "idle";
    }
  }
  return { instanceId: instance.id, instanceName: instance.name, agentId, state, lastActive, gatewayOk, gatewayPort: instance.gatewayPort };
}

// SWR 缓存：命中直接返回，过期返回旧数据并后台单飞刷新
let statusCache: { data: { statuses: any[] }; ts: number } | null = loadDiskCache<{ statuses: any[] }>("agent-status");
let statusRefreshing = false;
const STATUS_TTL_MS = 10_000;

async function computeStatuses(url: URL) {
  const selected = url.searchParams.get("instanceId");
  const instances = selected ? [getOpenClawInstance(selected)] : discoverOpenClawInstances();
  const statuses = (await Promise.all(instances.map(async (instance) => {
    const gatewayOk = await gatewayReachable(instance.gatewayPort);
    return Promise.all(getInstanceAgentIds(instance).map((id) => getAgentState(instance, id, gatewayOk)));
  }))).flat();
  return statuses;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const cached = statusCache;
  if (cached && Date.now() - cached.ts < STATUS_TTL_MS) {
    return NextResponse.json(cached.data);
  }
  if (cached) {
    // 有旧缓存但已过期：立即返回旧数据，后台单飞刷新
    if (!statusRefreshing) {
      statusRefreshing = true;
      computeStatuses(url)
        .then((statuses) => { const entry = { data: { statuses }, ts: Date.now() }; statusCache = entry; saveDiskCache("agent-status", entry); })
        .catch(() => {})
        .finally(() => { statusRefreshing = false; });
    }
    return NextResponse.json(cached.data);
  }
  const statuses = await computeStatuses(url);
  const entry = { data: { statuses }, ts: Date.now() };
  statusCache = entry;
  saveDiskCache("agent-status", entry);
  return NextResponse.json({ statuses });
}
