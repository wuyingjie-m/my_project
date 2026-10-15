# skills/ — 技能资产库

> 每个技能 = 一个目录 + `SKILL.md`（YAML frontmatter：name + description + 正文步骤）。
> `ops/` 下的 16 个技能全部来自真实生产事故的复盘蒸馏——**每个排障步骤都对应一次踩坑**。
> OpenClaw 的技能加载机制见各技能 frontmatter；`description` 的前 60 字符决定模型是否选中它。

## ops/ — 排障 · 审计 · 运维技能（16 个）

| 技能 | 触发场景 | 核心价值 |
|---|---|---|
| `agent-broadcast-audit` | 核查多实例各 Agent 的过程播报执行情况 | 基于 transcript_events 统计播报合规率、定位零播报 Agent、对比历史执行率——对 LLM 行为做 evals 式量化 |
| `agent-workspace-repair` | 子 agent 报 workspace is missing / 配置路径串实例 | 先查配置指针而非恢复备份；修 entries 路径、doctor --fix 迁移、按 ops 方式重启并修 pid 文件 |
| `batch-agentsmd-rollout` | 给多实例子 agent 批量写入/更新 AGENTS.md 规则 | 静态插入与数据驱动变体（per-agent 取数交叉验证）、幂等跳过、20000 字符注入上限 |
| `channel-delivery-diagnosis` | 机器人收到消息不回复 / "failed to dispatch message" | 定位 core 与渠道插件版本不匹配，修复方法 |
| `instance-core-plugin-upgrade` | 升级实例 core/渠道插件（如飞书） | requires plugin API 报错、state 迁移失败、共享 core 升级影响面、重启生效与旧 generation 清理 |
| `instance-identity-isolation` | 实例切换专属系统用户运行、文件归属迁移 | Unsafe fallback temp dir、device identity 归属告警、定时任务随迁（root crontab → 实例用户） |
| `lark-broker-identity` | 以指定身份调用飞书、排查串身份 | LARK_BROKER_SUBJECT 路由、audit.jsonl 取证、下线幽灵身份（删了 entries 但定时任务还在跑） |
| `lark-cli-repair` | lark-cli 丢失或授权失效 | 重装 @larksuite/cli、修路由 shim/wrapper、device-flow 重新授权 |
| `lark-doc-wiki-write` | 向飞书 wiki 挂载的 docx 追加/改写内容 | wiki 节点解析、append、markdown 转义、@file 传参、回读验证流程 |
| `lark-sheet-data-ops` | 读写飞书表格数据 | +csv-get 全量读取、+cells-set 长文本写入、+dim-insert 插列、样式补刷与回读验证 |
| `model-balance-check` | 查询 GLM/DeepSeek 余额套餐、更换模型 API key | 生效 key 来源判定（auth_profile_store > env > models.json 内嵌≠生效）、paste-api-key 路径、QD 反向遮蔽坑 |
| `multi-instance-cron-audit` | 跨实例盘点定时任务、任意时间窗行为取证 | per-instance state sqlite 副本流程（cron_jobs + transcript_events） |
| `openclaw-automation-jobs` | 创建/排障 OpenClaw 定时自动化任务 | cron/every/at + agentTurn、建后强制试跑、"No callable tools remain" 排查 |
| `openclaw-gateway-plugin` | 开发/安装/排障网关插件 | api.on 钩子（before_tool_call 等）、plugins.entries 配置、EADDRINUSE |
| `review-furnace-modify` | 修改运营看板（openclaw-bot-dashboard） | build+systemctl restart 闭环、各数据接口数据流、缓存层规则、统计回归三步排查 |
| `task-status-inquiry` | 用户问"做完了吗/进度如何/怎么没播报" | 定位真实会话、核实活动与播报记录、催办并安排完成回报 |

## shared/ — 共享业务技能（4 个）

| 技能 | 用途 | 备注 |
|---|---|---|
| `personal-work-report` | 每日工作日报自动化：采集飞书日历/妙记/文档/全部私聊群聊 + AI 使用记录表格 → LLM 总结 → 写入日报表格 | 多用户 config-缩写.json 方案；定时链路走冻结命令 + lark-broker 身份声明；SKILL.md 服务交互补报路径 |
| `workday-morning-card` | 工作早报卡片：读取前一日详细日报 + 今日日程，生成清新可交互的早报页面 | 含字体/背景素材资产（~33M） |
| `html-ppt` | HTML 演示文稿制作（多风格模板、键盘导航） | 上游开源技能，本仓库存生产使用版 |
| `guizang-ppt-skill` | 横向翻页网页 PPT（电子杂志/瑞士国际主义风格） | 上游开源技能 |

## 技能开发规范（本集群约定）

1. **description 前 60 字符放触发词**——模型靠它决定是否读 SKILL.md，一个分支一个触发词，技能间触发词汇表刻意错开
2. **步骤必须以"完成判据"结尾**——每步写清如何验证完成，模型可自检
3. **坑与解法成对写**——只记录验证过有效的恢复路径，不写失败尝试
4. **吸收新事故**——技能被证明不完整时，把新坑补进对应步骤；制度性教训升级进 AGENTS.md（见 `governance/AGENTS.md.template`）
5. **生命周期**：Agent 自主提案（workshop）→ 夜间巡检评审 → 发布 → 全员推广
