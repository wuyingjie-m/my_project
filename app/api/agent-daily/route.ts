import { NextResponse } from "next/server";
import { dayRangeUtcMs, isoToday, isoYesterday } from "@/lib/agent-daily-source";
import { generateAndCacheReport } from "@/lib/agent-daily-generate";

export const dynamic = "force-dynamic";

/**
 * Agent 昨日日报接口：聚合目标日期的会话记录 → LLM 生成详略得当的日报总结。
 * 缓存策略：磁盘 + 内存；历史日期结果不可变 → 永久缓存，今天 → 10 分钟 TTL。
 * 生成失败不缓存错误（下次自动重试），同时返回原始任务列表供前端兜底展示。
 * 每天凌晨 4 点由 /api/agent-daily/generate-all 批量预生成（refresh），早上打开即秒出。
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const agentId = (url.searchParams.get("agentId") || "").trim();
  const instanceId = (url.searchParams.get("instanceId") || "default").trim();
  const date = (url.searchParams.get("date") || isoYesterday()).trim();
  const refresh = url.searchParams.get("refresh") === "1";

  if (!agentId) return NextResponse.json({ error: "Missing agentId" }, { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "Invalid date, expected YYYY-MM-DD" }, { status: 400 });
  }
  try {
    dayRangeUtcMs(date);
  } catch {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 });
  }

  const data = await generateAndCacheReport(instanceId, agentId, date, { refresh });
  return NextResponse.json(data);
}
