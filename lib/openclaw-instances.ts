import fs from "fs";
import path from "path";
import { OPENCLAW_CONFIG_PATH, OPENCLAW_HOME, OPENCLAW_AGENTS_DIR } from "@/lib/openclaw-paths";

export type OpenClawInstance = {
  id: string;
  name: string;
  configPath: string;
  homeDir: string;
  agentsDir: string;
  config: any;
  gatewayPort: number;
  gatewayToken: string;
  isPrimary: boolean;
};

export function configuredAgentEntries(config: any): Array<{ id: string; name?: string; emoji?: string; identity?: { emoji?: string }; model?: string }> {
  if (Array.isArray(config?.agents?.list) && config.agents.list.length) {
    return config.agents.list.filter((a: any) => a && typeof a.id === "string" && a.id);
  }
  if (config?.agents?.entries && typeof config.agents.entries === "object" && !Array.isArray(config.agents.entries)) {
    return Object.entries(config.agents.entries).map(([id, value]: [string, any]) => ({
      id,
      ...(value && typeof value === "object" ? value : {}),
    }));
  }
  return [];
}

function readConfig(configPath: string): any {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

// start-all.sh 用 ops/instance-ports.conf 的端口拉起各实例网关；config 里的 gateway.port 可能漂移
// （例：sxs config=18796 但实际监听 18797，18796 是 XMT 的网关——按配置端口连会撞到别的实例并报令牌不匹配）
function readOpsPorts(instancesDir: string): Record<string, number> {
  const ports: Record<string, number> = {};
  try {
    const content = fs.readFileSync(path.join(instancesDir, "ops", "instance-ports.conf"), "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const name = trimmed.slice(0, eq).trim();
      const port = Number(trimmed.slice(eq + 1).trim());
      if (name && Number.isFinite(port) && port > 0) ports[name] = port;
    }
  } catch {}
  return ports;
}

export function discoverOpenClawInstances(): OpenClawInstance[] {
  const primaryHome = OPENCLAW_HOME;
  const primaryId = path.basename(path.dirname(primaryHome));
  const instancesDir = process.env.OPENCLAW_INSTANCES_DIR || "/data/agent";
  const opsPorts = readOpsPorts(instancesDir);
  const primaryConfig = readConfig(OPENCLAW_CONFIG_PATH);
  const primary: OpenClawInstance = {
    id: "default",
    name: "主实例",
    configPath: OPENCLAW_CONFIG_PATH,
    homeDir: primaryHome,
    agentsDir: OPENCLAW_AGENTS_DIR,
    config: primaryConfig,
    gatewayPort: Number(opsPorts[primaryId] || primaryConfig?.gateway?.port || 18789),
    gatewayToken: primaryConfig?.gateway?.auth?.token || "",
    isPrimary: true,
  };
  const result = [primary];
  try {
    for (const entry of fs.readdirSync(instancesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === primaryId) continue;
      const root = path.join(instancesDir, entry.name);
      const configPath = [
        path.join(root, ".openclaw", "openclaw.json"),
        path.join(root, "openclaw.json"),
      ].find((candidate) => fs.existsSync(candidate));
      if (!configPath) continue;
      const homeDir = path.dirname(configPath);
      const config = readConfig(configPath);
      result.push({
        id: entry.name,
        name: entry.name,
        configPath,
        homeDir,
        agentsDir: path.join(homeDir, "agents"),
        config,
        gatewayPort: Number(opsPorts[entry.name] || config?.gateway?.port || 18789),
        gatewayToken: config?.gateway?.auth?.token || "",
        isPrimary: false,
      });
    }
  } catch {}
  return result.sort((a, b) => a.id === "default" ? -1 : b.id === "default" ? 1 : a.id.localeCompare(b.id));
}

export function getOpenClawInstance(instanceId?: string | null): OpenClawInstance {
  const instances = discoverOpenClawInstances();
  return instances.find((instance) => instance.id === (instanceId || "default")) || instances[0];
}

export function getInstanceAgentIds(instance: OpenClawInstance): string[] {
  const configured = configuredAgentEntries(instance.config).map((agent) => agent.id);
  if (configured.length) return configured;
  try {
    return fs.readdirSync(instance.agentsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
