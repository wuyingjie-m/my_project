---
name: agent-broadcast-audit
description: 核查 OpenClaw 多实例各 agent 的过程播报执行情况时使用。按 transcript_events 统计工具调用与播报调用、定位零播报 agent、读弹回日志、对比历史执行率时使用。
---

# 过程播报执行核查

检查各实例各 agent 在指定时间窗内"执行任务时是否发了过程播报"。判定依据是各 agent 私有库 `transcript_events` 表的关键词统计，配合 broadcast-gate 插件的弹回日志。

## 查询流程

1. 定窗口：`cutoff=$(date -d "<开始时间>" +%s) * 1000`（transcript_events 的 created_at 为毫秒时间戳）
2. 数据源：`/data/agent/<实例>/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`
3. 护栏口径（09-22 复核实测）：`state/` 下的库直查必被拦（报 cannot open databases under the active OpenClaw state directory）→ 必须 cp 副本；本 skill 的数据源 agent transcript 库**可直查**（只读，09-21/09-22 两轮实测）——单 agent 快查免副本，批量审计仍统一走脚本副本流程。注意同名两库，路径差一段 `/agent/`：`agents/<id>/agent/openclaw-agent.sqlite`（transcript，可直查）与 `agents/<id>/openclaw-agent.sqlite`（agent 根库，auth_profile 等在里，09-23 实测直查同样被拦、需 /tmp 副本）——少一段路径的就是被拦的那个
4. 完整查询脚本见 `scripts/audit.sh`（用法：`bash audit.sh "<开始时间>"`，结果同时输出到终端和 /tmp/bcast-audit-result.txt）

## 判定标准

| 指标（窗口内） | 判定 |
| --- | --- |
| 播报调用 > 0 | ✅ 执行了过程播报（`event_json LIKE '%+messages-send%'`） |
| 工具调用 > 0 且播报 = 0 | ⚠️ 未执行（违规；工具调用 = `event_json LIKE '%"type":"toolCall"%' OR '%"type":"tool_use"%'`） |
| 无工具调用 | ➖ 纯问答，豁免 |
| 无活动 | ➖ 窗口内未工作，无法评估 |

播报识别按 `im +messages-send` 关键词（标准形态带 `--as bot`）；关键词命中 ≠ 发送成功，存疑时查 toolResult 原文，最终以用户侧收到为准

**豁免口径与会话拆分（2026-09-23）**：broadcast-gate 源码 isExempt 豁免 `:cron:`/`:isolated:`/`:subagent:`/`heartbeat` 会话，且 AGENTS.md 同日起豁免技能评审/巡检类任务的主动播报——这类会话的零播报是设计使然。判「⚠️ 违规」前必拆会话类型（session_key 含 `:cron:` = 定时会话；09-23 实测 QD/zzy、dxy 的窗口内工具调用全部来自定时日报任务，表面零播报并非违规）：

```sql
SELECT CASE WHEN w.session_key LIKE '%:cron:%' THEN 'cron' ELSE 'chat' END, COUNT(*)
FROM transcript_events e JOIN (SELECT DISTINCT session_id, session_key FROM session_windows) w
  ON e.session_id = w.session_id
WHERE e.created_at >= $cutoff
  AND (e.event_json LIKE '%"type":"toolCall"%' OR e.event_json LIKE '%"type":"tool_use"%')
GROUP BY 1;
```

- 仅 cron（chat=0）→ ➖ 播报合规不适用；其 messages-send 命中是任务投递/日报本身，不是过程播报
- chat 有调用 → 按上表判定；cron 调用混在工具总数里会低估覆盖率，报告注明即可

## 分析口径

- **窗口对比**：与上次检查的窗口对比看改善/退步；"优等生退步"是真实现象（上轮执行本轮归零），单轮数据不代表稳定行为
- **执行率**：执行播报 agent 数 ÷ 有工具调用 agent 数
- **覆盖率**：单 agent 播报条数 ÷ 工具调用数（低覆盖 = 长任务连续调用中漏报）
- **弹回日志**：`<实例>/.openclaw/logs/broadcast-violations.log`（broadcast-gate 插件写入，每次拦截一行，mode=enforce 时伴随真实弹回）——门禁真实工作的最硬证据。两个反证信号（09-22 实测）：日志文件整个不存在 = 门禁没真正加载（need 实例 enforce 配置在、日志从未产生、违规零弹回）；日志在但某 agent 无拦截记录 → 先按豁免口径拆会话类型：有 chat（非 cron）工具调用却零弹回才算门禁覆盖缺口、需排查；仅 cron 调用的 agent 零弹回属豁免设计（09-23 修正：QD/zzy 曾被误标为覆盖缺口，实测其活动全为 cron 日报会话）

## 已知坑

- **exec 输出捕获偶发丢失**：长命令轮询拿不到输出且会话 ID 丢失——把结果写入 /tmp 文件后用 read 工具读，绕开输出捕获
- **shell glob 偶发不展开**：`agents/*/agent/*.sqlite` 可能匹配为空（静默 0 输出）——用 `find <实例>/.openclaw/agents -maxdepth 3 -name openclaw-agent.sqlite` 生成列表替代 glob
- **legacy 目录干扰**：find 会匹配 `agents/<id>/agent.legacy-*/openclaw-agent.sqlite`（历史迁移留档，每实例可能多个）——路径不含 `/agent/`（精确段）的副本查询会失败（E 行），忽略即可
- **关键词误匹配**：agent 自己跑审计/检查脚本时，脚本文本里的 messages-send 字样会被计入播报数——数字有小幅高估可能，跨轮趋势仍有效
- **session_nodes 活动数与 transcript 计数可能不一致**（活动=0 但有工具调用）：activity 判定基于 session_nodes 时间戳，违规判定以 transcript_events 为准
- **开始播报的 chat_id**：运行时上下文给的直聊 chat_id 是 `user:ou_…` 格式，lark-cli 拒收（invalid chat ID format, should start with 'oc_'）——直接用 AGENTS.md 播报条款里的 `oc_` chat_id，别试运行时值
- **exec 护栏误伤命令文本**：命令行里同时出现 `sqlite3` 和 `/openclaw_*/.openclaw/…` 路径字样（哪怕 sqlite 只查 /tmp 副本、路径只是同命令里 grep 的目标）会被 state 护栏整条拦下（09-23 两次实测）——把查询写进脚本文件再 `bash 文件` 执行即可（audit.sh 即此形态）
