---
name: openclaw-automation-jobs
description: 创建、改排期或排障 OpenClaw 定时/一次性自动化任务（automations job：cron/every/at + agentTurn）时使用；建好后必强制试跑；调度运行报 No callable tools remain 或连环失败停用时使用。
---

# OpenClaw 自动化任务（automations job）创建与验证

## 步骤

1. 选型前置：排期**技能库巡检**先查原生任务——cron_jobs 里 declarationKey `skill-collection-review:<agentId>`（平台自建：每周 isolated 静默会话，不经受限 API 的 toolsAllow 注入；2026-09-23 实测同 core 下 TeamS main 运行 ok、本实例 wyj 首跑 9/24 02:36，而定制 agentTurn 撞步骤 3 的白名单问题）。原生任务在就直接用/改频，不新建定制。创建：`automations add`。必填 schedule（cron 带 `tz:"Asia/Shanghai"` / everyMs / at）与 payload；agentTurn 的 message 必须**自包含**——调度会话读不到聊天上下文，模型约定、写入路径、静默要求全部写进 message。夜间/后台静默任务配 `delivery:{mode:"none"}`（缺省 announce 会把结果推给用户）；一次性任务配 `deleteAfterRun:true`。完成：add 回执含 job id 与 nextRunAtMs。
2. **强制试跑（不可省略）**：`automations run <jobId> runMode:"force"`，随即 `automations runs <jobId>` 查 lastRunStatus。**创建回执 ≠ 能跑**：agentTurn 调度运行的工具解析路径与交互会话不同（2026-09-23 实测：交互会话工具齐全，调度运行同一白名单解析后 0 工具可用）。失败运行 <1s 即返回 error；正常启动则进入真实执行（数分钟量级）。完成：lastRunStatus=ok，或已越过启动阶段在真实执行。注意：runs 查询报 `gateway token mismatch` 时，先查自己是否把脱敏占位符 `***` 当真值传了——`--token` 必须用 `$T` 变量引用真实值。2026-09-30 证伪旧结论：以真实 token 复查，manual 与 scheduled 的 runs 记录均完整回写（此前"manual 不回写"系占位符查询失败导致的误判）。
3. 失败处置：
   - 报 `No callable tools remain after resolving explicit tool allowlist (runtime toolsAllow: …); no registered tools matched`：core 调度运行工具注册问题，**agent 侧无解**——换 sessionTarget（isolated/current；main 通道只收 systemEvent/script 负载，agentTurn 直接被拒）、改 toolsAllow 均实测无效（受限 automations API 对 toolsAllow 的改动不落盘，默认白名单自动重注入）。处置：`automations update enabled:false` 停用止血；同实例共用该机制的其他 agentTurn 定时任务（如周五周报）标记同风险，core 升级后逐一 force-run 复测再启用。
   - 连续失败 2 次触发失败告警（默认回会话）：反复试错前先停用，避免告警噪音。
   - `script` 负载的 code-mode 沙箱**没有 `exec` 全局**（2026-09-23 实测 `ReferenceError: exec is not defined`；trigger 文档的 `await exec(...)` API 不适用于 payload script）——任务里要跑 shell 就用 agentTurn，不用 script。
   - lastRunStatus=skipped：配置在、前置条件不满足（如 empty-heartbeat-file、no-route），按 error 文本补前置，不算任务故障。
4. 改字段后复核：受限会话里 update 改 enabled/schedule 可靠（configRevision 随之变化）；改 payload 内字段/sessionTarget 可能被默认值覆盖——update 后 `automations get <jobId>` 回读 configRevision 与目标字段，不符则删除重建。完成：get 回读与预期一致。
   - 受限 automations 工具清单**不回 command 负载的 job**（caller scope 只回 agentTurn/heartbeat 类；2026-10-12 实测 6 个 workday command job 仅 CLI `openclaw cron list` 可见）——管理 command 负载 job 一律走 CLI（cron add/edit/run 均正常）。
5. 修改受限 API 不可见的 job（payload=command 等；2026-09-28 实测 caller scope 清单仅见本人 3 个 job，6 个日报/早报 command 任务全不可见）：用本机 CLI 走网关改——`openclaw cron edit <jobId> --cron "<expr>" --exact`（可同改 --description/--display-name，即时生效）。跨实例同理且不受 caller-scope 限制：`/usr/local/bin/openclaw cron add/edit/list/run --port <端口> --token "***"`——端口取 `/data/agent/ops/instance-ports.conf`，token 取目标实例 `openclaw.json` 的 `gateway.auth.token`。两个实测坑：① 必须绝对路径，agent 会话 PATH 里裸 `openclaw` 解析到实例私有 shim，任务静默落错实例；② 网关 token 不随 HOME/OPENCLAW_CONFIG_PATH 自动走，缺 `--token` 报 `gateway token mismatch`（TeamS 2026-09-28 实测 add/list 通）。复核同步骤 4（`openclaw cron get <jobId>`），落盘终验用 multi-instance-cron-audit 的 DB 副本查询（expr/tz/staggerMs/nextRunAt）。另两个实测坑（2026-10-08 四实例铺开实测）：③ cron list 表格列宽会把任务名截断成 `morning-knowledge-dis...`——按完整名 grep 取 jobId 必落空（空则试跑根本没触发），用截断前缀匹配；④ state 库文件副本可能滞后于网关（WAL 未 checkpoint），副本查"job 未找到"不代表不存在，以 CLI 网关查询为准。
6. 把「默认取昨日/前一日」的定时报告任务从每天改为仅工作日（cron 加 `1-5`）时，必须同步把目标日期默认改为上一工作日（周一补周五）：周五报告原本靠周六凌晨运行生成，只改排期会丢周五报告、周一生成周末空壳。本实例补丁点（job payload 不动）：personal-work-report/scripts/common.py 的 `resolve_date` 默认分支（collect/summarize/publish 三脚本共用）；workday-morning-card/scripts/generate_morning_card.py 的 `dates()`（report_day 默认改上一工作日，card_day 默认改当天，否则周一卡片错标周六）。完成：python 导入单测，周一默认返回上一周五。

## 参考

- 跨实例建/查 job（目标不是本实例）：`/usr/local/bin/openclaw cron <add|list|run|runs> --port <实例端口> --token "<该实例 openclaw.json 的 gateway.auth.token>" …`——两个实测坑（2026-09-28/30）：① agent 会话裸跑 `openclaw` 会解析到实例私有 shim，任务静默落错实例，必须绝对路径；② 报 `gateway token mismatch` 有两个独立成因，都要排：**(a)** token 未显式传——只改 HOME/OPENCLAW_CONFIG_PATH 不够，token 不自动跟随，必须显式 `--token`；**(b)** 配置端口漂移（2026-10-15 operator 裸 shell 实测）——CLI 缺省按实例配置 `gateway.port` 连接，而配置会漂移（sxs config=18796、实际监听 18797，18796 现为 XMT 网关），token 正确也会发给邻居实例报同一错误。端口与 token 都显式传：`--port` 取 /data/agent/ops/instance-ports.conf，归属用 `ss -tlnp` + `readlink /proc/<pid>/cwd` 复核；取 token 一键形态 `T=$(python3 -c "import json;print(json.load(open('.openclaw/openclaw.json'))['gateway']['auth']['token'])")`。建完照步骤 2 强制试跑。命令中的 token 一律变量引用（`T=$(python3 -c …)` 后 `--token "$T"`）：脱敏报告/文档里的 `***` 是占位符不是值，当真值发送必报 token mismatch（2026-09-30 两发无效查询实测）。
- 存量任务全实例审计（cron_jobs/运行状态/活动取证）走 multi-instance-cron-audit。
- 一次性催办复查任务模式（at + current + deleteAfterRun）见 task-status-inquiry 步骤 4。
