# OpenClaw Platform — 企业级多 Agent 协作平台（运维编排 + 行为治理 + 技能资产）

> 一套在单台服务器上运行 10 个业务实例、30+ 个 AI Agent 的完整平台方案。
> 包含：多实例编排脚本、凭据治理组件、LLM 行为门禁插件、16 个生产验证的排障/审计技能、
> 4 个共享业务技能，以及全部配套说明文档。
>
> 自 2026-08 起在真实生产环境持续运行，所有组件均经过真实事故驱动迭代。

## 平台概览

```
┌─────────────────────────────────────────────────────────────┐
│                        飞书（交互入口）                        │
│        用户消息 → 实例网关 → 子 Agent → 工具执行 → 卡片回执      │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│                  宿主机 /data/agent/ops/（编排层）              │
│   start-all / stop-all / status-all / restart-all             │
│   instance-ports.conf（端口注册表）                            │
│   instance-users.conf（降权用户映射）                          │
└──┬──────┬──────┬──────┬──────┬──────┬──────┬──────┬─────────┘
   │      │      │      │      │      │      │      │
┌──▼──┐┌──▼──┐┌──▼──┐┌──▼──┐┌──▼──┐┌──▼──┐┌──▼──┐┌──▼──┐
│GTM  ││GYL  ││need ││PJT  ││QD   ││sxs  ││TeamS││XMT …│  ← 10 个业务实例
│18794││18790││18795││18791││18792││18797││18793││18796│    每实例独立网关
└──┬──┘└──┬──┘└──┬──┘└──┬──┘└──┬──┘└──┬──┘└──┬──┘└──┬──┘
   │      │      │      │      │      │      │      │
┌──▼──────────────────────────────────────────────────▼──────┐
│                        Agent 层（30+ 子 Agent）               │
│   每个 Agent：独立 workspace + 记忆 + 凭据槽位 + 技能集合        │
│                                                              │
│   ┌─────────────────┐   ┌──────────────────────────────┐    │
│   │ lark-broker     │   │ broadcast-gate（网关插件）      │    │
│   │ 凭据代理+审计    │   │ 播报门禁（before_tool_call）    │    │
│   └─────────────────┘   └──────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

## 目录结构

| 目录 | 内容 | 详见 |
|---|---|---|
| `ops/` | 多实例编排脚本、端口/用户注册表、变更管理范本 | [ops/README.md](ops/README.md) |
| `governance/lark-broker/` | 集中式飞书凭据代理（身份校验 + 白名单 + 全量审计） | [governance/README.md](governance/README.md) |
| `governance/broadcast-gate/` | LLM 播报门禁网关插件（工具调用前置条件强制） | [governance/README.md](governance/README.md) |
| `skills/ops/` | 16 个排障/审计/运维技能（真实事故蒸馏） | [skills/README.md](skills/README.md) |
| `skills/shared/` | 4 个共享业务技能（日报/晨报/PPT） | [skills/README.md](skills/README.md) |
| `templates/` | 实例配置模板（脱敏） | [templates/README.md](templates/README.md) |
| `docs/` | 平台架构详解、设计决策记录 | [docs/architecture.md](docs/architecture.md) |
| `knowledge/` | 经验蒸馏产物样例与格式说明 | [knowledge/README.md](knowledge/README.md) |

## 核心设计决策（为什么长这样）

这套平台与传统运维平台的本质区别：**每个治理决策的约束函数都是 LLM 行为**。

1. **多实例物理隔离** —— 不是为了性能，是因为 Agent 会"抄近路"：实例间进程级隔离 + 降权运行，单个实例被打穿不蔓延。
2. **lark-broker 凭据代理** —— wrapper 解决"凭据放哪"，broker 解决"谁在用、怎么用、用完留痕"。LLM 环境下串身份是静默事故（发生过：2026-09-16），broker 把它变成"当场拒绝 + 有据可查"。
3. **broadcast-gate 播报门禁** —— 提示词对模型是软约束（会漏播报），网关 `before_tool_call` 钩子是硬约束：未按期播报的工具调用直接弹回并内嵌补救指令。
4. **确定性优先的自动化** —— 高频流程（日报采集/发布）用冻结 shell 命令跑定时任务，模型只在"总结"环节参与；模型自由度被压缩到只有 1 次身份声明的机会。
5. **技能即资产** —— 每次真实故障的处理过程蒸馏为 SKILL.md（playbook），同类故障不再依赖人的记忆。

## 快速开始

```bash
# 1. 规划实例（编辑注册表）
vi ops/instance-ports.conf     # 实例名 → 网关端口
vi ops/instance-users.conf     # 实例名 → 降权系统用户

# 2. 按模板创建实例配置
cp templates/instance.openclaw.json.example /data/agent/<实例>/.openclaw/openclaw.json
#   填入：飞书 app 凭据、模型 API key、网关 token

# 3. 启动
ops/start-all.sh               # 自动：端口探测 → 降权拉起 → 健康等待 → PID 记录

# 4. 观测
ops/status-all.sh              # 全实例状态一览
tail -f /data/agent/ops/logs/<实例>.log

# 5. 部署治理组件（可选但强烈推荐）
# 见 governance/README.md
```

## 运行数据（截至 2026-10）

- 10 个业务实例 / 30+ 子 Agent，2026-08 至今持续生产运行
- 195 个技能资产（共享 90 + 个人 53 + workshop 沉淀 52）
- 播报门禁拦截日志 109+ 条（PROGRESS_BROADCAST_REQUIRED / MILESTONE_STALE 两类规则均命中）
- lark-broker 审计日志：单实例 3 身份累计 8000+ 次调用全量留痕、零串号复发
- 日报/周报/晨报/巡检 4 类高频流程全自动化，错误可重跑、数据可回归验证

## 配套运营看板

本仓库的姊妹项目 [`openclaw-bot-dashboard`](https://code.aihuishou.com/group-insights/openclaw-bot-dashboard)
（Next.js 全栈）提供：全员 Agent 卡片墙、token 消耗排行、定时任务三档状态追踪、
模型切换、API Key 管理、套餐额度水位等 13 个功能页面 / 40+ API。

## 相关文档

- [docs/architecture.md](docs/architecture.md) —— 平台架构详解（前因后果 + 设计取舍）
- [ops/README.md](ops/README.md) —— 编排脚本逐个讲解 + 二次开发指南
- [governance/README.md](governance/README.md) —— 两个治理组件的原理、部署、运维
- [skills/README.md](skills/README.md) —— 20 个技能的用途索引与触发场景
