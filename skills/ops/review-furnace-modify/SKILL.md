---
name: "review-furnace-modify"
description: "修改 openclaw-bot-dashboard（= /data/opt/OpenClaw-bot-review-furnace 看板，页面/API/文案/统计）时使用：systemd 服务 openclaw-bot-review 托管，改代码必须 build+systemctl restart 才生效；含各数据接口数据流（含 agent-daily 直连模型生成坑）、套餐额度水位（quota-usage）与 API Key 管理（agent-key）的数据流与坑、缓存层规则、统计回归三步排查。统计全 0/日期停滞/数据像别的实例/额度百分比与控制台不一致时也走本技能。"
---

# Review Furnace 看板修改

/data/opt/OpenClaw-bot-review-furnace 是 OpenClaw 机器人运维看板（Next.js 16 + TypeScript + Tailwind 4）。用户口中的 openclaw-bot-dashboard 即本仓库（无独立目录）。**由 systemd 服务 `openclaw-bot-review.service` 托管**（enabled、Restart=always、RestartSec=5）：杀掉进程 5 秒内自动拉起，手动 nohup 起进程会与它抢 3000 端口（EADDRINUSE 实测）——重启一律 `systemctl restart openclaw-bot-review`。改源码必须先 build 再重启才生效（next start 只读 .next 构建产物）；构建期间线上短暂 500 可接受（内部看板）。

## 数据流地图（先定位再改，不要重读整条链路）

- 总览页 `app/page.tsx`：agent 卡片墙（数据在 instances[].agents，顶层 agents 只含主实例配置项）。任务追踪已迁今日播报页、趋势图已迁全局概况独立页，本页不再消费 agent-activity。
- 今日播报 `app/daily/page.tsx`：消费同一 API，客户端互斥分类三档（09-23 改版）——已完成 = !isRunning 且 lastStatus=success 且 lastRunAt 是今天；暂失败 = 同口径 lastStatus=failed（统计卡标签 daily.tempFailed，常驻显示）；待开始 = 其余（含 isRunning 的）。页面 30s 自刷，停用任务（enabled=false）不计入。页面底部有「Agent 任务追踪」模块（2026-09-22 自总览页迁入）：按 agent 分组的状态/子任务/长期定时任务明细。
- `/api/agent-activity`（app/api/agent-activity/route.ts）：includeInstances=1 时扫描 /data/agent/ 下全部 OpenClaw 实例；cronJobs 读各实例 state/openclaw.sqlite 的 cron_jobs 表（服务端 60s 缓存），字段 isRunning / lastStatus(success|running|failed) / lastRunAt / nextRunAt / consecutiveFailures / lastSummary / enabled。一次性任务（schedule.kind==="at"）在 parseCronJobs 开头即跳过、不做统计（2026-09-22 需求；实证 TeamS 53总/31一次性→API 22、GTM 16/1→15）。
- 网关配置写入（机器人板块切换模型，`/api/config/agent-model` PATCH → gateway `config.patch`）：per-agent 配置在 `agents.entries.<agentId>`（全部实例统一此结构——实例数随业务增长，勿写死数字；`agents` 另有 defaults/ownership 键）；**`agents.list` 不是合法键**——config.patch 写它必被校验拒绝（invalid config: Unrecognized key "list"，2026-09-23 实测已改 entries 形态并 switch→revert 往返验证）。per-agent `model` 字符串与 `{primary,fallbacks}` 对象两形态都合法；切换语义（09-23 定稿）：对象形态只替换 `primary`、**fallbacks 原样保留**（整值覆写会触发数组保护拒绝 config.patch would remove entries from array path(s)），纯字符串形态整值替换。

- 独立页 `/global-overview`「全局概况」（app/global-overview/page.tsx，侧边栏 nav.overview 组独立按钮；用户已明确后续全局级新功能都加在此页）：消费 `/api/global-overview`（app/api/global-overview/route.ts）——当前周（UTC 周一起始，与 stats-all 周桶同口径）每 agent token 合计排行 + 全局总消耗，页内 30s 轮询；趋势统计消费 `/api/stats-all`（60s 轮询），TrendChart/ResponseTrendChart 已从 page.tsx 整体迁入此页（page.tsx 不再依赖 stats-all）。`/api/global-overview` 复用 getSqliteDailyStats（sqlite 缺席时自带 JSONL 兜底），SWR 30s 缓存 + 落盘。**stats-all 本身返回的是全 agent 聚合结构 {daily, weekly, monthly}，不含 per-agent 明细**——要 per-agent 日粒度直接走 getSqliteDailyStats。新增独立页套路：`app/<name>/page.tsx` + `sidebar.tsx` NAV_ITEMS 对应组加项（icon 复用现有像素图标）+ i18n 四语言 `nav.<name>` 键。9/30 增补：本页实例筛选器为**纯前端过滤**（/api/global-overview 本就带 instanceId；勿按查询参数做后端筛选，SWR 缓存会按参数分片）；新落点 `/api/agent-key` + `/api-keys` 页（实例级换 key，封装 models auth paste-api-key，见 model-balance-check 步骤 0；读取与聚合在 lib/key-pools.ts——per-agent auth_profile_store 遮蔽共享态 authProfiles.store，PATCH env 必须 HOME=实例根目录+显式 OPENCLAW_CONFIG_PATH；换 key 为**点选式**——完整 key 由服务端 `key-registry.json` 保管（600），PATCH 只传 keyTail 且必须命中注册表（合法清单外 400），明文不经浏览器；新增可用 key = 编辑注册表 + rebuild）、`/api/quota-usage` + 水位面板（口径在仓库根 quota-config.json：10-08 实测反推定稿——周 13.5 亿/5h 2.85 亿/周二 20:06 重置（resetDow=2）/排除 sxs、need、XMT/按 planLabels 聚合套餐、fiveHourAnchor=5h 重置锚点（非滚动窗口；锚点漂移按控制台读数更新，如 10-08 实测 09:46））。**openclaw-instances 的 homeDir = <root>/.openclaw 本身**（agentsDir = homeDir + "/agents"），拼路径勿再加 .openclaw——双层路径全部读空、静默无报错（9/30 key 池=0 实测）；**TeamS 在 discovery 里 id="default"**（非 openclaw_TeamS），按实例做映射/筛选时必须补 default 键。排行榜已带实例筛选 pill（2026-09-30）：/api/global-overview 本就返回每 agent 的 instanceId/instanceName，筛选纯前端实现（instanceFilter state → 派生 filteredAgents/filteredTotals，总耗卡与奖牌联动，单实例视图隐藏实例名标签）——同页加同类筛选优先复用接口既有维度字段做前端筛选，后端零改动即避开 SWR 按查询参数分片。
- 实例对象路径语义（9/30 实测踩坑，首验池数=0 的根因）：`OpenClawInstance.homeDir` = `<root>/.openclaw` 本身——`agentsDir = homeDir + "/agents"`、共享 state 库 = `homeDir + "/state/openclaw.sqlite"`，自己再拼 `.openclaw` 一层即双层路径静默读空；要实例根目录用 `path.dirname(homeDir)`，`configPath` 可直接作 CLI 的 `OPENCLAW_CONFIG_PATH`，主实例 discovery id 固定为 `default`（按实例聚合的映射必须含它）。9/30 新增组件：`lib/key-pools.ts`（读 per-agent `auth_profile_store` + 共享态 `config_machine_state.authProfiles.store`，同 id 时 per-agent 遮蔽共享）＋ `/api/agent-key`（GET 指纹池分组；PATCH 批量换 key，走 `models auth paste-api-key`，执行身份/副作用规则见 model-balance-check 步骤 0）＋ `/api/quota-usage`（额度水位：按 planLabel 聚合——GTM 与 TeamS 属同一套餐合并为一池，TeamS 的 discovery id 是 default、映射必须补；限额/重置/排除口径统一在仓库根 `quota-config.json`（10-08 实测定稿：周 13.5 亿/5h 2.85 亿/周二 20:06 重置/排除 sxs、need、XMT）；**5h 额度按固定锚点每 5 小时重置（fiveHourAnchor），不是 now-5h 滚动窗口**——9/30 用户纠正；窗口用量直查 transcript_events、周窗口复用 getSqliteDailyStats，60s SWR）＋ `/api-keys` 页。CLI 验证时 `--token` 一律用变量引用（`T=$(python3 -c …)` 后 `--token "$T"`）：脱敏报告/文档里的 `***` 是占位符不是值，两发无效查询实测。
- `/api/daily`（lib/daily.ts）是遗留接口：读记忆 md 的 checkbox 待办，与定时任务无关，已无页面消费——不要把它当任务数据源。
- `/api/agent-daily`（app/api/agent-daily/route.ts + lib/agent-daily-source.ts）：按 agent+日期聚合会话生成昨日日报。会话事实读**双路径**：sessions/*.jsonl + per-agent `agents/<id>/agent/openclaw-agent.sqlite` 的 transcript_events（多数实例已迁 sqlite、jsonl 只剩归档；schema/SQL 细节见 multi-instance-cron-audit 步骤 7，勿在两处重复维护）；实例 id 口径：default=OPENCLAW_HOME 实例（现 TeamS），其余=/data/agent 目录名。缓存按 agent+date 落 .api-cache：历史日期永久、今天 10min、refresh=1 绕过；失败不缓存错误（响应带 fallbackTasks 原始任务供前端兜底）。批量预生成走 `/api/agent-daily/generate-all`（并发 2、worker 内 3s 间隔——zhipuglm 账号批量易限流；强制 refresh、防重入；支持 `?instanceId=` 单实例过滤，未知实例 400）；crontab 已按实例错峰分批：3:30 default(TeamS) 起、每 15 分钟一批依次 GTM→GYL→need→PJT→QD→sxs→XMT（2026-09-21 曾夏杨要求拆批避限流，改 crontab 时保留这 8 条、勿合并回单批）；成功日报同时落知识库文件 `/data/knowledge/agent-daily-report/<实例段>/<agentId>/<日期>.md`，实例段映射：default 取 OPENCLAW_HOME 主目录名（=openclaw_TeamS），其余=实例目录名。stats 口径：「定时任务」=cron_jobs 注册表按 owner 计数（stats.cronJobs，与总览任务追踪一致，2026-09-21 用户纠正过），「昨日实际执行」=stats.cronRuns，两者勿混。
- 直连模型生成文本用 `lib/chat-complete.ts`（勿重复造轮子）：模型 ref 顺序 = flash 优先（zhipuglm/GLM-5.3-flash，AGENT_DAILY_MODEL env 可覆盖）→ 主实例 openclaw.json `agents.defaults.model` 的 primary+fallbacks 兜底。四个坑（2026-09-21 实测）：① models.json 的 apiKey 可能是未解析占位符（字面量 `DEEPSEEK_API_KEY`，核心运行时才做 env 替换，直连 401）——按 ALL_CAPS 正则跳过；② GLM-5.3 系是推理模型，max_tokens 被推理 tokens 吃光即 finish_reason=length 空 content——给足（现 8000）；③ 请求体 model 只传 modelId 不带 provider 前缀（带前缀报 1211 模型不存在）；④ 多 ref 回退必须逐 ref 聚合错误，只留最后一个会掩盖根因；⑤ 账号限流（“您的账户已达到速率限制”）批量生成必遇——chatComplete 已自动等 25s 重试一次，仍失败的稍后重跑即可（错误不缓存）。
- 响应缓存两层（改接口前先看）：config / stats-all / agent-status / agent-activity 四个重路由 = 内存 SWR 缓存 + 过期后台单飞刷新 + 落盘 `.api-cache/*.json` 重启即恢复；统计源 lib/sqlite-stats.ts 用 Node 内置 node:sqlite（DatabaseSync 只读 + busy_timeout + 120 天窗口）另有每 agent 5min 缓存。**SWR 被包装函数必须返回纯数据对象，不能返回 NextResponse**——Response 被序列化成空壳存进缓存（agent-activity 曾因此空两天）。新增重路由照此模式，勿在请求路径加无缓存的全量重算（曾同步阻塞事件循环、整个服务睡死）。
- 文案在 `lib/i18n.tsx`：zh-TW/zh/en/vi 四语言，t() 回退 locale→vi→zh→key；新增 key 至少补 zh-TW/zh/en 三块。

## 套餐额度水位与 API Key 管理（key-pools / quota-usage / agent-key，2026-09-30 上线）

新增组件：`lib/key-pools.ts`（读每 agent 的 `auth_profile_store` + 实例共享 `config_machine_state.authProfiles.store`，**per-agent profile 遮蔽共享 store**）、`/api/quota-usage`（5h+周额度水位，60s SWR）、`/api/agent-key`（GET 列表与池分组 / PATCH 换 key）、`/api-keys` 页（点选式换 key）、`quota-config.json`（上限/5h 锚点/排除实例/套餐标签/`perKeySplit` 拆池实例清单，改后需 build）、`key-registry.json`（可用 key 注册表，chmod 600，完整 key 服务端保管不经浏览器，PATCH 只收 keyTail）。10/13 增补 `perKeySplit: ["openclaw_QD"]`——QD 双 key 拆池，聚合时 label 追加 `·keyTail` 后缀（如 `QD·lDl37u`），其余实例不变。

实测坑与口径（违反即数据错误）：

- **OpenClawInstance.homeDir 语义 = <实例根>/.openclaw**（agentsDir = homeDir + "/agents"）：在其下再拼 ".openclaw" 得双层不存在路径，读取静默失败（2026-10-08 首验池数=0 的根因）。
- **CLI 的 HOME 语义相反 = 实例根目录本身**（config 解析在 $HOME/.openclaw/）：传 homeDir 报 Unknown agent id；正确形态 HOME=dirname(homeDir) + 显式 OPENCLAW_CONFIG_PATH（sxs UI 换 key 实测）。
- **5h 额度是固定锚点重置**（每 5 小时一窗自动平铺，非 now-5h 滚动窗口）：`fiveHourAnchor` 写最近一次实测重置时刻即可长期有效；锚点漂移（用户报下次重置时间对不上）只改这一个字段。
- **改窗口口径/额度参数后必须删 `.api-cache/quota-usage.json`**：旧构建算过的旧窗口会落盘，重启后首请求命中旧缓存返回错误口径（9/29 KeyError 与 10/08 周窗口 62.2% 两次踩）。
- **QD 双 key 拆池（perKeySplit，10/13 上线）**：quota-config.json 加 `perKeySplit: ["openclaw_QD"]` 后，该实例按 keyTail 拆池（label=`QD·key尾号`）——QD 两把 key（IMwWQy+lDl37u）分属不同套餐池需分别统计；其余实例不受影响；GTM 若也上双 key 同款加入即可。坑：**restart 后首个请求可能命中 restart 时已读入内存的旧缓存**（TTL 60s 内），先等 TTL 过期或再刷一次再判定“未生效”（10/13 实测 2 次“未生效”均为内存旧数据，第 3 次刷出后才生效）——**验证铁律：restart 后先删 `.api-cache/quota-usage.json` 再等 60s TTL 过期取数**；restart 时模块已把旧磁盘缓存读入内存，删缓存必须在 restart 前（10/13 QD 分池实测：restart 后才删，首请求仍返回旧口径）
- **周重置日以用户实测为准**（9/30 的“下次重置 10-06 20:06”→ 周锚在周二 resetDow=2，非周日）；TeamS 在实例发现里 id 是 **default**——套餐合池 planLabels 必须含 default 键，否则 TeamS 落不进合池。
- 换 key 副作用与回滚、auth 库双份陷阱见 model-balance-check 步骤 0（本节不重复）。

## 网关配置写入坑（config.patch，模型切换等）

- per-agent 模型必须写 `agents.entries.<agentId>.model`（8 实例统一此结构，字符串与 {primary,fallbacks} 对象均合法）；`agents.list` 不是合法键——网关 config 校验直接报 `Unrecognized key: "list"`（app/api/config/agent-model/route.ts 已修，已知模型收集也要读 entries）
- gatewayPort 必须用 `/data/agent/ops/instance-ports.conf` 解析（start-all.sh 实际按它拉起网关）；config 里的 `gateway.port` 会漂移——sxs config=18796、实际监听 18797，而 18796 是 XMT 的网关：按 config 端口连会把本实例令牌发给邻居网关 → `unauthorized: gateway token mismatch`（lib/openclaw-instances.ts 已用 readOpsPorts 修复，ops 表优先、config 兑底）
- PATCH 改的是 config 重路由消费的数据时，必须**同时清内存+磁盘两层缓存**（`clearConfigCache()` + `clearDiskCache("config")`）——只清内存，下一个 GET 会从 `.api-cache/config.json` 回填旧快照：前端切换成功却看到旧模型，等 ~10s + 手动刷新才更新（2026-09-23 实测）；配套前端在成功回调里本地乐观更新该 agent 的 model 再 fetchData(true) 校准（page.tsx changeAgentModel 的 setData），徽章即时回显
- 完成判据：PATCH 返回 ok:true 且实例 config 的 entries.<id>.model 已变为目标值

## 修改闭环

1. 改代码后 `npx tsc --noEmit`，0 错误才继续（vitest 不覆盖 app 页面，无需跑）。退出码直接取（`npx tsc --noEmit; echo $?`），勿放管道——接 `head` 会拿 head 的退出码冒充通过（2026-09-22 实测 5 个报错时仍显示 0）。完成：退出码 0。**打补丁前锚点按真实字节构造**：page.tsx 是混合行尾（大部分 CRLF、卡片墙区域 LF），python `newline=''` 读原文、repr 确认锚点后再替换，勿按单一 EOL 整文件推断（实测整文件探测会锚点失配空写）；i18n.tsx 全 CRLF。
2. `npm run build`（1-2 分钟，可能被 exec 后台化，用 process poll 跟踪）。完成：退出码 0。
3. **新 SQL/正则先在副本上验证再上线**：`cp <db> /tmp/x.sqlite && sqlite3 /tmp/x.sqlite "<sql>"`（exec 工具禁止直接 sqlite3 打开 OPENCLAW_STATE_DIR 下的库）。注意 sqlite 的 typeof 必须带括号——`typeof(created_at)`；裸写 `typeof created_at` 是语法错误且被 try/catch 静默吞掉回退旧数据（统计"停在 9/7"实测根因）。
4. `systemctl restart openclaw-bot-review`（不要 pkill -f：模式会匹配自己 shell 命令行导致自杀，实测发生；拒绝退出的进程 systemd 在 TimeoutStopSec 后自动 SIGKILL）。
5. 验证分两层：可用性——页面 curl=200，`journalctl -u openclaw-bot-review --since "<重启时刻>"` grep -iE "error|failed" 无新错误；**数据正确性**——按页面口径核对且必须跨全实例（实例发现扫 /data/agent 全目录，覆盖数随实例增长验证即可、统计末日=今天），接口正常秒回≠数据正确（服务环境变量指错实例时返回的是别实例数据，照样 200）。前端为客户端渲染且默认 locale=vi：SSR HTML 里 grep 不到新板块中文文案/emoji 属正常——前端验证 grep `.next/static/chunks` 产物，数据验证直接打接口。**改口径/参数类变更（quota-config.json 限额/锚点、接口窗口算法）restart 后首个请求会命中 `.api-cache/<接口>.json` 里的旧口径快照——数据验证前先删该缓存再读**（9/29 KeyError 与 10/8 周窗口陈旧两次实测；9/30 榜单/10/8 锚点同理）。完成：新口径字段与数值在响应中逐项核对过。

## 统计回归排查（统计全 0 / 日期停滞 / 数据像别的实例）

按序查三点（曾同时叠加，排查耗时 70 分钟）：① `systemctl cat openclaw-bot-review` 确认 OPENCLAW_HOME/OPENCLAW_CONFIG_PATH 指向主实例 `/data/agent/openclaw_TeamS/.openclaw`（主实例=TeamS 是 2026-09-20 用户拍板的归属——小龙虾工作台视角；曾误改 openclaw_sxs 又改回，勿再反向"修正"，症状先查②③）——改前备份 .bak-日期，改后 daemon-reload + restart；② journalctl 找 sqlite syntax error（新 SQL 回到第 3 步副本验证）；③ 查 SWR 包装层被包装函数的返回类型。修完删 `.api-cache/*.json`（坏数据落盘会重启复活）再 restart。

个别 agent 显示"离线"但用户确认实际能用 → 判定链只看网关端口探测：agent-status 的 `gatewayOk:false` = 对配置 `gateway.port` 的 TCP 探测失败，而 agent 实际可用性走飞书出站长连接（不依赖入站端口）——配置端口与网关实际监听脱节（历史漂移）时就会出现（2026-09-21 fqc 案例：配置 18798/实际 18796，对齐后恢复 idle 正常显示）。修复方向是**对齐配置到网关实际监听端口**（`ss -tlnp | grep :<port>` 端口反查 pid → readlink cwd 确认归属，勿按配置端口重启网关与实际监听者拉锯）。QD/TeamS 的 instances 分组缺失（依赖库 lookbehind 正则栈溢出）同属显示层问题，agent 数据不受影响。

## Gateway config 写入 Schema（2026.9.4 严格校验）

看板通过 `config.patch` 写实例配置时按当前 Schema 严格校验：per-agent 配置写 `agents.entries.<agentId>.model` 等，**`agents.list` 是非法键**，补丁里带上即整单被拒（invalid config: Unrecognized key "list"，2026-09-23 机器人板块切换模型实测）；读侧由 `agents.entries` 或 ~/.openclaw/agents 自动发现兼容，写侧必须用 entries。
