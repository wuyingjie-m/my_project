import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getOpenClawInstance } from "@/lib/openclaw-instances";

export async function GET(req: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const { agentId } = await params;
    const instance = getOpenClawInstance(new URL(req.url).searchParams.get("instanceId"));
    const sessionsPath = path.join(instance.homeDir, `agents/${agentId}/sessions/sessions.json`);
    let sessions: Record<string, any> = {};
    try {
      sessions = JSON.parse(fs.readFileSync(sessionsPath, "utf-8"));
    } catch {
      const sessionsDir = path.dirname(sessionsPath);
      for (const file of fs.readdirSync(sessionsDir)) {
        if (!/\.jsonl(?:\.reset\..*)?$/.test(file) || file.includes(".deleted.")) continue;
        const filePath = path.join(sessionsDir, file);
        const stat = fs.statSync(filePath);
        const sessionId = file.split(".jsonl", 1)[0];
        let totalTokens = 0;
        try {
          for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
            try {
              const entry = JSON.parse(line);
              const usage = entry?.message?.usage;
              if (entry?.type === "message" && usage) {
                totalTokens += Number(usage.input || 0) + Number(usage.output || 0);
              }
            } catch {}
          }
        } catch {}
        sessions[`agent:${agentId}:main:${sessionId}`] = {
          sessionId,
          updatedAt: stat.mtimeMs,
          totalTokens,
          contextTokens: 0,
          systemSent: false,
        };
      }
    }

    const list = Object.entries(sessions).map(([key, val]: [string, any]) => {
      // 解析 session 类型
      let type = "unknown";
      let target = "";
      if (key.endsWith(":main")) {
        type = "main";
      } else if (key.includes(":feishu:direct:")) {
        type = "feishu-dm";
        target = key.split(":feishu:direct:")[1];
      } else if (key.includes(":feishu:group:")) {
        type = "feishu-group";
        target = key.split(":feishu:group:")[1];
      } else if (key.includes(":discord:direct:")) {
        type = "discord-dm";
        target = key.split(":discord:direct:")[1];
      } else if (key.includes(":discord:channel:")) {
        type = "discord-channel";
        target = key.split(":discord:channel:")[1];
      } else if (key.includes(":telegram:direct:")) {
        type = "telegram-dm";
        target = key.split(":telegram:direct:")[1];
      } else if (key.includes(":telegram:group:")) {
        type = "telegram-group";
        target = key.split(":telegram:group:")[1];
      } else if (key.includes(":whatsapp:direct:")) {
        type = "whatsapp-dm";
        target = key.split(":whatsapp:direct:")[1];
      } else if (key.includes(":whatsapp:group:")) {
        type = "whatsapp-group";
        target = key.split(":whatsapp:group:")[1];
      } else if (key.includes(":cron:")) {
        type = "cron";
        target = key.split(":cron:")[1];
      }

      return {
        key,
        type,
        target,
        sessionId: val.sessionId || null,
        updatedAt: val.updatedAt || 0,
        totalTokens: val.totalTokens || 0,
        contextTokens: val.contextTokens || 0,
        systemSent: val.systemSent || false,
      };
    });

    // 按最近活跃排序
    list.sort((a, b) => b.updatedAt - a.updatedAt);

    return NextResponse.json({ agentId, instanceId: instance.id, sessions: list });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
