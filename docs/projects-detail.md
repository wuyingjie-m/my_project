# 项目一：企业级多 Agent 协作平台（OpenClaw 多实例编排 · 治理 · 蒸馏一体化运营系统）

## 项目简介

部门在推进 AI 落地时面临四个结构性问题：单点对话无法沉淀为可复用流程；Agent 持有的飞书凭据存在串用风险；LLM 行为具有非确定性，任务执行过程不可观测、不可审计；单个 Agent 踩过的坑无法被其他 Agent 复用，导致同类错误反复发生。本项目从 0 到 1 设计并长期运营一套多实例多 Agent 协作平台：以飞书为统一交互入口，以多实例隔离为安全边界，覆盖任务自动化、技能资产化、行为治理、经验蒸馏的完整闭环。平台自 2026-08 起持续生产运行。

**技术栈**：OpenClaw（Agent 运行时）、Node.js / Python / Bash、飞书开放平台 API（im/docs/wiki/sheets/bits）、Linux（systemd、多用户降权、Tailscale）、SQLite、MCP / Function Calling、Prompt Engineering

## 总体架构

平台采用「一台宿主机 → 多业务实例 → 多子 Agent」的三层拓扑：

- 宿主机层：统一的 ops 编排体系负责全部实例的启停、状态探活与端口管理；
- 实例层：按业务线划分为 10 个独立 OpenClaw 实例（GTM/GYL/need/PJT/PPJD/PPXS/QD/sxs/TeamS/XMT），每个实例拥有独立的网关进程、配置、状态库与凭据存储；
- Agent 层：每个实例内按职能拆分多个子 Agent（共 30 个），各有独立 workspace、记忆体系与技能集合。

交互统一从飞书进入：用户消息 → 实例网关 → 对应子 Agent → 工具/技能执行 → 飞书卡片回执。所有出站认证经自研 lark-broker 集中代理，所有行为可经审计日志回放。

## 主要工作

### 1. 多实例编排与进程级隔离架构

**起因**：早期单实例承载全部业务，配置互相污染，一个业务侧的故障会拖垮所有 Agent。拆分后单机面临「10 个网关进程如何管理」的运维问题。

**方案与实现**：

- 设计配置即文档的编排体系：固定端口表（18790-18799）与实例-系统用户映射表分离维护，启动脚本读表拉起，杜绝硬编码；
- 统一编排脚本集：`start-all` / `stop-all` / `status-all` / `restart-all`，带 PID 目录管理、启动前端口占用探测（`ss -ltn`）、启动等待与防重复拉起；
- 最小权限降权：为每个实例分配专属系统用户（ocs_need、ocs_gyl、ocs_gtm 等），实例间进程级隔离——单个实例被打穿不影响其他实例；
- 防呆设计：agent 会话的 PATH 会把 openclaw 解析到实例私有 shim（降权用户无法穿越该路径），启动脚本检测到 `OPENCLAW_BIN` 落在实例目录内时自动回退系统路径。

**✦ 集群体现**：`/data/agent/ops/`（`start-all.sh`、`instance-ports.conf`、`instance-users.conf`、`status-all.sh`），10 实例长期并行运行；`expose-openclaw-tailscale.sh` 管理内网暴露，服务不裸奔公网。

### 2. 集中式凭据代理与身份治理（lark-broker）

**起因**：2026-09-16 发生真实串号事故——子 Agent 在群聊中使用了错误身份发言。复盘发现根因是凭据可被 Agent 自由访问且无使用审计，而 LLM 在长任务中会「抄近路」，传统的「约定式」防线对模型不可靠。

**方案与实现**：

- 自研 lark-broker 集中代理：全部飞书认证经统一 Python 代理转发，各 Agent 凭据分槽位隔离存储（`agents/<id>/home/`），Agent 侧只持专属 wrapper；
- 全量审计：每次调用写入 `audit.jsonl`（时间、身份、动作），可事后取证；
- 制度化防线：AGENTS.md 第零铁律——凭据只进本 agent 专属目录、跑完必验身份（每次发消息后回验 bot identity）、已知他人账号黑名单。事故直接固化为硬规则，此后零复发。

**✦ 集群体现**：各实例 `.openclaw/lark-broker/`（`lark-broker.py` + `users.json` 账户映射 + `audit.jsonl` 全量审计日志）；30 个 Agent 的独立凭据槽位；各实例 AGENTS.md 第零铁律章节（含事故日期与教训记录）。

### 3. 技能（Skill）资产体系与生命周期管理

**起因**：各 Agent 重复造轮子，且个人经验（尤其排障经验）随会话丢失。需要把「怎么做事」变成可版本化、可评审、可推广的资产。

**方案与实现**：

- 三级组织 + 7 级优先级：共享库（实例全员可用）→ 个人库（单 Agent）→ Workshop 沉淀库（agent 自主提案的经验技能），同名技能高优先级覆盖低优先级，支持 extraDirs 跨实例共享；
- 生命周期管理：提案（skill workshop）→ 夜间巡检评审 → 发布 → 全员推广，技能像代码一样有评审流程；
- 全员推广闭环：定期盘点全员技能清单，执行「收集 → 归类 → 提炼 → 返还」，把某个 Agent 的好做法蒸馏成全员通用技能；
- 召回机制取舍：候选集规模下采用「描述清单全量注入 + 模型自选」而非向量检索——规避检索漏召回风险、省去向量库运维，用 description 触发词设计与 allowlist 收窄保证选择准确率，显式 `$name` 引用做确定性兜底。

**✦ 集群体现**：全集群累计沉淀 195 个技能（各实例 `workspace/skills/` 共享 90 + Agent 个人 53 + `workshop-skills/` 沉淀 52）；personal-work-report、html-ppt 等跨实例通用技能；channel-delivery-diagnosis、lark-cli-repair 等排障类经验技能全部技能化。

### 4. 面向 LLM 行为特性的治理护栏（播报规范）

**起因**：Agent 执行长任务时对用户「静默」——要么长时间无反馈，要么结束后一次性刷屏几十条消息；流式卡片在飞书渠道存在不刷新缺陷。这类问题无法靠代码修复（模型行为问题），只能靠提示词制度 + 渠道兜底。

**方案与实现**：

- 制定任务播报规范：长任务必须「开始播报 → 节点播报 → 结果播报」，防刷屏红线（消息条数/频率上限），收尾必做自检；
- 渠道缺陷兜底：针对流式卡片不刷新问题设计独立消息兜底方案（卡片失败时降级为纯文本消息）；
- 持续迭代：规范基于真实违规案例演进 3+ 个版本（09-17 独立消息兜底 → 09-18 严格版 → 09-23 禁止自动评审），每版都标注当时的违规案例，形成「违规 → 复盘 → 规则升级」的闭环。

**✦ 集群体现**：各实例 AGENTS.md「长任务播报」章节（含三版演进记录与案例）；飞书侧播报门禁配置（`openclaw.json.bak-20260921-broadcast-gate` 备份可溯）。

### 5. 行为审计与运营可观测体系

**起因**：管理层需要回答「AI 到底用了多少、省了多少」；运维需要回答「某 Agent 昨天干了什么」。原生会话日志分散在各实例，无法跨实例聚合分析。

**方案与实现**：

- 自研运营看板（见项目二）承载全部可观测能力；
- 跨实例审计能力：基于各实例 state 库的 `cron_jobs` / `transcript_events` 表做统一取证，支持「任意时间窗内某 Agent 的行为回放」；
- 指令遵循率量化：agent-broadcast-audit 技能统计每个 Agent 的播报合规率（应播报任务中实际播报的占比），定位零播报 Agent、对比历史执行率——对模型行为做 evals 式量化而非普通日志监控；
- 定时任务治理：multi-instance-cron-audit 技能跨实例盘点全部定时任务，配合「建完必试跑」策略消灭僵尸任务。

**✦ 集群体现**：review-furnace 看板 + agent-broadcast-audit / multi-instance-cron-audit 两个审计技能；数据源为 10 实例的 `openclaw.sqlite`（`cron_jobs`、`transcript_events`）。

### 6. 经验蒸馏与故障自愈机制

**起因**：Agent 会话之间无状态（模型「失忆」特性），踩坑经验不沉淀就会反复付学费；高频故障（渠道投递失败、workspace 异常、CLI 授权失效）每次都人工排查成本过高。

**方案与实现**：

- 三级记忆体系：每日 memory 文件（原始日志）→ MEMORY.md（策展记忆）→ 每日 lessons；
- 自动蒸馏管线：morning-knowledge-distill 夜间任务自动将各子 Agent 日报中的坑与解法蒸馏为结构化知识 + INDEX 索引，经验不过夜；
- 故障自愈技能化：把高频故障的排查过程本身沉淀为可复用排障技能（workspace-repair、channel-delivery-diagnosis、lark-cli-repair 等），故障处理经验成为资产；
- 配置变更纪律：修改前必备份且命名带日期与目的（如 `openclaw.json.bak-20260921-broadcast-gate`），回滚路径永远存在。

**✦ 集群体现**：`memory/` 按日 lessons 文件、morning-knowledge-distill 定时任务、`workshop-skills/` 中的排障技能族、各实例 config 备份链。

## 项目成果

1. 平台稳定支撑 10 个业务实例 / 30 个 Agent 的日常生产运行（2026-08 至今），日报、周报、晨报、巡检等高频流程全自动化；
2. 累计沉淀 195 个标准化技能与持续更新的蒸馏知识库，新场景通过技能复用即可接入；凭据治理后串号事故零复发；
3. 播报合规率、任务执行情况、token 消耗全部可量化、可回溯，团队 AI 使用从黑盒变为可运营资产。

---

# 项目二：Review Furnace —— 多实例 Agent 运营监控与治理看板（Next.js 全栈）

## 项目简介

多 Agent 平台运行后出现新的运营黑盒：30 个 Agent 分散在 10 个实例里，谁在用、用了多少 token、套餐额度还剩多少、哪个定时任务挂了、模型该不该切换——全部依赖登录各实例手工查库。本项目自研一套集中式运营看板，将全部实例的运行数据聚合到单一 Web 界面，并反向打通「看板直接治理」能力（切换模型、更换 API Key、重启网关）。（技术栈：Next.js 16 + TypeScript + Tailwind 4 + Node 内置 node:sqlite，systemd 托管，部署于宿主机 3000 端口）

## 功能全景（13 个功能页面 / 40+ API 路由）

- Agent 总览：全员 Agent 卡片墙，实例分组展示；
- 全局概况：当前周每 Agent token 消耗排行榜 + 全局总消耗 + 历史趋势图（日/周/月桶），支持实例筛选；
- 今日播报：全部定时任务的三档状态分类（已完成 / 暂失败 / 待开始），30 秒自刷；Agent 任务追踪模块按 Agent 分组展示子任务与长期任务明细；
- Agent 日报：按 Agent+日期聚合会话事实，直连模型自动生成昨日日报；
- 模型管理：可视化切换每个 Agent 的主模型与 fallback 链，写穿透到各实例网关配置；
- API Key 管理：实例级密钥池指纹分组展示 + 点选式换 Key；
- 套餐额度水位：多套餐池的 5 小时窗口 + 周窗口用量百分比实时水位；
- 其余：会话查询、统计报表、告警中心、技能库、网关状态与日志、像素办公室、R&D Council、自改进模块。

## 架构与实现原理

### 1. 数据层：直读各实例状态库，不侵入 Agent 运行时

- 实例自动发现：扫描 /data/agent/ 下全部 OpenClaw 实例目录，解析各实例的 `.openclaw` 状态目录、配置与网关端口；
- 定时任务数据：直接读各实例 `openclaw.sqlite` 的 `cron_jobs` 表（`isRunning` / `lastStatus` / `consecutiveFailures` / `enabled` 等字段），一次性任务（`schedule.kind=at`）在解析层剔除不参与统计；
- 行为与消耗数据：`transcript_events` 表聚合 token 消耗（按日/周/月分桶），会话事实读双路径（per-agent sqlite 为主、`sessions/*.jsonl` 归档兜底）；
- 关键路径语义坑（实测踩坑修复）：实例对象的 homeDir 指向 `.openclaw` 目录本身，再拼一层 `.openclaw` 会得到不存在的双层路径且静默读空——曾导致 Key 池首验为 0，靠路径语义修正解决。

### 2. 缓存层：SWR + 落盘双层缓存，保证重查询秒回

- 四个重路由（config / stats-all / agent-status / agent-activity）采用「内存 SWR 缓存 + 过期后台单飞刷新 + `.api-cache/*.json` 落盘」三层结构，服务重启后磁盘缓存即恢复，冷启动无雪崩；
- 统计源用 Node 内置 node:sqlite 只读连接（busy_timeout 防锁、120 天窗口），每 Agent 另有 5 分钟细粒度缓存；
- 缓存一致性教训：被 SWR 包装的函数必须返回纯数据对象——曾因返回 NextResponse 被序列化成空壳存入缓存，导致统计空显示两天；PATCH 写操作后必须同时清内存 + 磁盘两层缓存，否则前端会从磁盘旧快照回填旧数据。

### 3. 写路径：反向治理——看板直接操作网关

- 模型切换：PATCH `/api/config/agent-model` → 解析目标实例真实网关端口（以 ops 端口表为准，修复了配置端口漂移导致 token 发给邻居网关的认证错乱问题）→ gateway `config.patch` 写 `agents.entries.<agentId>.model`；切换语义精确定义：对象形态只替换 primary、fallbacks 原样保留（整值覆写会触发网关数组保护被拒）；
- 换 Key 的安全设计：完整 Key 由服务端 `key-registry.json` 保管（chmod 600），浏览器只传 Key 尾号且必须命中注册表白名单，明文全程不过前端；执行层走实例 CLI 的 `models auth paste-api-key`，HOME 语义按 CLI 要求显式设置；
- 前端乐观更新：切换成功回调本地先改徽章再拉取数据校准，规避缓存延迟造成的「成功了却显示旧值」。

### 4. 生成链路：日报自动生成（含直连模型工程）

- 批量预生成：crontab 按 10 实例错峰分批（3:30 起、每 15 分钟一批），并发 2 + worker 间隔 3 秒防账号限流，防重入锁，失败不缓存错误（支持稍后重跑）；
- 直连模型层（`lib/chat-complete.ts`）：模型引用 flash 优先、主配置 primary+fallbacks 兜底；实测修复四个坑——models.json 中未解析的 API Key 占位符按全大写正则跳过、推理模型 max_tokens 被思考吃光需给足配额、请求体只传 modelId 不带 provider 前缀、多引用回退逐个聚合错误避免掩盖根因；
- 成功日报自动落知识库目录树（`/data/knowledge/agent-daily-report/<实例>/<agent>/<日期>.md`），与平台经验蒸馏体系打通。

### 5. 质量与发布闭环（本项目的工程方法论）

- 修改闭环五步：`tsc --noEmit` 零错误 → build → `systemctl restart openclaw-bot-review`（Restart=always 托管，5 秒自拉起）→ 可用性验证（页面 200 + journalctl 无新错误）→ 数据正确性验证（跨全实例核对口径，接口 200 不等于数据正确）；
- 新 SQL 一律先在 /tmp 副本库验证再上线（曾因 typeof 语法错误被 try/catch 静默吞掉，统计「停在 9/7」排查 70 分钟后确立此规）；
- 排查方法论沉淀为技能（review-furnace-modify）：统计全 0 / 日期停滞 / 数据串实例三类症状的按序排查路径、环境变量指向错误实例的判定、缓存陈旧的多重陷阱（磁盘旧快照、restart 读入内存旧缓存、TTL 窗口），全部来自真实事故。

## 项目成果

1. 单看板聚合 10 实例 / 30 Agent 的全部运营数据，重查询接口秒级响应，运营排查从「逐实例登机器查库」变为「打开一个页面」；
2. 模型切换、API Key 更换、网关重启等治理操作全部可视化，Key 明文零暴露；
3. 套餐额度水位实时可视，超额风险提前预警；日报生成链路全自动化，错误可重跑、数据可回归验证。
