# ops/ — 多实例编排体系

> 单台宿主机承载 10 个 OpenClaw 业务实例的完整编排方案。
> 设计目标：配置即文档、故障域隔离、零手工干预拉起。

## 文件清单

| 文件 | 用途 | 关键机制 |
|---|---|---|
| `instance-ports.conf` | 实例 → 网关端口注册表（18790-18799） | 每行一条 `实例名=端口`，`sync_port_file` 自动补齐缺失实例并分配下一个空闲端口 |
| `instance-users.conf` | 实例 → 降权系统用户映射（ocs_need、ocs_gyl…） | 未列出的实例默认 root 启动（不推荐） |
| `start-all.sh` | 全量拉起 | 核心脚本，见下方逐段讲解 |
| `stop-all.sh` | 全量停止 | 按 PID 目录逐个 TERM，等待退出 |
| `status-all.sh` | 状态一览 | PID 存活 + 端口监听双重检查 |
| `restart-all.sh` | 全量重启 | stop-all + sleep 2 + start-all |
| `agent-tui.sh` | 终端管理面板 | 交互式查看/进入各实例（含历史备份，可看演进） |
| `expose-openclaw-tailscale.sh` | 内网安全暴露 | 通过 Tailscale 网络暴露网关端口，不裸奔公网 |
| `update-openclaw-json.sh` | 配置批量更新 | 跨实例修改 openclaw.json 的安全封装 |
| `fix-pjt-legacy-20260921.sh` | 一次性历史修复脚本 | 保留作变更追溯范本（命名规范：`fix-<目标>-<日期>.sh`） |
| `mcp-rollout-202610/` | MCP 配置切换的变更管理文档 | 按实例出申请单（GTM/PJT/QD 等），含回滚预案——变更管理范本 |

## start-all.sh 逐段讲解

### 1. 防呆：OPENCLAW_BIN 路径修正

```bash
case "$OPENCLAW_BIN" in
  */.openclaw/*)
    echo "WARN: OPENCLAW_BIN resolves inside an instance state dir..."
    OPENCLAW_BIN="/usr/local/bin/openclaw"
    ;;
esac
```

**为什么需要**：如果在 agent 会话里执行本脚本，PATH 会把 `openclaw` 解析到实例私有 shim（`<实例>/.openclaw/...`）。降权用户无法穿越该路径，导致拉起失败。检测到路径落在任何实例 state 目录内时，自动回退系统路径。

### 2. 端口三重校验

拉起每个实例前依次检查：

1. `port_is_recorded`：端口是否已登记在 instance-ports.conf（防端口漂移）
2. `is_port_used`：端口是否已被其他进程占用（`ss -ltn` 精确匹配 127.0.0.1/::1）
3. PID 文件指向的进程是否存活（`kill -0`）——存活则跳过（幂等重入）

### 3. 降权拉起（核心安全设计）

```bash
setpriv --reuid "$run_user" --regid "$(id -g "$run_user")" \
  --init-groups --inh-caps=-all --ambient-caps=-all \
  nohup "$OPENCLAW_BIN" gateway --port "$port" > "$log_file" 2>&1 &
```

- `setpriv --reuid/--regid`：以实例专属用户（如 ocs_ppxs）运行，进程级隔离——单个实例被打穿不蔓延到其他实例
- `--inh-caps=-all --ambient-caps=-all`：剥夺全部继承/环境能力（capabilities），最小权限
- 环境三件套必须显式传：`HOME=实例根目录`（OpenClaw 配置解析在 `$HOME/.openclaw/`）、`OPENCLAW_CONFIG_PATH`、`OPENCLAW_STATE_DIR`

**注意**：HOME 语义是「实例根目录」（如 `/data/agent/openclaw_PPXS`），不是 `.openclaw` 目录本身。传错会导致 CLI 报 Unknown agent id、或双层路径静默读空。

### 4. 健康等待

拉起后轮询 5 次（每次 1s），同时检查 PID 存活 + 端口监听，两者皆满足才报 OK。失败不中断整体，继续拉起下一个实例（故障实例单独排查）。

## 二次开发指南

**新增实例**：
1. `useradd -m -s /bin/bash ocs_<name>` 创建专属系统用户
2. `mkdir -p /data/agent/openclaw_<name>/.openclaw && cp templates/instance.openclaw.json.example ...` 创建配置
3. 在 instance-ports.conf / instance-users.conf 登记各一行
4. `ops/start-all.sh`（幂等，只会拉起新实例）

**改动原则**：
- 编排脚本改动前先 `cp xxx.sh xxx.sh.bak-<日期>-<目的>` 备份（目录里能看到多次真实备份的历史）
- 涉及实例配置的批量变更，参考 `mcp-rollout-202610/` 的申请单格式：每实例一页，含变更项、验证步骤、回滚命令

## 已知坑（真实事故记录）

1. **配置端口漂移**：实例 openclaw.json 里的 `gateway.port` 可能与实际监听端口脱节（手工改过启动参数）。**以 instance-ports.conf 为准**，不要信 config（案例：sxs config 写 18796 实际 18797，按 config 连会把 token 发给 XMT 的网关 → unauthorized）。
2. **`pkill -f openclaw` 自杀**：模式会匹配到自己 shell 的命令行。停实例一律用 PID 文件。
3. **EADDRINUSE**：手动 nohup 拉起会和已有网关抢端口。先查 `status-all.sh` 再动手。
