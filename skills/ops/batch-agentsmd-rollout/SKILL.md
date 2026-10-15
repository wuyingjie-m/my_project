---
name: "batch-agentsmd-rollout"
description: "给实例子 agent 批量写入/更新 AGENTS.md 规则（含播报群切换、单 agent 纠偏）并替换 {{INSTANCE}}/{{AGENT_ID}} 占位符时使用；含静态插入与数据驱动变体（per-agent chat_id 取数交叉验证、环境嵌入、节替换）、大小写不一致、幂等跳过、20000 字符注入上限、main 例外等决策规则。"
---

# 子 agent AGENTS.md 批量写入

向一批 OpenClaw 实例的子 agent AGENTS.md 顶部插入统一规则（如第零铁律）并替换实例/agent 占位符。**子 agent 定义**：`.openclaw/agents/` 下除 `main` 外、且 `.openclaw/workspaces/` 有对应目录的 agent；各实例主 agent（`<实>/.openclaw/workspace/`）不写。

## 步骤

1. 盘点目标：`ls -d /data/agent/openclaw_*/`，每实例 `ls .openclaw/agents`（排除 `main`）。**agent id 与工作区目录名可能大小写不一致**（实例 TeamS：agents/`data_group` vs workspaces/`Data_Group`，以 `openclaw.json` 的 `agents.entries.<id>.workspace`/`agentDir` 为准）；无工作区目录的 agent 跳过并记录。文件里已有目标规则的（如已含「第零铁律」）幂等跳过，不重复插入。**插入前检查目标文件字符数**（python len，非 wc -c 字节数）：AGENTS.md 注入上限 20000 字符，超限尾部被静默截断（2026-10-04 data_group 实测 20169 字符，尾部播报节被切掉；修剪后须重验关键节完整）。若插入后会超限，先修剪死样板节（如无心跳配置的 Heartbeats）并留一行说明。完成：拿到 实例×agent 清单与各自真实工作区路径，且插入后字数均在限内。
2. 脚本批量写，不要逐文件手改：`python3 scripts/write_tielu_all.py <实例名...>`（必须显式传实例名，防误伤全服）。脚本内置规则模板 RULE，源头是 wyj 实例 AGENTS.md 顶部的「第零铁律」——规则文本变了先改 AGENTS.md 再同步脚本；幂等标记自动取 RULE 首行，换规则文本无需改代码。行为：插入点为文件第一个 `## ` 标题前、保留原权限、AGENTS.md 缺失时按默认头新建。完成：脚本报告逐 agent 列出 inserted / created / already-has。
3. 全量自检：每目标 `grep -c '第零铁律' AGENTS.md` = 1；无 `{{INSTANCE}}`/`{{AGENT_ID}}`/`__TOKEN__` 残留；文件中实例路径均属于该 agent 自己的实例（抽查路径唯一性，防串写）；各实例 `<实>/.openclaw/workspace/AGENTS.md` 不含该规则（main 未被触碰）。**字符数上限视角**：注入上下文按字符计（约 20000 上限，超限**静默裁掉尾部、无任何报错**，且被裁的常是刚写入的节；CRLF 文件 wc -c 比字符数膨胀，用 python len() 或跳闸日志确认——2026-10-04 data_group 实测 20169 字符被截）。追加/替换后若接近上限，修剪无心跳配置等死样板节。完成：全部通过，每个跳过项都有原因。

## 数据驱动变体（per-agent 值 + 节替换，如「长任务播报」的 chat_id/环境嵌入）

规则里含**每个 agent 不同的运行时值**（如 bot 与用户直聊窗口的 chat_id）或需要**替换已有小节**而非顶部插入时，在步骤 1 盘点后改走本分支。模板以源规则文件为准先同步到本 skill 的 `templates/` 副本（规则变了先改源头再同步，同步骤 2 约定）。

4. 取值与交叉验证：按支持文件 `chatid-harvest.md` 从共享网关日志 + 各实例 audit_events 双源提取并交叉验证。两源不吻合、或该 agent 最后一次直聊早于日志留存窗口的，**跳过不猜**：保留 `{{CHAT_ID}}` 占位并附自助配置说明。完成：每个 agent 有「已验证值 / 明确跳过原因」之一。
5. 节替换写入：备份 `.bak-<ts>-<用途>`；定位 `## 标题` 到下一个 `^## ` 的整节替换。**re.sub 的 replacement 必须传 lambda**——模板含 `\` 续行符（lark-cli 命令），字符串直传会被当转义序列吃掉；节在文件尾无下个标题时退化为切片替换。保留原权限。完成：`grep` 确认 per-agent 值/env 三行/触发点各就位、无占位符残留、备份存在。
6. 环境嵌入配套：env 三行（OPENCLAW_AGENT_ID/AGENT_DIR/LARK_BROKER_SUBJECT）指向的 `agents/<id>/lark-cli` 包装脚本与 `home/` 槽位**必须真实存在**，否则 shim 静默 fallback 身份串号——写入前核查存在性，缺失按 lark-cli-repair 步骤 3 的模板补建（凭据首次授权由 agent 自己完成，AGENTS.md 里的 scope 失败重试指引覆盖此步）。完成：wrapper/home 存在性核查表全绿，缺口列入报告。
7. **纠偏派单（配置已改、但目标 agent 保有长会话时）**：长会话 agent 会沿用上下文里缓存的旧命令/旧值——纠偏指令必须包含**"重读 AGENTS.md 对应节"的显式步骤**，并以 transcript 铁证确认改后行为，光告知新值无效（2026-10-08 data_group：播报群已切新群仍把 7 条播报发往旧 chat_id；派发"重读 AGENTS.md + 向新目标发验证消息"后恢复）。可在规则节内同步插入防复发提示行（如"发播报前以本节 chat_id 为准，禁用会话历史旧命令"）。**同类坑的语义判定（2026-10-04 实测）**：规则内的历史失效备注（如「chat_id X 已失效」）不拦用户明示切回——按用户指令执行，旧值降级为备注中「备用」并同步更新备注日期；切换前用目标 agent 身份实测目标群：报 `not_configured` = **lark-cli 凭据失效**（需重授权，非 AGENTS.md 问题——此时不发验证消息，留待重授权后，修复流程见 lark-cli-repair），报「bot 不在会话」= 群不可达，报 `Unknown agent id` = HOME 传错（应实例根目录）。渠道账号（config 的 `channels.feishu.accounts.<id>`）**不是 agent**——用户以渠道账号名（如白板/baiban）指称时先确认映射到哪个 agent，勿新建同名 agent。完成：transcript 可见重读动作 + 纠偏后行为落位。