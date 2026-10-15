# chat_id 收集与交叉验证（bot ↔ 用户直聊窗口 oc_）

为批量配置「独立消息播报」等需要直聊 chat_id 的规则取数。核心事实：**p2p 直聊的 oc_ 不在任何 session_key 里**（session_key 直聊形如 `agent:<id>:feishu:direct:ou_…`，只有 ou_），也不在 agent 自己的 sqlite，更不在 channel_ingress_events。唯一可靠来源是共享网关运行日志。本流程 2026-09-18 在 GYL/GTM 7 agent 上端到端验证（6 个双源通过、1 个按规则跳过）。

**先分清目的再动手**：只是要给当前 p2p 用户发一条消息（过程播报、催办、回执）**不需要 oc_**——`lark-cli im +messages-send --as bot --user-id <ou_…>` 直发即可（与 `--chat-id` 互斥；2026-09-21 曾夏杨 p2p 窗口实测。此前为找 oc_ 先跑 chats-list 解析失败、再查 help，白耗 2 次调用）。本 harvest 只在**配置文件要落 oc_**（如批量播报规则的 `{{CHAT_ID}}`）时才走。

## 来源与死路（实测）

- ✅ 主来源：`/tmp/openclaw/openclaw-<YYYY-MM-DD>.log`——**全实例共享**的网关运行日志，按天留存数日。行形如
  `feishu[<bot>]: received message from ou_X in oc_Y (p2p)`，一条同时给出 bot 归属、用户 ou_、窗口 oc_。
  注意区分：`/data/agent/ops/logs/openclaw_<实>.log` 被 start-all.sh 每次重启截断（`>` 覆盖，无轮转），只当实时镜像；共享日志正好补上被截断的时段。
- ✅ 交叉源：各实例 `state/openclaw.sqlite` 的 `audit_events.session_key`——`agent:<id>:feishu:direct:ou_…` 给出每个 agent 的直聊用户 ou_ 集合（/tmp 拷贝 + `mode=ro` python3，取法见 multi-instance-cron-audit 步骤 7）。
- ❌ 死路（实测全空/不可用，勿再探）：agent sqlite 的 `conversations`/`session_conversations`/`session_windows` 全 0 行；`channel_ingress_events` 的 payload/metadata 深度正则提不出 oc_；`delivery_queue_entries` 仅零星 oc_ 且无法归属实例。

## 步骤

1. 从各实例 openclaw.json 的 `bindings` 取 agent↔bot 账号映射（如 main↔main-bot、cqy↔cqy-bot）。完成：bot 名 → 实例+agent 候选表。
2. grep 共享日志（近几天的日期文件 + ops 日志），正则提取 `(bot, ou, oc, kind=p2p)` 配对，按 bot×ou×oc 聚合计数、取最近时间。完成：候选配对表。
3. 交叉验证：配对里的 ou 必须出现在**该实例**审计库的该 agent 直聊 ou_ 集合中——这一步同时解决 **main-bot 跨实例重名**（每个实例都有 main-bot，bot 名无法定位实例，ou_ 归属才能消歧）。完成：每个候选标注 ✅（oc+ou 双源吻合）或 ❌（无法归属实例）。
4. 决策规则：✅ → 填入配置；一个 agent 有多个 p2p 用户时取最近活跃者、并在映射表列出全部；❌（最后直聊早于日志留存窗口）→ **不填不猜**，保留 `{{CHAT_ID}}` 占位 + 自助配置说明（首次与用户对话时从 received message 行自取），映射表标注待办。完成：映射表（agent | oc_ | ou_ | 验证依据 | 状态）。
