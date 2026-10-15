# templates/ — 实例配置模板

## 文件清单

| 文件 | 用途 |
|---|---|
| `instance.openclaw.json.example` | OpenClaw 实例主配置模板（含逐项注释） |

## 占位符核对表

复制模板后必须替换的占位符（`grep -o '<[A-Z_]*>'` 可快速核对）：

| 占位符 | 生成/获取方式 | 安全等级 |
|---|---|---|
| `<GATEWAY_TOKEN>` | `openssl rand -hex 24`（每实例独立） | 高：泄露=可直连网关下发指令 |
| `<GATEWAY_PORT>` | 查 `ops/instance-ports.conf` 注册表 | — |
| `<实例>` | 实例目录名，如 `openclaw_PPXS` | — |
| `<agent-id>` | 子 agent 标识（如 wyj、jwh） | — |
| `<FEISHU_APP_ID>` / `<FEISHU_APP_SECRET>` | 飞书开放平台 → 企业自建应用 → 凭据与基础信息 | 高：secret 泄露=可伪造机器人 |
| `<授权用户 open_id>` | 飞书开放平台通讯录，或从消息事件里取 | — |
| `<Agent 显示名>` | 飞书侧显示用名称 | — |

## 部署步骤

```bash
INST=openclaw_<名字>
mkdir -p /data/agent/$INST/.openclaw
cp templates/instance.openclaw.json.example /data/agent/$INST/.openclaw/openclaw.json
vi /data/agent/$INST/.openclaw/openclaw.json      # 替换占位符
chown -R ocs_<名字>:ocs_<名字> /data/agent/$INST   # 归属降权用户
chmod 600 /data/agent/$INST/.openclaw/openclaw.json

# 启动（幂等，只拉起新实例）
ops/start-all.sh
```

## 重要：API key 的生效位置不在本文件

`models.providers.*.apiKey` 字段**不是生效来源**（实测 `openclaw models status` 的 `effective=` 才是真相）。
生效优先级：per-agent sqlite `auth_profile_store` > 环境变量 > models.json 内嵌字段（不生效，仅占位/回显）。

换 key 的正确姿势：

```bash
# 官方路径（写 auth profile + 更新 config + 网关热重载）
HOME=/data/agent/openclaw_<实例> openclaw models auth paste-api-key \
  --agent <agent-id> --provider zhipuglm   # key 走 stdin
# 验证：Auth overview 的 effective= 指纹变为新 key
HOME=/data/agent/openclaw_<实例> openclaw models status
```

## 已知坑（真实事故）

1. **端口漂移**：本文件 `gateway.port` 与实际监听端口脱节时（见 ops/README.md），以 `instance-ports.conf` 为准。
2. **config 权限回写**：root 身份跑 CLI 会把 config 重写为 root:root/644，导致降权网关 EACCES——跑完 CLI 必须 `chown`/`chmod` 回实例用户与 600。
3. **paste-api-key 会原子重写 config**：同上，写完核对权限；且它写 `<provider>:default`，若 agent 残留旧的 `<provider>:manual` profile 会反向遮蔽新 key（ logout 清理，见 skills/ops/model-balance-check）。
