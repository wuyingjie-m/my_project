import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import os from "os";
import path from "path";

const LOG_PATH = path.join(os.homedir(), ".openclaw/logs/gateway.err.log");
const TAIL_LINES = 120;
const STALL_RECENT_MS = 10 * 60 * 1000; // consider stall "active" if within last 10 min

const PATTERNS = [
  { re: /Polling stall detected/, issue: "telegram_stall" },
  { re: /sendChatAction failed: Network request/, issue: "telegram_network" },
  { re: /gateway timeout after \d+ms/, issue: "subagent_timeout" },
] as const;

export async function GET() {
  try {
    const content = readFileSync(LOG_PATH, "utf8");
    const lines = content.split("\n").filter(Boolean).slice(-TAIL_LINES);

    const issues = new Set<string>();
    for (const line of lines) {
      for (const { re, issue } of PATTERNS) {
        if (re.test(line)) issues.add(issue);
      }
    }

    // Find timestamp of most recent stall line
    let lastStallAt: string | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/Polling stall detected/.test(lines[i])) {
        const m = lines[i].match(/^(\d{4}-\d{2}-\d{2}T[\d:.+]+)/);
        if (m) { lastStallAt = m[1]; break; }
      }
    }

    // Only treat stall as active if it happened recently
    const stallActive = lastStallAt
      ? Date.now() - new Date(lastStallAt).getTime() < STALL_RECENT_MS
      : false;

    // 回傳最後 30 行作為原始紀錄供 UI 顯示
    const recentLines = lines.slice(-30);

    return NextResponse.json({
      ok: true,
      issues: [...issues],
      lastStallAt,
      stallActive,
      recentLines,
    });
  } catch {
    return NextResponse.json({ ok: false, issues: [], lastStallAt: null, stallActive: false });
  }
}
