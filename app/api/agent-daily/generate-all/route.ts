import { NextResponse } from "next/server";
import { discoverInstances, isoYesterday, loadInstanceAgentIds } from "@/lib/agent-daily-source";
import { generateAndCacheReport } from "@/lib/agent-daily-generate";

export const dynamic = "force-dynamic";

/**
 * 批量预生成全部机器人的昨日日报（凌晨 4 点 crontab 调用，也可手动触发）。
 * - 强制 refresh：即使已有缓存也重新生成（昨天的数据在深夜到凌晨之间才完整）
 * - 并发 3，单机器人失败不影响其他；成功结果写入接口缓存 + /data/knowledge 知识库文件
 * 用法：curl "http://127.0.0.1:3000/api/agent-daily/generate-all"（默认生成昨天）
 */
let running = false;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const date = (url.searchParams.get("date") || isoYesterday()).trim();
  const instanceId = (url.searchParams.get("instanceId") || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "Invalid date, expected YYYY-MM-DD" }, { status: 400 });
  }
  if (running) {
    return NextResponse.json({ error: "generate-all already running", date }, { status: 409 });
  }
  running = true;
  const startedAt = Date.now();

  try {
    // 支持按实例分批：cron 每 15 分钟触发一个实例，错峰避免模型限流
    const instances = discoverInstances();
    const selected = instanceId ? instances.filter((i) => i.id === instanceId) : instances;
    if (instanceId && selected.length === 0) {
      return NextResponse.json({ error: `Unknown instanceId: ${instanceId}`, date }, { status: 400 });
    }
    const jobs: { instanceId: string; agentId: string }[] = [];
    for (const instance of selected) {
      const agentIds = await loadInstanceAgentIds(instance);
      for (const agentId of agentIds) jobs.push({ instanceId: instance.id, agentId });
    }

    const results: any[] = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < jobs.length) {
        const job = jobs[cursor++];
        try {
          const d = await generateAndCacheReport(job.instanceId, job.agentId, date, { refresh: true });
          results.push({
            instanceId: job.instanceId,
            agentId: job.agentId,
            ok: !d.error,
            hasActivity: d.hasActivity,
            error: d.error || undefined,
            model: d.model || undefined,
            filePath: d.filePath || undefined,
          });
        } catch (err: any) {
          results.push({ instanceId: job.instanceId, agentId: job.agentId, ok: false, error: err?.message || String(err) });
        }
        // 限流缓解：worker 内每个任务后小间隔，降低对模型账号的瞬时压力
        await new Promise((r) => setTimeout(r, 3000));
      }
    };
    await Promise.all([worker(), worker()]);

    const generated = results.filter((r) => r.ok && r.hasActivity).length;
    const noActivity = results.filter((r) => r.ok && !r.hasActivity).length;
    const failed = results.filter((r) => !r.ok).length;
    return NextResponse.json({
      date,
      instanceId: instanceId || "all",
      total: jobs.length,
      generated,
      noActivity,
      failed,
      durationMs: Date.now() - startedAt,
      finishedAt: new Date().toLocaleString("zh-CN"),
      results,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "generate-all failed", date }, { status: 500 });
  } finally {
    running = false;
  }
}
