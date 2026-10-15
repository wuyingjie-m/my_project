---
name: "instance-core-plugin-upgrade"
description: "升级实例 core/渠道插件（如飞书）时使用：plugins install 报 requires plugin API、CLI 启动报 Skill name must contain（state 迁移失败）、共享 core 升级影响全实例、重启生效与旧 generation 清理"
---

# 实例 core + 渠道插件升级

本机多实例共享一份 core（`/opt/openclaw`，npm prefix 安装），渠道插件按实例各装一份（`<实例>/.openclaw/npm/projects/openclaw-<channel>-*/`）。任何升级先分清动的是哪一层：**升 core 影响全部实例，升插件只影响本实例**。

## 步骤

1. 升级前体检：core 版本 `grep '"version"' /opt/openclaw/lib/node_modules/openclaw/package.json`；目标实例插件版本与 generation 目录 `ls -d <实例>/.openclaw/npm/projects/openclaw-<channel>-*`（多出目录 = 有半成品升级）；实例网关进程用 `pgrep -f openclaw-gateway` 配合 `/proc/<pid>/environ` 的 `OPENCLAW_STATE_DIR` 认实例，不要凭 $HOME 猜。
   完成：说得出 core 版本、目标实例插件版本、网关是否在跑。

2. 插件装不上报 `requires plugin API >=X, but this OpenClaw runtime exposes Y`：插件要求 core API ≥ 自身版本，**干净拒绝、无副作用**，原地重试无意义。唯一解法是先升共享 core：`npm install -g openclaw@<版本> --prefix /opt/openclaw`。升 core 动到全部实例——除非用户明确批准，不得代为执行（2026-09-17 阿祖立过"只准动单实例"的约束）。升完 core 后旧网关进程仍跑旧代码，且懒加载到已被替换的文件会随机 ENOENT（如 conversations 子系统），尽快逐实例重启。
   完成：core 版本达标，或用户明确批准共享升级。

3. core 达标后重跑 `plugins install @openclaw/<channel>@<版本>`，带三环境变量隔离：`env -u OPENCLAW_STATE_DIR -u OPENCLAW_CONFIG_PATH HOME=<实例根> OPENCLAW_CONFIG_PATH=<实例>/.openclaw/openclaw.json OPENCLAW_STATE_DIR=<实例>/.openclaw <cmd>`（运行环境可能已导出这些变量，覆盖前台 `VAR=...` 前缀）。装完只是落盘，**必须重启该实例网关才生效**（独立 shell 安装不会自动重启）。
   完成：目标实例插件 package.json 显示新版本。

4. 若 CLI 任意命令启动即报 `Skill name must contain at least one letter or number`（state-migrations 阶段，堆栈经 `migrateLegacySkillWorkshopProposals → resolveSkillProposalTarget`）：肇事者**不是 SKILL.md 文件**，是 sqlite `state/openclaw.sqlite` 表 `skill_workshop_proposals` 里 `record_json.target.skillKey` 纯中文（无 ASCII 字母数字）的 pending 提案（2026.9.4 起 skillKey 规范化要求含 ASCII）。修法：解析 record_json 找出违规记录 → 完整备份到 /tmp → 对确认过时的重复提案把 `status` 改为 `rejected`（列和 record_json.status 同步改，附 status_reason）——迁移器 `status !== "pending"` 即跳过；仍要保留的真实提案则把 skillKey 改成 ASCII 并同步 target.skillDir/skillFile。
   完成：重查无 `status=pending` 且 skillKey 缺 ASCII 的记录，原命令重跑通过。

5. 重启网关后验证：日志出现正常 `Started streaming`/`dispatch complete`；旧版本 generation 目录残留无害，`openclaw doctor --fix`（同环境变量、网关停止时）可清理；多 agent 实例的 `skills list` 必须加 `--agent <id>`，否则报 "no explicit owner"。
   完成：实例以新 core+插件运行，抽查命令无 ENOENT/迁移报错。

6. 安装全新本地钩子插件（非渠道升级；2026-09-21 broadcast-gate 首次部署实测）：三件套结构、`--link` 安装、`--accept-capabilities` 能力同意、钩子契约（`before_tool_call` 同步返回、`{block:true, blockReason}` 终态）均见 openclaw-gateway-plugin，本 skill 唯一补充：插件 config 平铺在 `plugins.entries.<id>` 下时不仅 config validate 拒绝（Unrecognized keys），**gateway restart 也会拒绝执行**（服务不中断但改动不生效）。
   完成：plugins list 显示 enabled、config validate 通过。

## 坑

- 升级**不**修复飞书流式卡片/长任务中间播报问题（300309、block 文字不到达——2026.8.2 与 2026.9.4 该代码路径一致）。诊断与判定见 channel-delivery-diagnosis 第 3e 节。
- 升级/配置会话里手改实例 `openclaw.json` 极易串实例路径（2026-09-18 真实事故：fqc 的 entries 被写成 GTM 路径 → workspace is missing）——路径替换用脚本或占位符，改完必 diff 自检；出事后按 agent-workspace-repair 修复，通常无需恢复备份。
- core 是共享单点："只动一个实例"的升级只在插件层做得到；用户要求实例级隔离时，禁止顺手升 `/opt/openclaw`。
- **非服务化网关重启（环境抓取还原法）**：多数实例网关是无 unit 孤儿进程（ppid=1 的 session scope，abandoned，无自愈）——`systemctl` 与 `openclaw gateway restart`（要求服务化路径）都不可用。重启前 `tr '\0' '\n' < /proc/<pid>/environ` 抓 HOME/OPENCLAW_CONFIG_PATH/OPENCLAW_STATE_DIR 与 cwd，kill 后原目录按原环境 `nohup openclaw gateway run --port <port> >> gateway-run.log 2>&1 &` 还原。⚠️ 重启可能触发 state migration（`agents/<id>/agent` → `agent.legacy-<ts>`，数据在重建目录）；且 GTM 曾被未知 SIGTERM 干净关闭一次（2026-09-21，归因未明）——无自愈进程被关即离线，重启后必须盯端口监听恢复。
