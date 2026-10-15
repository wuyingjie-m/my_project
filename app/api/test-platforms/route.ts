import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { pathToFileURL } from "url";
import { discoverOpenClawInstances, configuredAgentEntries, getInstanceAgentIds, type OpenClawInstance } from "@/lib/openclaw-instances";
import { shouldHidePlatformChannel } from "@/lib/platforms";
const QQBOT_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const QQBOT_API_BASE = "https://api.sgroup.qq.com";
const DEFAULT_YUANBAO_API_DOMAIN = "bot.yuanbao.tencent.com";
const DEFAULT_YUANBAO_WS_URL = "wss://bot-wss.yuanbao.tencent.com/wss/connection";
const importExternalModule = new Function("modulePath", "return import(modulePath)") as (modulePath: string) => Promise<any>;

interface PlatformTestResult {
  instanceId?: string;
  instanceName?: string;
  agentId: string;
  platform: string;
  accountId?: string;
  ok: boolean;
  detail?: string;
  error?: string;
  elapsed: number;
}

interface YuanbaoDmContext {
  target: string;
  accountId: string | null;
}

function runOpenClawMessageSend(channel: string, target: string, message: string, extraArgs: string[] = [], instance?: OpenClawInstance): string {
  const args = [
    "message", "send",
    "--channel", channel,
    "-t", target,
    "--message", message,
    "--json",
    ...extraArgs,
  ];

  return execFileSync("openclaw", args, {
    timeout: 30000,
    encoding: "utf-8",
    env: {
      ...process.env,
      ...(instance ? {
        OPENCLAW_HOME: instance.homeDir,
        OPENCLAW_CONFIG_PATH: instance.configPath,
      } : {}),
    },
  });
}

async function probeGatewayWebUi(port: number, token: string, timeoutMs = 5000): Promise<{ ok: boolean; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(
      `http://localhost:${port}/chat${token ? `?token=${encodeURIComponent(token)}` : ""}`,
      { signal: controller.signal, cache: "no-store", redirect: "manual" },
    );
    return resp.status >= 200 && resp.status < 400
      ? { ok: true }
      : { ok: false, error: `HTTP ${resp.status}` };
  } catch (err: any) {
    return { ok: false, error: err?.message || "Failed to reach gateway web UI" };
  } finally {
    clearTimeout(timeout);
  }
}

function runCurlJson(url: string, options: { method?: string; headers?: string[]; body?: string; timeoutSec?: number } = {}): { status: number; data: any; raw: string } {
  const args = [
    '-sS',
    '--connect-timeout', String(options.timeoutSec ?? 10),
    '--max-time', String(options.timeoutSec ?? 20),
    '-X', options.method || 'GET',
  ];

  for (const header of options.headers || []) {
    args.push('-H', header);
  }
  if (typeof options.body === 'string') {
    args.push('--data-raw', options.body);
  }
  args.push('-w', '\\n%{http_code}', url);

  const raw = execFileSync('curl', args, {
    timeout: (options.timeoutSec ?? 20) * 1000 + 1000,
    encoding: 'utf-8',
    env: { ...process.env },
  });
  const cut = raw.lastIndexOf('\n');
  const body = cut >= 0 ? raw.slice(0, cut) : raw;
  const status = Number(cut >= 0 ? raw.slice(cut + 1).trim() : 0);
  let data: any = null;
  try {
    data = body ? JSON.parse(body) : null;
  } catch {
    data = null;
  }
  return { status, data, raw: body };
}

// Find the most recent feishu DM user open_id for a given agent
// Each feishu app has its own open_id namespace, so we must use per-agent open_ids
function getFeishuDmUser(homeDir: string, agentId: string): string | null {
  try {
    const sessionsPath = path.join(homeDir, `agents/${agentId}/sessions/sessions.json`);
    const raw = fs.readFileSync(sessionsPath, "utf-8");
    const sessions = JSON.parse(raw);
    let bestId: string | null = null;
    let bestTime = 0;
    for (const [key, val] of Object.entries(sessions)) {
      const m = key.match(/^agent:[^:]+:feishu:direct:(ou_[a-f0-9]+)$/);
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

// Feishu: get token → verify bot info → send a real DM
async function testFeishu(
  agentId: string,
  accountId: string,
  appId: string,
  appSecret: string,
  domain: string,
  testUserId: string | null
): Promise<PlatformTestResult> {
  const baseUrl = domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
  const startTime = Date.now();

  try {
    // Step 1: get tenant_access_token
    const tokenResp = await fetch(
      `${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        signal: AbortSignal.timeout(15000),
      }
    );

    const tokenData = await tokenResp.json();
    if (tokenData.code !== 0 || !tokenData.tenant_access_token) {
      return {
        agentId, platform: "feishu", accountId, ok: false,
        error: `Token failed: ${tokenData.msg || JSON.stringify(tokenData)}`,
        elapsed: Date.now() - startTime,
      };
    }

    const token = tokenData.tenant_access_token;

    // Step 2: verify bot info
    const botResp = await fetch(`${baseUrl}/open-apis/bot/v3/info/`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });

    const botData = await botResp.json();
    if (botData.code !== 0 || !botData.bot) {
      return {
        agentId, platform: "feishu", accountId, ok: false,
        error: `Bot API error: ${botData.msg || JSON.stringify(botData)}`,
        elapsed: Date.now() - startTime,
      };
    }

    const botName = botData.bot.bot_name || accountId;

    // Step 3: send a real DM to test user
    if (!testUserId) {
      return {
        agentId, platform: "feishu", accountId, ok: true,
        detail: `${botName} (bot reachable, no DM session found)`,
        elapsed: Date.now() - startTime,
      };
    }

    const now = new Date().toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai" });
    const msgResp = await fetch(
      `${baseUrl}/open-apis/im/v1/messages?receive_id_type=open_id`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          receive_id: testUserId,
          msg_type: "text",
          content: JSON.stringify({ text: `[Platform Test] ${botName} 联通测试 ✅ (${now})` }),
        }),
        signal: AbortSignal.timeout(15000),
      }
    );

    const msgData = await msgResp.json();
    const elapsed = Date.now() - startTime;

    if (msgData.code === 0) {
      return {
        agentId, platform: "feishu", accountId, ok: true,
        detail: `${botName} → DM sent (${elapsed}ms)`,
        elapsed,
      };
    } else {
      return {
        agentId, platform: "feishu", accountId, ok: false,
        error: `Send DM failed: ${msgData.msg || JSON.stringify(msgData)}`,
        elapsed,
      };
    }
  } catch (err: any) {
    return {
      agentId, platform: "feishu", accountId, ok: false,
      error: err.message,
      elapsed: Date.now() - startTime,
    };
  }
}

// Discord: use curl so the host proxy settings are honored consistently
async function testDiscord(
  agentId: string,
  botToken: string,
  testUserId: string | null,
  recipientSource: "session" | "allowFrom" | "none"
): Promise<PlatformTestResult> {
  const startTime = Date.now();

  try {
    const meResp = runCurlJson('https://discord.com/api/v10/users/@me', {
      headers: [`Authorization: Bot ${botToken}`],
      timeoutSec: 15,
    });
    const meData = meResp.data;
    if (meResp.status < 200 || meResp.status >= 300 || !meData?.id) {
      return {
        agentId, platform: 'discord', ok: false,
        error: `Discord API error: ${meData?.message || meResp.raw || `HTTP ${meResp.status}`}`,
        elapsed: Date.now() - startTime,
      };
    }

    const botName = `${meData.username}#${meData.discriminator || '0'}`;

    if (!testUserId) {
      return {
        agentId, platform: 'discord', ok: true,
        detail: `${botName} (bot reachable, no test user for DM)`,
        elapsed: Date.now() - startTime,
      };
    }

    const dmChanResp = runCurlJson('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: [
        `Authorization: Bot ${botToken}`,
        'Content-Type: application/json',
      ],
      body: JSON.stringify({ recipient_id: testUserId }),
      timeoutSec: 15,
    });
    const dmChan = dmChanResp.data;
    if (dmChanResp.status < 200 || dmChanResp.status >= 300 || !dmChan?.id) {
      return {
        agentId, platform: 'discord', ok: false,
        error: `Create DM channel failed: ${dmChan?.message || dmChanResp.raw || `HTTP ${dmChanResp.status}`}`,
        elapsed: Date.now() - startTime,
      };
    }

    const now = new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const msgResp = runCurlJson(`https://discord.com/api/v10/channels/${dmChan.id}/messages`, {
      method: 'POST',
      headers: [
        `Authorization: Bot ${botToken}`,
        'Content-Type: application/json',
      ],
      body: JSON.stringify({
        content: `[Platform Test] ${botName} connectivity test ✅ (${now})`,
        flags: 4096,
      }),
      timeoutSec: 15,
    });
    const msgData = msgResp.data;
    const elapsed = Date.now() - startTime;
    if (msgResp.status >= 200 && msgResp.status < 300 && msgData?.id) {
      const sourceLabel = recipientSource === 'allowFrom' ? 'allowFrom' : 'session';
      return {
        agentId, platform: 'discord', ok: true,
        detail: `${botName} → DM sent (${elapsed}ms, via ${sourceLabel})`,
        elapsed,
      };
    }

    return {
      agentId, platform: 'discord', ok: false,
      error: `Send DM failed: ${msgData?.message || msgResp.raw || `HTTP ${msgResp.status}`}`,
      elapsed,
    };
  } catch (err: any) {
    return {
      agentId, platform: 'discord', ok: false,
      error: err.stderr || err.message || 'Unknown error',
      elapsed: Date.now() - startTime,
    };
  }
}

function getDiscordDmUser(homeDir: string, agentId: string): string | null {
  try {
    const sessionsPath = path.join(homeDir, `agents/${agentId}/sessions/sessions.json`);
    const raw = fs.readFileSync(sessionsPath, "utf-8");
    const sessions = JSON.parse(raw);
    let bestId: string | null = null;
    let bestTime = 0;
    for (const [key, val] of Object.entries(sessions)) {
      const m = key.match(/^agent:[^:]+:discord:direct:(.+)$/);
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

function getDiscordAllowlistUser(discordConfig: any): string | null {
  const list = Array.isArray(discordConfig?.allowFrom)
    ? discordConfig.allowFrom
    : Array.isArray(discordConfig?.dm?.allowFrom)
      ? discordConfig.dm.allowFrom
      : [];
  const first = list.find((v: any) => typeof v === "string" && v.trim().length > 0);
  return first ? first.trim() : null;
}

function getChannelDmUser(homeDir: string, agentId: string, channel: string): string | null {
  try {
    const sessionsPath = path.join(homeDir, `agents/${agentId}/sessions/sessions.json`);
    const raw = fs.readFileSync(sessionsPath, "utf-8");
    const sessions = JSON.parse(raw);
    let bestId: string | null = null;
    let bestTime = 0;
    const pattern = new RegExp(`^agent:[^:]+:${channel}:direct:(.+)$`);
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

function stripChannelTarget(value: string | null | undefined, channel: string): string | null {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const prefix = `${channel}:`;
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
}

function getYuanbaoDmContext(homeDir: string, agentId: string): YuanbaoDmContext | null {
  try {
    const sessionsPath = path.join(homeDir, `agents/${agentId}/sessions/sessions.json`);
    const raw = fs.readFileSync(sessionsPath, "utf-8");
    const sessions = JSON.parse(raw);
    let best: YuanbaoDmContext | null = null;
    let bestTime = 0;

    for (const [key, val] of Object.entries(sessions)) {
      const match = key.match(/^agent:[^:]+:yuanbao:direct:(.+)$/);
      if (!match) continue;
      const session = val as any;
      const updatedAt = session?.updatedAt || 0;
      if (updatedAt <= bestTime) continue;

      const target = stripChannelTarget(session?.deliveryContext?.to, "yuanbao")
        || stripChannelTarget(session?.origin?.to, "yuanbao")
        || match[1];
      if (!target) continue;

      bestTime = updatedAt;
      best = {
        target,
        accountId: typeof session?.deliveryContext?.accountId === "string" && session.deliveryContext.accountId.trim()
          ? session.deliveryContext.accountId.trim()
          : (typeof session?.origin?.accountId === "string" && session.origin.accountId.trim()
            ? session.origin.accountId.trim()
            : null),
      };
    }

    return best;
  } catch {
    return null;
  }
}

function resolveYuanbaoTestAccount(channelConfig: any, preferredAccountId?: string | null) {
  const accounts = channelConfig?.accounts && typeof channelConfig.accounts === "object"
    ? channelConfig.accounts
    : {};
  const availableAccountIds = Object.keys(accounts).filter((value) => value.trim().length > 0);
  const defaultAccountId = typeof channelConfig?.defaultAccount === "string" && channelConfig.defaultAccount.trim()
    ? channelConfig.defaultAccount.trim()
    : (availableAccountIds.includes("default") ? "default" : (availableAccountIds[0] ?? "default"));
  const accountId = preferredAccountId?.trim() || defaultAccountId;
  const scopedConfig = accounts?.[accountId] && typeof accounts[accountId] === "object"
    ? accounts[accountId]
    : {};
  const merged = { ...channelConfig, ...scopedConfig };
  const { accounts: _accounts, defaultAccount: _defaultAccount, ...config } = merged;

  const appKey = typeof config.appKey === "string" ? config.appKey.trim() : "";
  const appSecret = typeof config.appSecret === "string" ? config.appSecret.trim() : "";
  const identifier = typeof config.identifier === "string" ? config.identifier.trim() : "";
  const token = typeof config.token === "string" ? config.token.trim() : "";
  const apiDomain = typeof config.apiDomain === "string" && config.apiDomain.trim()
    ? config.apiDomain.trim()
    : DEFAULT_YUANBAO_API_DOMAIN;
  const wsGatewayUrl = typeof config.wsUrl === "string" && config.wsUrl.trim()
    ? config.wsUrl.trim()
    : DEFAULT_YUANBAO_WS_URL;

  return {
    accountId,
    account: {
      accountId,
      enabled: config.enabled !== false,
      configured: Boolean(appKey && appSecret),
      appKey: appKey || undefined,
      appSecret: appSecret || undefined,
      identifier: identifier || undefined,
      botId: typeof config.botId === "string" && config.botId.trim() ? config.botId.trim() : undefined,
      apiDomain,
      token: token || undefined,
      wsGatewayUrl,
      wsHeartbeatInterval: undefined,
      wsMaxReconnectAttempts: 1,
      overflowPolicy: config.overflowPolicy === "split" ? "split" : "stop",
      mediaMaxMb: typeof config.mediaMaxMb === "number" && config.mediaMaxMb >= 1 ? config.mediaMaxMb : 20,
      historyLimit: typeof config.historyLimit === "number" && config.historyLimit >= 0 ? config.historyLimit : 100,
      config,
    },
  };
}

let yuanbaoRuntimePromise: Promise<{
  getSignToken: (account: any, log?: any) => Promise<any>;
  YuanbaoWsClient: any;
  sendYuanbaoMessage: (params: any) => Promise<any>;
}> | null = null;

async function loadYuanbaoRuntime(homeDir: string) {
  const pluginDir = path.join(homeDir, "extensions/openclaw-plugin-yuanbao/dist/src");
  if (!yuanbaoRuntimePromise) {
    yuanbaoRuntimePromise = Promise.all([
      importExternalModule(pathToFileURL(path.join(pluginDir, "yuanbao-server/http/request.js")).href),
      importExternalModule(pathToFileURL(path.join(pluginDir, "yuanbao-server/ws/client.js")).href),
      importExternalModule(pathToFileURL(path.join(pluginDir, "message-handler/outbound.js")).href),
    ]).then(([requestModule, clientModule, outboundModule]) => ({
      getSignToken: requestModule.getSignToken,
      YuanbaoWsClient: clientModule.YuanbaoWsClient,
      sendYuanbaoMessage: outboundModule.sendYuanbaoMessage,
    }));
  }
  return yuanbaoRuntimePromise;
}

function getChannelAllowlistUser(channelConfig: any): string | null {
  const list = Array.isArray(channelConfig?.allowFrom)
    ? channelConfig.allowFrom
    : Array.isArray(channelConfig?.dm?.allowFrom)
      ? channelConfig.dm.allowFrom
      : [];
  const first = list.find((v: any) => typeof v === "string" && v.trim().length > 0);
  return first ? first.trim() : null;
}

// Find the most recent telegram DM chat_id for a given agent
function getTelegramDmUser(homeDir: string, agentId: string): string | null {
  try {
    const sessionsPath = path.join(homeDir, `agents/${agentId}/sessions/sessions.json`);
    const raw = fs.readFileSync(sessionsPath, "utf-8");
    const sessions = JSON.parse(raw);
    let bestId: string | null = null;
    let bestTime = 0;
    for (const [key, val] of Object.entries(sessions)) {
      const m = key.match(/^agent:[^:]+:telegram:direct:(.+)$/);
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

// Telegram: send a real DM through local OpenClaw channel gateway
async function testTelegram(
  instance: OpenClawInstance,
  agentId: string,
  testChatId: string | null
): Promise<PlatformTestResult> {
  const startTime = Date.now();

  if (!testChatId) {
    return {
      agentId, platform: "telegram", ok: false,
      error: "No Telegram recipient configured. Start one DM session first",
      elapsed: Date.now() - startTime,
    };
  }

  try {
    const now = new Date().toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai" });
    const result = runOpenClawMessageSend(
      "telegram",
      testChatId,
      `[Platform Test] Telegram 联通测试 ✅ (${now})`,
      ["--silent"],
      instance
    );
    const elapsed = Date.now() - startTime;
    const outputSummary = result.trim().slice(0, 120);
    return {
      agentId, platform: "telegram", ok: true,
      detail: `Telegram → DM sent to ${testChatId} (${elapsed}ms)${outputSummary ? ` · ${outputSummary}` : ""}`,
      elapsed,
    };
  } catch (err: any) {
    return {
      agentId, platform: "telegram", ok: false,
      error: (err.stderr || err.message || "Unknown error").slice(0, 300),
      elapsed: Date.now() - startTime,
    };
  }
}

async function testYuanbao(
  homeDir: string,
  agentId: string,
  channelConfig: any,
  testUserId: string | null,
  recipientSource: "session" | "allowFrom" | "none",
  preferredAccountId?: string | null,
): Promise<PlatformTestResult> {
  const startTime = Date.now();
  const { accountId, account } = resolveYuanbaoTestAccount(channelConfig, preferredAccountId);

  if (!account.appKey || !account.appSecret) {
    return {
      agentId,
      platform: "yuanbao",
      accountId,
      ok: false,
      error: "Yuanbao credentials missing. Configure channels.yuanbao.appKey and channels.yuanbao.appSecret",
      elapsed: Date.now() - startTime,
    };
  }

  if (!testUserId) {
    return {
      agentId,
      platform: "yuanbao",
      accountId,
      ok: false,
      error: "No Yuanbao recipient configured. Set channels.yuanbao.allowFrom or start one DM session first",
      elapsed: Date.now() - startTime,
    };
  }

  let wsClient: any = null;

  try {
    const { getSignToken, YuanbaoWsClient, sendYuanbaoMessage } = await loadYuanbaoRuntime(homeDir);
    const tokenData = await getSignToken(account);
    const botId = typeof tokenData?.bot_id === "string" && tokenData.bot_id.trim()
      ? tokenData.bot_id.trim()
      : (typeof account.botId === "string" && account.botId.trim()
        ? account.botId.trim()
        : (typeof account.identifier === "string" ? account.identifier : ""));

    if (!botId) {
      throw new Error("Yuanbao sign token succeeded but bot_id is missing");
    }

    account.botId = botId;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        wsClient?.disconnect?.();
        reject(new Error("Yuanbao WebSocket ready timeout"));
      }, 20000);

      const finish = (cb: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        cb();
      };

      wsClient = new YuanbaoWsClient({
        connection: {
          gatewayUrl: account.wsGatewayUrl,
          auth: {
            bizId: "ybBot",
            uid: botId,
            source: tokenData?.source || "bot",
            token: tokenData?.token,
            ...(account.config?.routeEnv ? { routeEnv: account.config.routeEnv } : {}),
          },
        },
        config: {
          maxReconnectAttempts: account.wsMaxReconnectAttempts,
        },
        callbacks: {
          onReady: () => finish(resolve),
          onError: (error: Error) => finish(() => reject(error)),
          onClose: (code: number, reason: string) => finish(() => reject(new Error(`Yuanbao WebSocket closed before ready: ${code} ${reason || ""}`.trim()))),
        },
        log: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
      });

      wsClient.connect();
    });

    const now = new Date().toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai" });
    const sendResult = await sendYuanbaoMessage({
      account,
      toAccount: testUserId,
      text: `[Platform Test] Yuanbao 联通测试 ✅ (${now})`,
      fromAccount: account.botId,
      ctx: {
        account,
        config: {},
        core: {},
        log: { info: () => {}, warn: () => {}, error: () => {}, verbose: () => {} },
        wsClient,
      },
    });

    const elapsed = Date.now() - startTime;
    if (!sendResult?.ok) {
      return {
        agentId,
        platform: "yuanbao",
        accountId,
        ok: false,
        error: sendResult?.error || "Yuanbao real IM send failed",
        elapsed,
      };
    }

    const sourceLabel = recipientSource === "allowFrom" ? "allowFrom" : "session";
    return {
      agentId,
      platform: "yuanbao",
      accountId,
      ok: true,
      detail: `Yuanbao → real IM sent to ${testUserId} (${elapsed}ms, via ${sourceLabel})${sendResult?.messageId ? ` · msgId=${sendResult.messageId}` : ""}`,
      elapsed,
    };
  } catch (err: any) {
    return {
      agentId,
      platform: "yuanbao",
      accountId,
      ok: false,
      error: err?.message || "Yuanbao real IM send failed",
      elapsed: Date.now() - startTime,
    };
  } finally {
    wsClient?.disconnect?.();
  }
}

async function testGenericChannel(
  instance: OpenClawInstance,
  agentId: string,
  channel: string,
  testUserId: string | null,
  recipientSource: "session" | "allowFrom" | "none"
): Promise<PlatformTestResult> {
  const startTime = Date.now();
  const displayName = channel.charAt(0).toUpperCase() + channel.slice(1);

  if (!testUserId) {
    return {
      agentId,
      platform: channel,
      ok: false,
      error: `No ${displayName} recipient configured. Set channels.${channel}.allowFrom or start one DM session first`,
      elapsed: Date.now() - startTime,
    };
  }

  try {
    const now = new Date().toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai" });
    const result = runOpenClawMessageSend(
      channel,
      testUserId,
      `[Platform Test] ${displayName} 联通测试 ✅ (${now})`,
      ["--silent"],
      instance
    );
    const elapsed = Date.now() - startTime;
    const sourceLabel = recipientSource === "allowFrom" ? "allowFrom" : "session";
    const outputSummary = result.trim().slice(0, 120);
    return {
      agentId,
      platform: channel,
      ok: true,
      detail: `${displayName} → DM sent to ${testUserId} (${elapsed}ms, via ${sourceLabel})${outputSummary ? ` · ${outputSummary}` : ""}`,
      elapsed,
    };
  } catch (err: any) {
    return {
      agentId,
      platform: channel,
      ok: false,
      error: (err.stderr || err.message || "Unknown error").slice(0, 300),
      elapsed: Date.now() - startTime,
    };
  }
}

// Find the most recent whatsapp DM user for a given agent
function getWhatsappDmUser(homeDir: string, agentId: string): string | null {
  try {
    const sessionsPath = path.join(homeDir, `agents/${agentId}/sessions/sessions.json`);
    const raw = fs.readFileSync(sessionsPath, "utf-8");
    const sessions = JSON.parse(raw);
    let bestId: string | null = null;
    let bestTime = 0;
    for (const [key, val] of Object.entries(sessions)) {
      const m = key.match(/^agent:[^:]+:whatsapp:direct:(.+)$/);
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

function getWhatsappAllowlistUser(whatsappConfig: any): string | null {
  const list = Array.isArray(whatsappConfig?.allowFrom)
    ? whatsappConfig.allowFrom
    : Array.isArray(whatsappConfig?.dm?.allowFrom)
      ? whatsappConfig.dm.allowFrom
      : [];
  const first = list.find((v: any) => typeof v === "string" && v.trim().length > 0);
  return first ? first.trim() : null;
}

// Find the most recent qqbot DM user for a given agent
function getQqbotDmUser(homeDir: string, agentId: string): string | null {
  try {
    const sessionsPath = path.join(homeDir, `agents/${agentId}/sessions/sessions.json`);
    const raw = fs.readFileSync(sessionsPath, "utf-8");
    const sessions = JSON.parse(raw);
    let bestId: string | null = null;
    let bestTime = 0;
    for (const [key, val] of Object.entries(sessions)) {
      const m = key.match(/^agent:[^:]+:qqbot:direct:(.+)$/);
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

function getQqbotAllowlistUser(qqbotConfig: any, accountId?: string | null): string | null {
  const accountCfg = accountId && accountId !== "default"
    ? qqbotConfig?.accounts?.[accountId]
    : qqbotConfig;
  const list = Array.isArray(accountCfg?.allowFrom)
    ? accountCfg.allowFrom
    : Array.isArray(accountCfg?.dm?.allowFrom)
      ? accountCfg.dm.allowFrom
      : [];
  const first = list.find((v: any) => typeof v === "string" && v.trim().length > 0);
  return first ? first.trim() : null;
}

function normalizeQqbotTarget(target: string | null): string | null {
  if (!target) return null;
  const raw = target.trim();
  if (!raw || raw === "*") return null;

  const full = raw.match(/^qqbot:(c2c|group|channel):(.+)$/i);
  if (full) {
    return `qqbot:${full[1].toLowerCase()}:${full[2].toUpperCase()}`;
  }

  const typed = raw.match(/^(c2c|group|channel):(.+)$/i);
  if (typed) {
    return `qqbot:${typed[1].toLowerCase()}:${typed[2].toUpperCase()}`;
  }

  return `qqbot:c2c:${raw.toUpperCase()}`;
}

function resolveQqbotCredentials(
  qqbotConfig: any,
  preferredAccountId?: string | null
): { accountId: string; appId: string; clientSecret: string } | null {
  if (!qqbotConfig || qqbotConfig.enabled === false) return null;

  if (
    preferredAccountId &&
    preferredAccountId !== "default" &&
    qqbotConfig.accounts &&
    typeof qqbotConfig.accounts === "object"
  ) {
    const account = qqbotConfig.accounts[preferredAccountId];
    if (
      account &&
      typeof account.appId === "string" &&
      account.appId.trim() &&
      typeof account.clientSecret === "string" &&
      account.clientSecret.trim()
    ) {
      return {
        accountId: preferredAccountId,
        appId: account.appId.trim(),
        clientSecret: account.clientSecret.trim(),
      };
    }
  }

  if (
    typeof qqbotConfig.appId === "string" &&
    qqbotConfig.appId.trim() &&
    typeof qqbotConfig.clientSecret === "string" &&
    qqbotConfig.clientSecret.trim()
  ) {
    return {
      accountId: "default",
      appId: qqbotConfig.appId.trim(),
      clientSecret: qqbotConfig.clientSecret.trim(),
    };
  }

  const accounts = qqbotConfig.accounts;
  if (!accounts || typeof accounts !== "object") return null;

  const candidates = [
    qqbotConfig.defaultAccount,
    ...Object.keys(accounts),
  ].filter((v) => typeof v === "string" && v.trim().length > 0) as string[];

  for (const accountId of candidates) {
    const acc = accounts[accountId];
    if (
      acc &&
      typeof acc.appId === "string" &&
      acc.appId.trim() &&
      typeof acc.clientSecret === "string" &&
      acc.clientSecret.trim()
    ) {
      return {
        accountId,
        appId: acc.appId.trim(),
        clientSecret: acc.clientSecret.trim(),
      };
    }
  }

  return null;
}

async function getQqbotAccessToken(appId: string, clientSecret: string): Promise<{ ok: boolean; token?: string; error?: string }> {
  try {
    const resp = await fetch(QQBOT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId, clientSecret }),
      signal: AbortSignal.timeout(15000),
    });
    const raw = await resp.text();
    let data: any = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }

    if (!resp.ok) {
      return { ok: false, error: `Token API HTTP ${resp.status}: ${(raw || "").slice(0, 180)}` };
    }
    if (!data?.access_token) {
      return { ok: false, error: `Token API invalid response: ${(raw || "").slice(0, 180)}` };
    }

    return { ok: true, token: data.access_token };
  } catch (err: any) {
    return { ok: false, error: err?.message || "Token API request failed" };
  }
}

async function testWhatsapp(
  instance: OpenClawInstance,
  agentId: string,
  gatewayPort: number,
  gatewayToken: string,
  testUserId: string | null,
  recipientSource: "session" | "allowFrom" | "none"
): Promise<PlatformTestResult> {
  const startTime = Date.now();

  if (!testUserId) {
    return {
      agentId, platform: "whatsapp", ok: false,
      error: "No WhatsApp recipient configured. Set channels.whatsapp.allowFrom or start one DM session first",
      elapsed: Date.now() - startTime,
    };
  }

  try {
    const now = new Date().toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai" });
    const result = runOpenClawMessageSend(
      "whatsapp",
      testUserId,
      `[Platform Test] WhatsApp 联通测试 ✅ (${now})`,
      [],
      instance
    );

    const elapsed = Date.now() - startTime;
    const sourceLabel = recipientSource === "allowFrom" ? "allowFrom" : "session";
    const outputSummary = result.trim().slice(0, 120);
    return {
      agentId, platform: "whatsapp", ok: true,
      detail: `WhatsApp → DM sent to ${testUserId} (${elapsed}ms, via ${sourceLabel})${outputSummary ? ` · ${outputSummary}` : ""}`,
      elapsed,
    };
  } catch (err: any) {
    return {
      agentId, platform: "whatsapp", ok: false,
      error: (err.stderr || err.message || "Unknown error").slice(0, 300),
      elapsed: Date.now() - startTime,
    };
  }
}

async function testQqbot(
  agentId: string,
  qqbotConfig: any,
  qqbotAccountId: string | null,
  testUserId: string | null,
  recipientSource: "session" | "allowFrom" | "none"
): Promise<PlatformTestResult> {
  const startTime = Date.now();
  const creds = resolveQqbotCredentials(qqbotConfig, qqbotAccountId);
  if (!creds) {
    return {
      agentId, platform: "qqbot", ok: false,
      error: "QQBot credentials missing. Configure channels.qqbot.appId/clientSecret (or accounts)",
      elapsed: Date.now() - startTime,
    };
  }

  const tokenResult = await getQqbotAccessToken(creds.appId, creds.clientSecret);
  if (!tokenResult.ok || !tokenResult.token) {
    return {
      agentId, platform: "qqbot", ok: false,
      error: tokenResult.error || "QQBot token probe failed",
      elapsed: Date.now() - startTime,
    };
  }

  if (!testUserId) {
    return {
      agentId, platform: "qqbot", ok: true,
      detail: `QQBot token OK (account ${creds.accountId}, no DM session found)`,
      elapsed: Date.now() - startTime,
    };
  }

  try {
    const now = new Date().toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai" });
    const target = testUserId.replace(/^qqbot:/i, "");
    const [kindRaw, ...idParts] = target.split(":");
    const kind = kindRaw.toLowerCase();
    const targetId = idParts.join(":");
    if (!targetId) {
      return {
        agentId, platform: "qqbot", ok: false,
        error: `Invalid QQBot target: ${testUserId}`,
        elapsed: Date.now() - startTime,
      };
    }

    const url = kind === "group"
      ? `${QQBOT_API_BASE}/v2/groups/${targetId}/messages`
      : kind === "channel"
        ? `${QQBOT_API_BASE}/channels/${targetId}/messages`
        : `${QQBOT_API_BASE}/v2/users/${targetId}/messages`;

    const body = kind === "channel"
      ? { content: `[Platform Test] QQBot 联通测试 ✅ (${now})` }
      : { content: `[Platform Test] QQBot 联通测试 ✅ (${now})`, msg_type: 0 };

    const msgResp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `QQBot ${tokenResult.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const raw = await msgResp.text();

    const elapsed = Date.now() - startTime;
    const sourceLabel = recipientSource === "allowFrom" ? "allowFrom" : "session";
    if (!msgResp.ok) {
      return {
        agentId, platform: "qqbot", ok: false,
        error: `Send failed HTTP ${msgResp.status}: ${(raw || "").slice(0, 180)}`,
        elapsed,
      };
    }

    return {
      agentId, platform: "qqbot", ok: true,
      detail: `QQBot → DM sent to ${testUserId} (${elapsed}ms, via ${sourceLabel})`,
      elapsed,
    };
  } catch (err: any) {
    return {
      agentId, platform: "qqbot", ok: false,
      error: (err.stderr || err.message || "Unknown error").slice(0, 300),
      elapsed: Date.now() - startTime,
    };
  }
}

export async function POST() {
  try {
    const results: PlatformTestResult[] = [];
    for (const instance of discoverOpenClawInstances()) {
      const config = instance.config || {};
      const bindings = Array.isArray(config.bindings) ? config.bindings : [];
      const channels = config.channels || {};
      const feishuConfig = channels.feishu || {};
      const feishuAccounts = feishuConfig.accounts || {};
      const agentList = configuredAgentEntries(config);
      const agentIds = agentList.length ? agentList.map((a) => a.id) : getInstanceAgentIds(instance);
      const special = new Set(["feishu", "discord", "telegram", "whatsapp", "qqbot"]);
      const testedFeishuAccounts = new Set<string>();

      for (const id of agentIds) {
        const feishuBinding = bindings.find((b: any) => b.agentId === id && b.match?.channel === "feishu");
        const accountId = feishuBinding?.match?.accountId || id;
        const account = feishuAccounts[accountId];
        const appId = account?.appId || feishuConfig.appId;
        const appSecret = account?.appSecret || feishuConfig.appSecret;
        const resultFor = async (promise: Promise<PlatformTestResult>) => {
          const result = await promise;
          results.push({ ...result, instanceId: instance.id, instanceName: instance.name });
        };

        if ((feishuBinding || id === "main") && appId && appSecret && !testedFeishuAccounts.has(accountId)) {
          testedFeishuAccounts.add(accountId);
          await resultFor(testFeishu(id, accountId, appId, appSecret, feishuConfig.domain || "feishu", getFeishuDmUser(instance.homeDir, id)));
        }

        const discord = channels.discord;
        if (id === "main" && discord?.enabled && discord.token) {
          const recent = getDiscordDmUser(instance.homeDir, id);
          const allow = getDiscordAllowlistUser(discord);
          await resultFor(testDiscord(id, discord.token, recent || allow, recent ? "session" : allow ? "allowFrom" : "none"));
        }

        const telegram = channels.telegram;
        if (telegram?.enabled && (id === "main" || bindings.some((b: any) => b.agentId === id && b.match?.channel === "telegram"))) {
          await resultFor(testTelegram(instance, id, getTelegramDmUser(instance.homeDir, id)));
        }

        const whatsapp = channels.whatsapp;
        if (id === "main" && whatsapp && whatsapp.enabled !== false) {
          const recent = getWhatsappDmUser(instance.homeDir, id);
          const allow = getWhatsappAllowlistUser(whatsapp);
          await resultFor(testWhatsapp(instance, id, instance.gatewayPort, instance.gatewayToken, recent || allow, recent ? "session" : allow ? "allowFrom" : "none"));
        }

        const qqbot = channels.qqbot;
        if (qqbot && qqbot.enabled !== false && (id === "main" || bindings.some((b: any) => b.agentId === id && b.match?.channel === "qqbot"))) {
          const binding = bindings.find((b: any) => b.agentId === id && b.match?.channel === "qqbot");
          const qqAccount = binding?.match?.accountId || (id === "main" ? "default" : id);
          const recent = normalizeQqbotTarget(getQqbotDmUser(instance.homeDir, id));
          const allow = normalizeQqbotTarget(getQqbotAllowlistUser(qqbot, qqAccount));
          await resultFor(testQqbot(id, qqbot, qqAccount, recent || allow, recent ? "session" : allow ? "allowFrom" : "none"));
        }

        for (const [channelName, channelConfig] of Object.entries(channels)) {
          if (special.has(channelName) || shouldHidePlatformChannel(channelName, channels)) continue;
          if (!channelConfig || typeof channelConfig !== "object" || (channelConfig as any).enabled === false) continue;
          const hasBinding = bindings.some((b: any) => b.agentId === id && b.match?.channel === channelName);
          if (id !== "main" && !hasBinding) continue;
          const yuanbao = channelName === "yuanbao" ? getYuanbaoDmContext(instance.homeDir, id) : null;
          const recent = channelName === "yuanbao" ? yuanbao?.target || null : getChannelDmUser(instance.homeDir, id, channelName);
          const allow = channelName === "yuanbao"
            ? stripChannelTarget(getChannelAllowlistUser(channelConfig), "yuanbao")
            : getChannelAllowlistUser(channelConfig);
          const source = recent ? "session" : allow ? "allowFrom" : "none";
          if (channelName === "yuanbao") {
            await resultFor(testYuanbao(instance.homeDir, id, channelConfig, recent || allow, source, yuanbao?.accountId || null));
          } else {
            await resultFor(testGenericChannel(instance, id, channelName, recent || allow, source));
          }
        }
      }
    }
    return NextResponse.json({ results });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Platform test failed" }, { status: 500 });
  }
}

export async function GET() {
  return POST();
}
