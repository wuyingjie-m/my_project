---
name: openclaw-gateway-plugin
description: 开发、安装、排障 OpenClaw 实例网关插件时使用。涉及 api.on 钩子（before_tool_call 等）、plugins.entries 配置、插件加载失败、网关重启、端口冲突（EADDRINUSE）时使用。
---

# OpenClaw 网关插件开发与运维

## 插件三件套

目录：`<实例>/.openclaw/plugins-src/<plugin-id>/`，三个文件：

- `package.json`：`{"name":"<id>","version":"1.0.0","type":"module","openclaw":{"extensions":["./index.js"]}}`
- `openclaw.plugin.json`：`{"id","name","activation":{"onStartup":true},"configSchema":{...}}`
- `index.js`：`import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry"; export default definePluginEntry({ id, name, register(api) { api.on(...) } })`

完整可用实例（broadcast-gate 弹回式播报门禁：状态机/豁免/审计日志）三件套在已部署的源目录：`/data/agent/openclaw_need/.openclaw/plugins-src/broadcast-gate/`（GTM 同款）——本 skill 目录无 templates 副本，旧引用已失效（9/30 修正）。

## before_tool_call 契约（易错点）

- handler **必须同步返回**——部分钩子的 async 返回值不保证生效
- `{block:true, blockReason}` 终态拦截；blockReason 文本注入模型上下文，写成补救指引即形成"弹回式自愈闭环"（模型自行补动作后重试通过）
- `ctx.agentId/sessionKey/runId` 在部分触发路径**可能缺失**——防御式判断，缺失时放行（宁可漏拦不误拦正常任务）
- 插件配置从 `api.pluginConfig` 读取，来源是 `plugins.entries.<id>.config` **嵌套键**——直接平铺在 `<id>` 下会被 config validate 拒绝（Unrecognized keys）
- `before_tool_call` 不需要 `hooks.allowConversationAccess`（那是对话类钩子的门槛）

## 安装流程

```bash
OPENCLAW_CONFIG_PATH=<实例>/.openclaw/openclaw.json \
  openclaw plugins install --link <插件目录> --force --accept-capabilities
OPENCLAW_CONFIG_PATH=<实例>/.openclaw/openclaw.json \
  openclaw plugins enable <id>
# openclaw.json: plugins.entries.<id> = {enabled:true, config:{...}}
```

- 工具拦截类插件必须 `--accept-capabilities`（否则报 requires capability consent）
- `--link` 保留源目录引用：源目录必须放在持久位置（实例 `.openclaw/plugins-src/` 或长期 workspace），放 /tmp 会在清理后失效
- 完整输出勿用 grep 过滤（"Linked plugin path" 行是成功标志，失败原因可能不含 error 字样）

## 网关重启（高危，逐条核对）

- **改实例 openclaw.json 会触发 config watcher 自动重启**（优雅关闭自己）；无 systemd/supervisor 的网关"只关不启"→ 实例离线（GTM/GYL/need/PJT/QD 实测五次）。改配置前先确认该网关的重启方式。**例外：sxs 主实例网关有 config watcher 自愈**——改它的 openclaw.json 会自动重启并加载新配置/新插件（2026-09-21 实测：broadcast-gate 配置写入后自动生效，弹回日志与拦截 agent 工具调用均为活体证据）；其余 7 实例改配置后需手动拉起
- 孤儿网关重启还原法：
  1. 从 cwd 匹配找 pid：`readlink /proc/<pid>/cwd` 逐个比对实例目录
  2. 抓原环境：`tr '\0' '\n' < /proc/<pid>/environ`（HOME/OPENCLAW_CONFIG_PATH/OPENCLAW_STATE_DIR）
  3. kill 后在原 cwd 用原环境重启：`nohup /opt/openclaw/bin/openclaw gateway run --port <端口> >> <实例>/gateway-run.log 2>&1 &`
- 端口用 `c.gateway.port` 精确读（JSON 路径），**不要 grep -m1 "port"**——配置里可能有多个 port 字段拿错
- 禁止 `pkill -f <关键词>`：会匹配承载命令的 bash 自身（自杀）。从 ss/proc 解析 PID 后精确 kill；睡死进程对 SIGTERM 免疫需 kill -9
- `openclaw gateway restart` 只适用于 systemd 服务化的网关（要求默认路径），孤儿进程会报 "non-default state dir" 被跳过

## 排障速查

| 症状 | 处理 |
| --- | --- |
| install 报 requires capability consent | 加 `--accept-capabilities` |
| config validate 报 Unrecognized keys | 插件配置挪到 `entries.<id>.config` 嵌套 |
| 网关启动后 handler 不跑 | `plugins inspect <id> --runtime --json` 看注册；改插件代码需重启网关 |
| 端口 EADDRINUSE | `ss -tlnp` 查占用者 pid + 各实例 `c.gateway.port` 精确比对——实例运行端口与配置文件可能历史脱节 |
| 重启后插件未加载 | 确认源目录结构（三文件在 `<id>/` 子目录下，勿平铺）后重启网关 |
| 验收 | 三件套：`plugins inspect <id> --runtime --json` / 触发一次钩子场景 / 看插件自身日志 |

## 网关已知事实

- 端口权威来源：`/data/agent/ops/instance-ports.conf` + `/data/agent/ops/status-all.sh` 实测——本文件不维护端口快照，配置端口与实际监听会历史脱节（09-21 已全量对齐：XMT 现 18796、sxs 18797，对齐案例见 review-furnace-modify 的 fqc 条目）
- 修改实例 openclaw.json = 触发 config watcher 自动重启 = 无 supervisor 网关离线（已 5 次实测）
- 网关重启可能触发 state 迁移（`agents/<id>/agent` → `agent.legacy-<ts>`）：数据保留在 legacy 不丢，但 dashboard 历史统计从迁移点重新累积
