---
name: "lark-cli-repair"
description: "lark-cli 丢失或授权失效(token_missing、wrapper 指向失效 nvm 路径)时：重装 @larksuite/cli，修路由 shim/wrapper，device-flow 重新授权"
---

# lark-cli 恢复与重新授权（多实例服务器）

lark-cli 是飞书官方包 `@larksuite/cli`。每实例的每个 agent 目录下有一个 bash wrapper（`<实例>/.openclaw/agents/<agent>/lark-cli`），负责把 HOME/XDG 指到该 agent 的独立 home（授权 token 所在地）再 exec 真实 CLI——这是多用户身份隔离的关键。本流程用于：迁移/重装后真实二进制丢失、wrapper 指向失效路径、或用户 token 失效（`token_missing` / refresh token revoked）导致采集/日报断线时的恢复。

## 症状确认

1. 查看 wrapper：`cat /data/agent/openclaw_<实例>/.openclaw/agents/<agent>/lark-cli`。若 `exec` 行指向 `/root/.nvm/versions/node/v24.18.0/bin/lark-cli-real` 而该路径不存在 → 真实二进制丢失（9/2 部署重组曾清掉整个 `/root/.nvm`，全服 wrapper 一起失效）。
2. `lark-cli --version` 报 not found / No such file → 全局命令与真实二进制都缺失。
3. 调用报 `authentication token_missing ... need_user_authorization` 或 `refresh token has been revoked` → token 失效，只需走“重新授权”一节，不用重装。
4. token 文件在、wrapper 直测正常（`bash <实例>/.openclaw/agents/<agent>/lark-cli calendar +agenda ... --json` 返回数据），但走全局命令报错 → 全局路由 shim 被还原成直连软链（`npm install -g @larksuite/cli` 重装会覆盖 bin 软链）。`ls -la /usr/bin/lark-cli` 指向 `../lib/node_modules/@larksuite/cli/scripts/run.js` 即中招（9/7 16:18 曾发生）。两种报错形态，同根因，都按路由问题修：① openclaw 环境变量存在时（OPENCLAW_STATE_DIR 等），lark-cli ≥1.0.93 直连二进制报 `type=config, subtype=not_configured, "openclaw context detected but lark-cli is not bound to it"`（退出码 3）；其 hint 指向 `lark-cli config bind`，**不要执行 config bind**——身份已绑定在 agent wrapper 的 home 里，绑到实例级是错误路径。② 干净 env 下同一直连二进制落到实例级 `.lark-cli`，报 `token_missing`。鉴别：`lark-cli auth status`（不是 whoami，1.0.93 无此子命令）显示 user/bot 均 ready、scope 齐全，而采集流水线 `raw.json` 所有来源 `returncode=3` 报 config/not_configured → 路由问题，不是授权问题。不改系统文件的兜底：跑采集/发布流水线前 `export PATH="<实例>/.openclaw/agents/<agent>:$PATH"`，让脚本调用的 `lark-cli` 命中本人 wrapper（`which lark-cli` 确认解析到 wrapper），恢复全局 shim 前都用它保住多用户身份隔离。
5. 重跑日报/采集流水线（如 `run_workday_report.py`）后 `raw.json` 里**所有来源**（calendar/docs/im/ai_usage）都是 `error`，且产出是“本地兜底草稿”（`部门姓名工作日报`、`person_name: 姓名`、正文“未设置大模型 API Key … 待模型提炼”）——这不一定是 lark 故障，多为运行配置错误，**不要**为此重装/重授权 lark-cli：
   - 漏传 per-user 专属配置：public `config.json` 是部门/姓名都未填的模板，`run_workday_report.py` 必须显式 `--config <skill>/config-<agent>.json`；不带会静默落到模板导致身份错+全部 error。
   - env 没真正导出：agent 的 `<agent>/env` 文件是 `NAME=value` 行（无 `export`），只 `source <agent>/env` 不会把 `DEEPSEEK_API_KEY` 带进后台子进程 → collect 过但 summarize 走本地兜底。要用 `set -a; source <agent>/env; set +a`（或先赋值再 `export`），并从 agent workspace 用绝对路径 + 干净 `--run-dir` 重跑，产物应出现真实部门/姓名与多条证据。

6. DEEPSEEK_API_KEY 迁移到新实例时（GTM 旧任务 env 里是明文，目标实例 secret store 无人值守会 no_answer）：从旧实例 `state/openclaw.sqlite` 的 `cron_jobs.job_json` 读出 key（只校验长度/指纹，不回显），写入目标 agent workspace 的 `.env.daily-report`（`chmod 600`），子代理里用 `set -a; source .env.daily-report; set +a` 加载。跨实例手动补跑日报的标准流程：spawn visible 子代理（runTimeoutSeconds 1500），任务文本里写死三件事——`cd` 到目标 agent workspace、`export OPENCLAW_AGENT_ID/AGENT_DIR`（必须在任何 cd 之前）、`source` key 文件，再按 SKILL.md 的绝对路径命令执行；早报卡片前置校验日报 `publish_result.json` 成功后才启动。

先确认 agent home 里的 token 还在再动手：`ls <实例>/.openclaw/agents/<agent>/home/.local/share/lark-cli/`（应有 `cli_<appid>_<open_id>.enc`、`master.key`、`appsecret_*.enc`）。token 在 → 只需修路由或重授权；token 不在 → 需完整首次授权。

## 恢复安装与路由（root，网关主机）

1. 安装官方包：`npm install -g @larksuite/cli`（约 2 分钟，postinstall 拉取 platform 二进制 `bin/lark-cli`，经 `scripts/run.js` 启动）。验证 `/usr/lib/node_modules/@larksuite/cli/scripts/run.js` 存在且 `lark-cli --version` 输出版本号。
2. `/usr/bin/lark-cli` 必须是**路由 shim**（npm 装的 bin 是指向 run.js 的软链，直接覆盖）。**写 shim 前必须先 `rm /usr/bin/lark-cli` 断开软链，再创建新文件**——直接 `cat >` 或 `>` 重定向会**穿透软链覆盖 npm 包的 `run.js` 启动器**（9/9 事故：run.js 被覆盖成 shim 后，所有经 run.js/lark-cli-real 的调用无限 `exec` 自身递归，全服 lark-cli 瘫痪，表现为所有命令无输出直至 timeout）。事故恢复：从官方 registry 重取原始文件 `cd /tmp && npm pack @larksuite/cli@<版本> && tar xzf larksuite-cli-*.tgz`，用 `package/scripts/run.js` 覆盖回去（保留损坏文件到 /tmp 供审计），再跑三条路径冒烟：直连 run.js、nvm lark-cli-real、全局 shim，各自 `--version` 输出版本号。shim 内容：`OPENCLAW_AGENT_DIR` 有值且 `${OPENCLAW_AGENT_DIR}/lark-cli` 可执行 → `exec` 它；否则 fallback `exec /usr/lib/node_modules/@larksuite/cli/scripts/run.js "$@"`。
3. 重写每个待修 agent 的 wrapper：`HOME`/`USERPROFILE` = 该 agent 的 `<实例>/.openclaw/agents/<agent>/home`（**不要**沿用旧实例路径），`XDG_CONFIG_HOME`/`XDG_CACHE_HOME` = home 下 `.config`/`.cache`（mkdir -p），最后 `exec /usr/bin/node /usr/lib/node_modules/@larksuite/cli/scripts/run.js "$@"`。chmod 保持 700。
4. 其他实例的旧 wrapper 仍 exec 旧 nvm 路径：用一条软链整体复活——`mkdir -p /root/.nvm/versions/node/v24.18.0/bin && ln -sf /usr/lib/node_modules/@larksuite/cli/scripts/run.js /root/.nvm/versions/node/v24.18.0/bin/lark-cli-real`（run.js 带 node shebang，可直接执行）。**仅适用于未迁移（root 属主）实例**——实例已切专属用户（ocs_*，见 instance-identity-isolation）后非 root 进程穿不进 700 的 /root，软链复活无效：按该 skill 步骤 4 直接把 wrapper exec 改为 `/usr/bin/node /usr/lib/node_modules/@larksuite/cli/scripts/run.js "$@"` 并删脚本 PATH 里的死路径组件（2026-09-28 GTM/PJT/QD 共 11 个 wrapper 即此修法）。
5. 任何 lark-cli 调用前先导出 agent 身份：在对应 workspace 内 `export OPENCLAW_AGENT_ID=<agent> OPENCLAW_AGENT_DIR=<实例>/.openclaw/agents/<agent>`，确保 shim 路由到本人身份，不串用他人授权。

## 变体：AGENTS.md 播报链路修复（CLI 本体健康）

AGENTS.md 里的播报命令（export 三变量 + wrapper 调 lark-cli）发不出去，但本 skill 前述问题都不成立（wrapper exec 目标有效、token 在位）——先分辨命令走哪条链：

1. **工具调用型**（采集/日报脚本）走 openclaw agent 的 provider 链，按前述各节修。
2. **AGENTS.md 直发型**（bot 回复用户群）走 wrapper HOME 的 auth-profile 绑定：绑定缺失或指向错应用时报 `not_configured` 或 `230002 Bot/User can NOT be out of the chat`（bot 不在目标群）。2026-10-04 data_group 实测：命令发 oc_10be8ba 全报 not_configured / 230002，根因是 per-agent home 无绑定 + 错绑主应用（主应用 bot 不在该群）。

修复：把该 agent 归属的飞书渠道应用凭据绑定到 wrapper HOME 的 lark-cli（数据源 = openclaw.json `channels.feishu.accounts.<账号>`）：

```
APPID=$(python3 -c "import json;print(json.load(open('/data/agent/openclaw_<实>/.openclaw/openclaw.json'))['channels']['feishu']['accounts']['<账号>']['appId'])")
SECRET=$(python3 -c "import json;print(json.load(open('/data/agent/openclaw_<实>/.openclaw/openclaw.json'))['channels']['feishu']['accounts']['<账号>']['appSecret'])")
printf '%s' "$SECRET" | env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=<agent home> \
  lark-cli config init --app-id "$APPID" --app-secret-stdin --force-init --brand feishu
```

- config init 在 openclaw 上下文里会被护栏拒绝（要求 --force-init，防创建平行应用遮蔽现有绑定）；config bind 只支持单账号形态，多账号渠道实例读不到 accounts 条目——用 init --force-init。
- init 写入 standalone 路径 `.lark-cli/config.json`，wrapped 运行时读 `.lark-cli/openclaw/config.json`——镜像过去并 chmod 600 再实测。
- 账号↔bot 对应：目标群的 bot 是谁就绑哪个账号（TeamS：baiban 账号 = 白板机器人，非主应用）。
完成：按 AGENTS.md 命令原样（export 三变量）发送成功落群，message_id 返回。

## token 失效重新授权（device flow）

1. 发起授权（`--domain all` 一次覆盖所有域，避免按命令逐条授权）：`lark-cli auth login --domain all --no-wait --json > <agent home>/.lark-cli/pending-device-auth.json`，随后 `chmod 600`。
2. 从该 JSON 解析 `verification_url`（形如 `https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=...&user_code=...`），把 URL **原样发给用户**并结束本回合等待确认。`device_code`/`user_code` 属授权码：只存文件、绝不输出到聊天或转录。
3. 用户确认后（下回合）：从保存的文件读取 `device_code`，执行 `lark-cli auth login --device-code <code> --json` 完成登录，不回显 code。默认 `expires_in` 600 秒，过期则重新发起。
4. 完成后重跑之前失败的命令验证。

## 验证

- `lark-cli --version` 正常；
- 带 agent env 跑一个只读调用（如 `lark-cli calendar +agenda --as user --start <今天> --end <今天+1h> --json`）：应返回日程数据或空列表，而不是 auth 错误；
- 端到端：重跑断掉的流水线（如 personal-work-report 的 `run_workday_report.py --config config-<agent>.json`，从 agent workspace 以绝对路径执行）。
- 修全局 shim 前后各做一次**隔离抽检**：身份隔离靠 wrapper 的 `HOME` 指向 + 各 agent `home/.lark-cli/openclaw/config.json` 里各自的 `appId`/`userOpenId`（如 wyj=cli_aaa3b9…吴英杰，GTM/cqy=cli_aad59…陈巧源），**不靠 shim 本身**——修 shim 不会串号。抽检方法：抽 2 个以上不同实例的 agent，各自跑 `bash <wrapper> auth status` 或读其 `openclaw/config.json`，确认 appId/userName 互不相同。另：全服 16 个 wrapper 的 `exec` 目标只有两种（`/usr/bin/lark-cli` 或旧 nvm `lark-cli-real` 软链），二者最终都解析到同一个 `run.js`，因此按第 2 步重写 shim 对两类 wrapper 都兼容，无需逐个改 wrapper。
