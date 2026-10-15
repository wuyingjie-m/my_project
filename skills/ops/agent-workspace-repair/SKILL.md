---
name: "agent-workspace-repair"
description: "子 agent 聊天报 workspace is missing / agent 配置路径串到别的实例时使用：先查配置指针而不是恢复备份，修 entries 路径、doctor --fix 迁移、按 ops 方式重启网关并修正 pid 文件。"
---

# Agent Workspace Missing 修复

多实例服务器上，与某子 agent 聊天时对端报 `⚠️ This agent's workspace is missing on the gateway host...`。**先别恢复备份**——2026-09-18 实测（XMT/fqc）：工作区数据一直完好在本地，真正原因通常是该实例配置 `openclaw.json` 里 `agents.entries.<id>` 的 `workspace`/`agentDir` 被写成了**别的实例**的路径（升级/改配置会话里复制粘贴串路径）。

## 步骤

1. 判定数据与配置（不动手改）：`ls <实>/.openclaw/workspaces/<id>/` 确认工作区在本地且内容完好；读 `<实>/.openclaw/openclaw.json` 的 `agents.entries.<id>` 看 workspace/agentDir 指向哪个实例；再查被指向的实例配置是否真有该 agent（真有则可能双实例争用，先报告操作者确认归属）。完成：能说出工作区是否在、配置错指到了哪。
2. 修配置：`cp -a openclaw.json openclaw.json.bak-<ts>-fix-<id>` 备份；用精确替换只改 `workspace`/`agentDir` 两行的实例段；`python3 -c "import json;json.load(...)"` 校验合法；`diff 备份 现文件` 必须只出现目标两行。完成：JSON 合法且 diff 最小。
3. 观察热加载：ops 日志 `/data/agent/ops/logs/openclaw_<实>.log`（用 `readlink /proc/<pid>/fd/1` 核实就是该网关的 stdout）。若出现 `config reload failed: StartupMaintenanceRequiredError: Legacy workspace setup state requires migration ... run openclaw doctor --fix` → 停该实例网关后执行 `env -u OPENCLAW_STATE_DIR -u OPENCLAW_CONFIG_PATH HOME=<实根> OPENCLAW_CONFIG_PATH=<实>/.openclaw/openclaw.json OPENCLAW_STATE_DIR=<实>/.openclaw openclaw doctor --fix`（停自己部署的网关有自杀风险，见 channel-delivery-diagnosis 3d）。预期变更：HEARTBEAT.md 迁入 cron scratch、TOOLS.md 并入 AGENTS.md（原文件归档）、workspace-state 文件改名 `*.migrated.<hash>`。完成：doctor changes 列出迁移项，复查无该 StartupMaintenanceRequiredError。
4. 按 ops 方式重启：`cd <实根> && env HOME=<实根> OPENCLAW_CONFIG_PATH=<实>/.openclaw/openclaw.json OPENCLAW_STATE_DIR=<实>/.openclaw nohup /usr/local/bin/openclaw gateway --port <端口> >> /data/agent/ops/logs/openclaw_<实>.log 2>&1 &`，端口取 `/data/agent/ops/instance-ports.conf`。完成：端口 LISTEN、日志 `gateway ready` + `<channel>[<bot>]` 的 `ws client ready`、无 workspace is missing。
5. 修 pid 文件：手工启动时 `$!` 可能记到外壳 shell 而非网关进程——`pgrep -f openclaw-gateway` 配合 `/proc/<pid>/environ` 的 `OPENCLAW_STATE_DIR` 找到真实 pid（进程名显示为 `openclaw-gateway`），写入 `/data/agent/ops/pids/openclaw_<实>.pid`。完成：pid 文件指向 environ 匹配的进程，`start-all.sh` 不会因此误判重启。
6. 端到端验证：请用户给该 agent 发一条消息，日志应见 `dispatching to agent` → `dispatch complete (queuedFinal=true, replies=N)`。遗留警告 `agent database ... uses schema version 1`（runtime-tool-schemas / 持久化媒体迁移）**不阻塞聊天**，留到下次维护窗口（再停网关跑一轮 doctor --fix）清理即可。完成：观察到一次成功 dispatch。
