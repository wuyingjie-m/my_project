---
name: "model-balance-check"
description: "查询 GLM/智谱/DeepSeek 模型 API 余额或套餐额度、更换模型 API key（rotation）时使用；验证 key 有效性，给出控制台指引。"
---

# 模型 API 余额/额度查询

查询模型服务商（GLM/智谱 bigmodel、DeepSeek 等）余额、套餐额度、用量时按此流程执行：先判断端点类型，再验证 key，不要盲目探测余额端点。

## 步骤

1. 先确认**生效 key 来源**再谈测试：`openclaw models status`（带三环境变量隔离，见 instance-core-plugin-upgrade 步骤 3）的 `effective=` 字段给出每个 provider 实际取键处。2026-09-23 实测（core 2026.9.4）生效优先级：per-agent sqlite `auth_profile_store`（如 `zhipuglm:default`）> 环境变量（如 `DEEPSEEK_API_KEY`）；**models.json 内嵌 `apiKey` 不是生效来源**（抽样直连全 401，且可能是未解析占位符——见 review-furnace-modify 坑①），别拿它当测试 key。auth 库路径**以 models status 输出的 `Auth store :` 行为准**——同一 agent 目录下可能并存两份同名库：根级 `agents/<id>/openclaw-agent.sqlite`（旧布局，运行时不读）与 `agents/<id>/agent/openclaw-agent.sqlite`（迁移后布局），写/查错那份 = 改动静默无效（2026-09-23 QD 实测：新 key 写进根级库，运行层继续用旧 key 429）。解析还有一层：同 profile-id 下 per-agent 库**遮蔽**实例共享 store（`config_machine_state.authProfiles.store`，原 key 仍在其中）；TeamS 的 agent 无 per-agent 库、凭据在共享 store（9/30 全量盘点）。 **共享层正确查询**：state/openclaw.sqlite 的 `config_machine_state` 表，`SELECT value_json FROM config_machine_state WHERE state_key='authProfiles.store'`——该表列是 value_json/state_key（非 store_json/store_key），写错列名查询静默失败、共享 key 全部漏显（2026-10-13 用户脚本实测：per-agent 全显而共享层全空）。护栏仍拦 state 目录直查，副本流程见 multi-instance-cron-audit 步骤 2。key 只在脚本内引用，绝不打印、不写入回复或日志。
   - baseUrl/模型列表等元数据仍读配置文件：全局 `/data/agent/openclaw_sxs/.openclaw/openclaw.json` 或 per-agent models.json（布局不一：wyj 在 `agents/wyj/models.json`，main 在 `agents/main/agent/models.json`）
2. 按 baseUrl 判断计费类型：`https://open.bigmodel.cn/api/coding/paas/v4` = GLM Coding Plan 订阅套餐（每 5 小时限额 + 每周限额，无"现金余额"概念）；`/api/paas/v4` 才是按量计费端点。
3. 不要探测余额接口：智谱无公开余额/额度查询 API，`/api/paas/v4/users/me/balance`、`/api/biz/*`、`/api/paas/v4/finance/balance`、`/api/paas/v4/user/balance` 等全部 404；直接做第 4 步。
4. 用最小调用验证 key 与额度可用（key 取步骤 1 `effective=` 解析到的生效 key，不是 models.json 里的字段）：对 `<baseUrl>/chat/completions` POST 1-token 请求（`max_tokens: 1`、`stream: false`、`Authorization: Bearer <key>`），HTTP 200 = key 有效、额度可用；401 或余额类错误码 = key 失效或权限问题。
5. 输出结论：无 API 数字可拉时，指引登录控制台查看——智谱：open.bigmodel.cn 控制台 → 套餐概览 / 用量统计 / 费用账单；并说明 Coding Plan 额度耗尽不扣现金余额，等下一个 5 小时周期自动恢复。

## 更换 key（rotation；9/30 起首选官方 paste-api-key 路径）

0. **首选：官方 `models auth paste-api-key`**（9/30 need 实例全链路实测：一条命令写 auth profile + 更新 config + 网关热重载；自建 provider 如 zhipuglm 可用——旧结论“只认插件注册 provider”仅适用于 login/add）。要点：
   - `--agent <id> --provider <provider>`，key 走 stdin 传入；logout 是位置参数 `logout <provider>:manual --agent <id> --yes`（无 --provider 旗标）
   - 执行身份：优先实例专属用户（ocs_*，setpriv 降权，属主天然正确）或 root——root 跑完 CLI 会把 config 重写为 root:root 且 mode 变 644，必须立即 chown/chmod 回实例用户与原 mode，否则 ocs_* 网关 watcher EACCES、config 降级 polling（need 实测）；调用 env 必须干净（env -i 或 -u 掉残留 OPENCLAW_* 变量）
   - HOME 语义 = 实例根目录（openclaw_<X>），不是 homeDir（<root>/.openclaw）：config 解析在 $HOME/.openclaw/openclaw.json，HOME 传 homeDir 会报 Unknown agent id（2026-09-30 sxs UI 换 key 实测，dashboard /api/agent-key PATCH 已修为 HOME=dirname(homeDir) + 显式 OPENCLAW_CONFIG_PATH）
   - 副作用三条：①对无 per-agent profile 的 agent，paste 会新建 per-agent profile **遮蔽**共享 store（原 key 仍在，logout 后自动回退生效）；②logout 会连带删 config 的 `auth.profiles.<id>` 指针（含演练前已有的）且原子重写 config 使 mode 变 644——回滚时补回指针 + chmod 600；③paste 写 `<provider>:default` 但**不触碰已有 `<provider>:manual`**——agent 残留旧 manual profile 时会**反向遮蔽**新写入的 default（QD 2026-10-12 实测：paste IMwWQy 后 6/7 仍解析旧 lDl37u），修复=logout 删残留 manual，logout 失效则直写生效库 json_set
   - TeamS 的 agent 无 per-agent 库（凭据在共享 store），此路径对它不生效，需另行验证
   - **QD 2026-10-12 实测（残留 manual 反向遮蔽新 default）**：切 IMwWQy 时 paste 写 default 成功，但 6/7 子 agent 因残留 manual=lDl37u（早期切换遗留）优先级更高仍解析旧 key——修法 = logout 各子 agent 的 zhipuglm:manual；**logout 对子 agent 可能写不进生效库（QD 6 个失败、main 成功）**，fallback 直写生效库 `auth_profile_store` 的 manual 键值后重启实例网关，终验 7/7 生效
   - dashboard 已上线 /api-keys 页封装此命令（2026-09-30），日常换 key 走 UI 即可
   - 构造带 token/key 的命令一律先提取到变量（`T=$(…)`）再引用 `$T`，禁止手打或从对话复制脱敏占位符（如 `***`）当字面量——9/30 两次无效测试 + 一次误报「TeamS 运行记录不回写」（实为占位符 token 查询失败）皆由此起
   - **套餐限额打满的报错形态已实测确认（2026-09-30）**：HTTP 429，非 200 包业务码 → provider fallback 链（primary 打满自动切 fallbacks）可作为自动换 key 的可靠检测信号；多 key 共用关系与实时水位看板见 review-furnace-modify 的 key-pools/quota-usage 段
1. （fallback，CLI 不可用时）新 key 先按步骤 4 探针，HTTP 200 才落库（无效 key 不覆盖旧值）。
2. 写入位置 = **`Auth store :` 行指向的那份库**（见步骤 1 两份库陷阱）里的 `<provider>:default` profile。官方 `models auth login/add`（OAuth 类）只认插件注册的 provider，自建 provider（如 zhipuglm）报 `No provider plugins found`（paste-api-key 不受此限，见步骤 0）；agent exec 护栏禁写 live 库 → 由操作者在终端执行：
   `sqlite3 <Auth store 路径> "UPDATE auth_profile_store SET store_json = json_set(store_json, '\$.profiles.\"<provider>:default\".key', '<新key>') WHERE store_key='primary';"`
   （SQL 在 shell 双引号内，`$` 要写成 `\$`；多 profile 如 `:manual` 各自单独 update，不自动同步）。换的是**被限流过的 key** 时，同库 `auth_profile_state`（列名是 `state_key`，不是 auth_profile_store 的 store_key——写错列 UPDATE 静默不生效）里持久化的冷却与 lastGood 指针也要清——不清则运行层继续用旧 profile，重启也不消失（QD 实测冷却 16h）：
   `UPDATE auth_profile_state SET state_json = json_set(json_set(state_json, '\$.lastGood.\"<provider>\"', '<provider>:default'), '\$.usageStats', json('{}')) WHERE state_key='primary';`
   库里没有 primary 行时（部分 agent store 为空）改走 INSERT：`auth_profile_store` 有 `updated_at INTEGER NOT NULL` 列，INSERT 必须同时写 `(strftime('%s','now')*1000)`，缺列必报 NOT NULL constraint failed（2026-09-23 QD 实测）。
   交给操作者的修复脚本不要内嵌明文 key，读 key 文件也不要用命令替换包 head/cat 的写法——密钥脱敏层会把写入内容里的这类命令替换改写成 `***` 造成脚本语法错误（2026-09-23 实测，废掉一轮修复）；脚本里用 `read -r NEWKEY < key文件` 取值，变量引用不受脱敏影响。
3. 验证：`openclaw models status` Auth overview 的指纹前缀变为新 key（CLI 直读库，无需重启即可见）。
4. 运行层：网关把凭据在激活时急切解析成内存快照、运行期只读快照，不随 sqlite 改动热刷新——立即生效需重启该实例网关；或先实测一次模型调用、到厂商控制台核对新 key 用量判断是否已热加载。

## 参考

- 下结论"没有余额 API"之前，先查官方 API 目录 https://docs.bigmodel.cn/llms.txt 确认没有新增余额端点。
- Coding Plan 使用条件与端点要求：https://docs.bigmodel.cn/cn/coding-plan/faq.md
