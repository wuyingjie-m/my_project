# governance/ — LLM 行为治理组件

> 两个独立可部署的治理组件：**lark-broker**（凭据代理）与 **broadcast-gate**（播报门禁）。
> 设计哲学：对 LLM，提示词是软约束，基础设施才是硬约束。

---

## 一、lark-broker — 集中式飞书凭据代理

### 1.1 解决什么问题

多 Agent 共用一台服务器时，飞书凭据治理面临三层风险：

| 风险 | 无 broker 时的表现 |
|---|---|
| 身份静默串用 | Agent 在长任务中"抄近路"裸调 lark-cli，token 落进错误槽位——**真实事故：2026-09-16 子 agent 串用他人身份发言** |
| 无使用审计 | 出事后无法回答"谁在几点几分用了谁的身份干了什么" |
| 无爆炸半径控制 | 任何拿到脚本执行权的代码可以任意身份调用任何命令 |

### 1.2 架构：两层凭据体系

```
日常路径（单身份、无审计需求）：
  lark-cli → /usr/bin/lark-cli 全局 shim
           → （按 OPENCLAW_AGENT_DIR 路由）agents/<id>/lark-cli 包装脚本
           → export HOME=<agent 凭据目录> → exec 真实 CLI

broker 路径（跨身份任务链、需审计）：
  LARK_BROKER_SUBJECT=<身份> lark-broker <命令>
    → ① subject 必须在 users.json 白名单
    → ② 命令族必须在 ALLOWED 白名单（calendar/minutes/vc/docs/im/wiki/sheets）
    → ③ home/agent_dir 路径不得逃出实例边界（防路径注入）
    → ④ 写 audit.jsonl（status=started）
    → ⑤ 注入该身份的 HOME/XDG/OPENCLAW_AGENT_DIR，exec 对应 wrapper（300s 超时）
    → ⑥ 写 audit.jsonl（status=ok/error）
```

**关键认知**：broker 不是 wrapper 的替代——它调用的就是 wrapper。wrapper 管"钥匙放在哪"（存储隔离），broker 管"谁能用、怎么用、用完留痕"（调用治理）。

### 1.3 文件清单

| 文件 | 说明 |
|---|---|
| `lark-broker.py` | 代理本体（89 行 Python，无第三方依赖） |
| `bin-lark-broker.sh` | 启动器（`exec python3 lark-broker.py "$@"`，放到 `bin/lark-broker` 使用） |
| `users.json.example` | 身份映射表模板：`{"users": {"<subject>": {"home": "...", "agent_dir": "..."}}}` |
| `audit-format.md` | audit.jsonl 行格式与取证查询示例 |

### 1.4 部署

```bash
# 1. 部署到实例目录（假设实例 = /data/agent/openclaw_sxs）
mkdir -p /data/agent/openclaw_sxs/.openclaw/lark-broker/bin
cp lark-broker.py /data/agent/openclaw_sxs/.openclaw/lark-broker/
cp bin-lark-broker.sh /data/agent/openclaw_sxs/.openclaw/lark-broker/bin/lark-broker
chmod 700 /data/agent/openclaw_sxs/.openclaw/lark-broker/bin/lark-broker

# 2. 编写身份映射（按真实路径修改）
cp users.json.example /data/agent/openclaw_sxs/.openclaw/lark-broker/users.json
chmod 600 /data/agent/openclaw_sxs/.openclaw/lark-broker/users.json

# 3. 权限收口：代理本体仅 root 可读写，运行时经 sudo/setpriv 调用 bin 入口
chmod 700 /data/agent/openclaw_sxs/.openclaw/lark-broker/lark-broker.py
```

### 1.5 使用

```bash
# 脚本内声明身份后调用（key 走 stdin/环境变量，绝不落命令行）
export LARK_BROKER_SUBJECT=wyj
/data/agent/openclaw_sxs/.openclaw/lark-broker/bin/lark-broker im +messages-send --as bot ...
```

### 1.6 审计取证

```bash
# 某身份的全部调用
grep '"subject": "jwh"' audit.jsonl

# 某时间窗内的失败调用
grep 'error' audit.jsonl | grep '2026-10-15T'

# 统计各身份调用量
python3 -c "import json,collections; c=collections.Counter(json.loads(l)['subject'] for l in open('audit.jsonl') if '\"started\"' in l); [print(k,v) for k,v in c.most_common()]"
```

生产实测：单实例 3 身份 8000+ 次调用全量留痕；串号事故自 broker 上线后零复发。

### 1.7 设计取舍

- **命令族白名单**而非命令白名单：子命令组合爆炸，按族收口（7 族）足够覆盖日报/周报/知识库场景
- **300s 超时**：飞书 API 正常响应 <5s，超时即异常（防挂死占坑）
- **无 daemon**：纯被动 CLI，无常驻进程、无端口，`ps`/`systemctl` 里看不到它——部署面为零
- **fail-closed**：任何校验不通过直接拒绝退出（非零退出码），绝不降级放行

---

## 二、broadcast-gate — 播报门禁网关插件

### 2.1 解决什么问题

Agent 执行长任务时对用户"静默"：要么全程无反馈，要么结束后一次性刷屏。提示词规范（AGENTS.md 播报条款）是软约束——模型会漏。broadcast-gate 把"播报"变成**工具调用的前置条件**：不播报，就不让调工具。

### 2.2 工作原理

挂载 OpenClaw 网关的 `before_tool_call` 钩子，每次工具调用执行前同步检查：

```
工具调用 → [豁免检查] sessionKey 含 :cron: / :subagent: / heartbeat / :isolated: → 放行
        → [播报自识别] exec + "lark-cli im +messages-send" + "--as bot" → 刷新播报时间戳，放行
        → [规则判定，按 runId 维护状态]
             规则1 PROGRESS_BROADCAST_REQUIRED：run 内首个工具调用前未播报 → 弹回
             规则2 MILESTONE_STALE：距上次播报 > staleMinutes（默认 5 分钟）→ 弹回
             规则2b：始终未播报且已超阈值 → 弹回
        → [弹回] 返回 block:true + blockReason（内嵌补救指令：
           "先用 exec 执行一次开始播报：lark-cli im +messages-send --as bot ..."）
           模型读取后自动补发播报，再重试原调用 → 无需人工介入的纠正闭环
```

### 2.3 工程细节（全部来自真实运行教训）

| 机制 | 原因 |
|---|---|
| `mode: "log" \| "enforce"` 双模式 | 上线前先 log 模式观察误拦率，再切 enforce |
| 同 run 15s 日志去重 | 防止连续弹回刷爆违规日志 |
| 状态表 >500 条时清理 >6h 旧 run | 防内存无限增长；网关重启即清零（run 生命周期短，可接受） |
| 拿不到 sessionKey/runId 时放行 | 宁可漏拦，不可误拦正常任务 |
| 播报调用自识别（正则匹配 exec 参数） | 播报动作本身是工具调用，若不自识别会死锁 |

### 2.4 部署

```bash
# 1. 拷贝插件目录到 workspace（任意实例）
cp -r broadcast-gate /data/agent/openclaw_<实例>/.openclaw/workspaces/<agent>/broadcast-gate/

# 2. 实例 openclaw.json 注册（plugins 段）
{
  "plugins": {
    "load": { "paths": ["/data/agent/openclaw_<实例>/.openclaw/workspaces/<agent>/broadcast-gate"] },
    "entries": {
      "broadcast-gate": {
        "enabled": true,
        "config": {
          "mode": "log",              // 先 log 观察数天，误拦率可控后改 enforce
          "staleMinutes": 5,
          "logFile": "/data/agent/openclaw_<实例>/.openclaw/logs/broadcast-violations.log"
        }
      }
    }
  }
}

# 3. 重启实例网关，观察违规日志
tail -f .openclaw/logs/broadcast-violations.log
```

### 2.5 配套制度（缺一不可）

插件只负责"强制"，"播报什么"由 AGENTS.md 播报规范定义（见 `AGENTS.md.template`）：
- 强制触发点：第 1 个工具调用前必须发"开始"播报
- 节点播报：关键步骤完成、阻塞、转向时各一条，1-3 条为宜（上限 5 条）
- 防刷屏红线：一行以内、隔实质步骤、不贴日志
- 收尾自检：调了工具却零播报 = 违规，先补一条总结播报再给最终回复

生产数据：enforce 模式上线后违规日志累计 109+ 条拦截，两类规则均有命中——门禁强制力经真实运行验证。

### 2.6 已知坑

1. **handler 必须同步返回**：`before_tool_call` 的 async 返回值在该钩子不保证生效——拦截逻辑内严禁 await。
2. **插件路径必须绝对**：`plugins.load.paths` 里的相对路径按网关 CWD 解析，会静默加载不到。
3. **改 config 后必须重启网关**：插件 config 不支持热重载。
