import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { discoverOpenClawInstances, getInstanceAgentIds } from "@/lib/openclaw-instances";
import { readAgentKeyInfos, groupPools } from "@/lib/key-pools";

// 可用 key 注册表（服务端保管完整 key；对外只暴露后六位与所属实例）
function readKeyRegistry(): Array<{ tail: string; owner: string; key: string }> {
  try {
    const p = path.join(process.cwd(), "key-registry.json");
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    return (raw.keys || []).map((k: any) => ({
      tail: String(k.key).slice(-6),
      owner: String(k.owner || ""),
      key: String(k.key),
    }));
  } catch {
    return [];
  }
}

function readRunUserMap(): Record<string, string> {
  try {
    const raw = fs.readFileSync("/data/agent/ops/instance-users.conf", "utf-8");
    const map: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const [k, v] = t.split("=");
      if (k && v) map[k.trim()] = v.trim();
    }
    return map;
  } catch {
    return {};
  }
}

export async function GET() {
  const infos = readAgentKeyInfos();
  const pools = groupPools(infos).map((p) => ({
    provider: p.provider,
    keyTail: p.keyTail,
    keyLen: p.keyLen,
    members: p.members.map((m) => ({ instanceId: m.instanceId, instanceName: m.instanceName, agentId: m.agentId, name: m.name, source: m.source })),
  }));
  const agents = infos.map(({ homeDir, ...rest }) => rest);
  const availableKeys = readKeyRegistry().map(({ tail, owner }) => ({ tail, owner }));
  return NextResponse.json({ generatedAt: new Date().toISOString(), pools, agents, availableKeys });
}

// 手动更换某实例全部 agent 的 API key：body = { instanceId, keyTail }
// keyTail 必须命中服务端注册表（完整 key 不经浏览器），逐 agent 走官方 paste-api-key（写 auth profile + 更新 config + 热重载）。
export async function PATCH(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid json" }, { status: 400 }); }
  const instanceId = String(body.instanceId || "");
  const keyTail = String(body.keyTail || "").trim();
  const provider = String(body.provider || "zhipuglm");

  const registry = readKeyRegistry();
  const regEntry = registry.find((k) => k.tail === keyTail);
  if (!regEntry) {
    return NextResponse.json({ error: `unknown keyTail: ${keyTail}`, available: registry.map((k) => k.tail) }, { status: 400 });
  }

  const instance = discoverOpenClawInstances().find((i) => i.id === instanceId);
  if (!instance) return NextResponse.json({ error: `unknown instance: ${instanceId}` }, { status: 400 });
  const targets = getInstanceAgentIds(instance);
  if (targets.length === 0) return NextResponse.json({ error: `no agents for ${instanceId}` }, { status: 400 });

  const runUser = readRunUserMap()[instanceId] || "root";
  const cfgPath = path.join(instance.homeDir, ".openclaw", "openclaw.json");
  // spawn 承诺化：key 走 stdin（不经 argv/日志），失败抛错带 stderr 摘要
  function runProc(cmd: string, args: string[], env: NodeJS.ProcessEnv, input: string, timeoutMs = 120_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { env });
      let errText = "";
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} reject(new Error(`timeout after ${timeoutMs}ms`)); }, timeoutMs);
      child.stderr.on("data", (d: any) => { errText += String(d); });
      child.on("error", (e: any) => { clearTimeout(timer); reject(new Error(String(e?.message || e))); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`exit ${code}: ${errText.slice(0, 200)}`));
      });
      child.stdin.write(input);
      child.stdin.end();
    });
  }

  // 并发 3：原串行逐 agent 时 7 agent ≈ 50-90s，超公网入口 ~60s 超时 → UI 报失败而服务端仍在跑（假失败根因）
  async function pMap3<T, R>(items: T[], fn: (x: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(3, items.length) }, async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        out[idx] = await fn(items[idx]);
      }
    }));
    return out;
  }

  const perAgent = async (agentId: string) => {
    try {
      // 干净 env（铁律：残留变量会让 CLI 跨实例 state 穿越报 EACCES）
      const env = {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        // CLI 的 HOME 语义 = 实例根目录（config 解析在 $HOME/.openclaw/openclaw.json）；
        // homeDir 是 <root>/.openclaw，直接当 HOME 会导致找不到 config → "Unknown agent id"（sxs 实测）
        HOME: path.dirname(instance.homeDir),
        OPENCLAW_CONFIG_PATH: instance.configPath,
        NODE_ENV: process.env.NODE_ENV || "production",
        OPENCLAW_AGENT_ID: agentId,
        OPENCLAW_AGENT_DIR: path.join(instance.homeDir, "agents", agentId),
      };
      const cliArgs = ["/usr/local/bin/openclaw", "models", "auth", "paste-api-key", "--agent", agentId, "--provider", provider];
      // paste 只写 <provider>:default，而生效优先级是 :manual —— 先以实例用户身份清掉 per-agent 残留 :manual，
      // 否则旧 manual 遮蔽新写入的 default，切换“成功”却不生效（QD 2026-10-13 实测）
      const agentStore = path.join(instance.homeDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
      if (fs.existsSync(agentStore)) {
        const scrub = [
          "-e",
          `const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
const rows = db.prepare("SELECT store_json FROM auth_profile_store").all();
let changed = 0;
for (const r of rows) {
  try {
    const j = JSON.parse(r.store_json);
    if (j.profiles && j.profiles[process.argv[2] + ":manual"]) { delete j.profiles[process.argv[2] + ":manual"]; changed++;
      db.prepare("UPDATE auth_profile_store SET store_json=? WHERE store_json=?").run(JSON.stringify(j), r.store_json); }
  } catch {}
}
console.log("scrubbed=" + changed); db.close();`,
          agentStore,
          provider,
        ];
        if (runUser === "root") {
          await runProc("/usr/bin/node", scrub, env, "");
        } else {
          const dirStat2 = fs.statSync(instance.homeDir);
          await runProc("setpriv", ["--reuid", runUser, "--regid", String(dirStat2.gid), "--init-groups", "--inh-caps=-all", "--ambient-caps=-all", "/usr/bin/node", ...scrub], env, "");
        }
      }
      const statBefore = fs.existsSync(cfgPath) ? fs.statSync(cfgPath) : null;
      if (runUser === "root") {
        await runProc(cliArgs[0], cliArgs.slice(1), env, regEntry.key);
        // root 运行时 CLI 会把 config 重写为 root 属主——修复回实例用户，否则网关 watcher EACCES（need 演练实测）
        if (statBefore) {
          const statAfter = fs.statSync(cfgPath);
          if (statAfter.uid !== statBefore.uid || statAfter.gid !== statBefore.gid) {
            try { fs.chownSync(cfgPath, statBefore.uid, statBefore.gid); } catch {}
          }
          if ((statAfter.mode & 0o777) !== (statBefore.mode & 0o777)) {
            try { fs.chmodSync(cfgPath, statBefore.mode & 0o777); } catch {}
          }
        }
      } else {
        // 以实例用户运行：属主天然正确（gid 取实例目录属组）
        const dirStat = fs.statSync(instance.homeDir);
        await runProc(
          "setpriv",
          ["--reuid", runUser, "--regid", String(dirStat.gid), "--init-groups", "--inh-caps=-all", "--ambient-caps=-all", ...cliArgs],
          env,
          regEntry.key,
        );
      }
      return { agentId, ok: true, keyTail: keyTail };
    } catch (err: any) {
      return { agentId, ok: false, error: String(err?.message || err).slice(0, 300) };
    }
  };

  const results = await pMap3(targets, perAgent);

  // 共享层同步：子 agent 运行时读共享 store 的 <provider>:manual（paste 只写 :default 不覆盖它——QD 2026-10-13 实测）。
  // key 经 stdin 传入（不经 argv），busy_timeout 防 WAL 锁。
  try {
    const sharedDb = path.join(instance.homeDir, "state", "openclaw.sqlite");
    if (fs.existsSync(sharedDb)) {
      const syncScript = [
        "-e",
        `const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const key = fs.readFileSync(0, "utf8").trim();
const db = new DatabaseSync(process.argv[1]);
db.exec("PRAGMA busy_timeout=4000");
const rows = db.prepare("SELECT rowid, value_json FROM config_machine_state WHERE state_key='authProfiles.store'").all();
let n = 0;
for (const r of rows) {
  try {
    const j = JSON.parse(r.value_json);
    if (j.profiles && j.profiles[process.argv[2] + ":manual"]) {
      j.profiles[process.argv[2] + ":manual"].key = key;
      db.prepare("UPDATE config_machine_state SET value_json=? WHERE rowid=?").run(JSON.stringify(j), r.rowid);
      n++;
    }
  } catch {}
}
console.log("sharedSync=" + n);
db.close();`,
        sharedDb,
        provider,
      ];
      const syncEnv = { PATH: "/usr/local/bin:/usr/bin:/bin", NODE_ENV: process.env.NODE_ENV || "production" };
      if (runUser === "root") {
        await runProc("/usr/bin/node", syncScript, syncEnv, regEntry.key);
      } else {
        const dirStat3 = fs.statSync(instance.homeDir);
        await runProc("setpriv", ["--reuid", runUser, "--regid", String(dirStat3.gid), "--init-groups", "--inh-caps=-all", "--ambient-caps=-all", "/usr/bin/node", ...syncScript], syncEnv, regEntry.key);
      }
    }
  } catch {}

  // 记录切换日志（供 quota-usage 按「时间 × key」归账）；同 key 连续切换不重复记录
  try {
    const logPath = path.join(process.cwd(), ".data", "key-log.json");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const log: any[] = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, "utf-8")) : [];
    const last = [...log].filter((e: any) => e.instanceId === instanceId).sort((a: any, b: any) => a.ts - b.ts).pop();
    if (!last || last.keyTail !== keyTail) {
      log.push({ ts: Date.now(), instanceId, keyTail });
      fs.writeFileSync(logPath, JSON.stringify(log, null, 1));
    }
  } catch {}

  // 回读指纹校验生效
  const infos = readAgentKeyInfos();
  for (const r of results) {
    if (!r.ok) continue;
    const after = infos.find((a) => a.instanceId === instanceId && a.agentId === r.agentId);
    r.keyTail = after?.keyTail || "";
  }
  const okCount = results.filter((r) => r.ok && r.keyTail === keyTail).length;
  return NextResponse.json({
    ok: okCount === results.length,
    applied: okCount,
    total: results.length,
    results,
    note: okCount > 0 ? `已切换到 …${keyTail}（${regEntry.owner}）并热重载生效` : undefined,
  });
}
