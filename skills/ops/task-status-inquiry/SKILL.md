---
name: task-status-inquiry
description: 用户问某任务「做完了吗/进度如何/怎么没有播报」时使用：定位真实会话、核实活动与播报记录、催办并安排完成回报。
---

# 跨会话任务进度查询

用户引用别的聊天窗口里布置的任务问进度。该任务的历史不在当前会话里，先定位真实会话再核实，不要凭当前会话记忆或空会话记录下结论。

## 步骤

1. 定位真实会话：`sessions_list` 按 updatedAt 最新 + channel=feishu 找候选。**用户报的 chat id（oc_…）键名的 `feishu:group:<chatid>` 会话可能是空壳**（0 条消息、updatedAt 停在旧日期）——真实对话在按用户 open_id 键名的直聊会话 `feishu:direct:ou_<openid>`（2026-09-21 实测：主窗口 oc_7005… 的任务在 direct 会话里，同名 group 会话为空壳；直聊 session_key 本就不含 oc_，见 chatid-harvest.md）。`sessions_search` 搜 chat id 无命中（消息正文不含 chat id），不要用它定位。完成：该会话里能看到任务的首条用户消息。
2. 读任务状态：对该会话 `sessions_history`（`includeTools:true`），从最近 assistant 文本与工具调用判断进行到哪步；对比最后事件时间与当前时间判断是否卡死。完成：说得出任务当前阶段与最后活动时刻。
3. 核播报合规与活跃度（被问「怎么没有播报」时必做）：sqlite3 直查本实例 agent 库 `<实例>/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite` 的 `transcript_events`——agent 库可直查、无需副本（2026-09-21 实测；`state/` 下的库才必须先 cp 到 /tmp）：`WHERE created_at >= <任务开始毫秒>` 统计 `event_json LIKE '%messages-send%'` 的播报次数，`max(created_at)` 为最后活动。LIKE 会把上下文里的播报规则文本误计为播报，逐条看 `--text` 原文确认。批量/跨实例审计的脚本与分类规则见 agent-broadcast-audit 技能（scripts/audit.sh）。完成：能回答「发过几次播报、分别几点、最后活动何时」。
4. 任务仍在跑且用户在等，做三件套：① `sessions_send` 给该会话发催办（`timeoutSeconds:0` 即返回，消息排队等它收尾，别等回复）；② 按 AGENTS.md「长任务播报」以 bot 身份给用户窗口补发一条一行进度（`--as bot`；有 oc_ 用 `--chat-id`，p2p 直接 `--user-id <ou_…>` 即可、无需先取 oc_，禁止 `--as user`）；③ 建一次性 automation（`schedule:{kind:"at",at:<稍后时刻>}` + `sessionTarget:"current"` + `deleteAfterRun:true`）到点复查并回报。完成：三项均有回执（targetDisposition=queued / 发送回执 / job 的 nextRunAtMs）。回执只证明登记成功，不证明到点能跑——按 openclaw-automation-jobs 步骤 2 强制试跑验证（2026-09-23 起 agentTurn 调度运行存在 core 工具解析失败问题）。
5. 回复用户三要素：状态（没做完/进行到哪/是否卡死）、静默原因（如「只发过开场播报，过程播报违规缺失」要点名）、后续（何时复查、结果推到哪个窗口）。完成：三要素都有着落，不抢答未完成的结论。

## 边界

- 会话里没消息 ≠ 任务没收到：先走步骤 1 找直聊会话；直聊也没有才按派发失败排查（channel-delivery-diagnosis，网关日志找 `failed to dispatch`）。
- transcript 里有播报发送但用户没看到 → channel-delivery-diagnosis 3e（流式卡片 300309 故障分支），不是合规问题。
- transcript 现存在 sqlite；`agents/<id>/sessions/*.jsonl` 只是归档残留，别按文件名找当前会话。
- 催办后由原会话把结果发回原窗口；不要代它收尾或搬运未经验证的结论。
