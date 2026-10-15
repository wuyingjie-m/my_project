---
name: instance-identity-isolation
description: 实例网关/CLI 切换专属系统用户运行、实例文件归属迁移时使用；排查 Unsafe fallback OpenClaw temp dir、device identity belongs to another user、插件 suspicious ownership 警告、agent 会话跑 ops 脚本报 nohup Permission denied 时使用；实例定时任务随迁（root crontab → 实例用户）也走本流程。
---

# 实例身份隔离（专属系统用户运行）

机制已固化在 ops 脚本（非本 skill 维护，本 skill 是使用与排障口径）：`/data/agent/ops/instance-users.conf`（`实例名=用户名` 映射，未映射实例默认 root 启动），`start-all.sh`（网关）与 `agent-tui.sh`（TUI/CLI）检测到映射即 `setpriv` 降权，并对 openclaw 二进制路径做了实例私有 shim 防呆。用户名惯例 `ocs_<实例小写>`（如 openclaw_need → ocs_need）。已落地：need / GYL / XMT（2026-09-22，三实例同流程、零脚本改动）、GTM / PJT / QD（2026-09-28 迁移含 crontab 随迁与死路径清理，9/30 复核网关已以 ocs_gtm/ocs_pjt/ocs_qd 运行）、PPJD / PPXS（运行态证实 ocs_ppjd/ocs_ppxs，2026-10-15 pid 复核；迁移日期无记录）；余 sxs / TeamS 待切。

## 迁移一个实例（每实例一遍）

1. 建用户：`useradd --system --no-create-home --shell /usr/sbin/nologin <user>`。完成：`id <user>` 出 uid/gid。
2. 单停该实例：`kill $(cat /data/agent/ops/pids/openclaw_<X>.pid)`，等退出；SIGTERM 可能 12s 不退（网关优雅关闭慢），`kill -9` 兜底。**禁用 stop-all.sh——那是全停**。完成：`kill -0` 失败。
3. 归属迁移：`chown -R <user>:<user> /data/agent/openclaw_<X>`，**随即归还 root 专属缓存**：`chown -R root:root /data/agent/openclaw_<X>/.cache/openclaw-0`（`.cache/openclaw-<uid>` 按 uid 命名、属 root CLI，chown -R 必然误掠；网关用的是 `.cache/openclaw`，不冲突；目录不存在则跳过，如 GYL）；`/data/agent/ops/logs/openclaw_<X>.log` 一并 chown。完成：`find <实例目录> ! -user <user>` 仅剩 `.cache/openclaw-0`。**重启若由操作者代执行：kill 之后、start 之前必须重跑本步 chown 扫尾**——旧 root 网关运行期会持续新产生 root 文件（GYL/XMT 轮实测 fqc 的 lark-cli 缓存文件）；可生成 kill→扫尾→start 一体脚本交操作者一条命令执行（如 2026-09-28 的 `/data/agent/ops/restart-ocs3.sh`）。
   - ⚠️ **per-user 实例的授权/登录类操作必须在实例用户身份下执行**（setpriv 降权或让 agent 自己跑）：root 代跑会把产物写成 root:root 600，实例网关（ocs_*）读不了自己的凭据——2026-10-12 GTM 数仓 MCP tokens.json 实测：网关 ocs_gtm 读自己实例令牌报 EACCES、MCP -32603 工具列表空；chown 归还+全树归正（4566 个 root 残留清零）后，以 ocs_gtm 身份握手 initialize/tools-list 全通。修复后全盘 `find <实例> -user root` 清零复查。
4. 任务随迁与 /root 死路径清理（GYL 订会议室教训；2026-09-28 GTM/PJT/QD 实测 root crontab 有 20 条活跃任务直写实例文件）：先逐用户扫 crontab 找引用 `<实例目录>/` 的活跃行；chown 完成后把活跃行连注释搬进新用户 crontab（nologin 用户跑 cron 没问题，GYL 先例），root 原行留迁移标记注释，搬前 `crontab -l` 整表备份；只 curl 本地服务、写 /var/log 的行（如 furnace generate-all）留 root。同时 grep 实例内脚本 `/root/` 硬编码：`.nvm` 类死路径在切换后必死（ocs 用户穿不进 700 的 /root，lark-cli-repair 的 nvm 软链复活法对已迁实例不适用）——wrapper exec 改 `/usr/bin/node /usr/lib/node_modules/@larksuite/cli/scripts/run.js "$@"`、PATH 里死路径组件带冒号整段删（修法细节见 lark-cli-repair）。完成：root crontab 无该实例路径活跃行；脚本层 grep `/root/.nvm` 仅剩 memory/会话产物类文件。
5. 映射表加行：`echo "openclaw_<X>=<user>" >> /data/agent/ops/instance-users.conf`。
6. 重启：`OPENCLAW_BIN=/usr/local/bin/openclaw bash /data/agent/ops/start-all.sh`（在跑实例自动跳过），输出应含 `run-as=<user>`。完成：该实例端口 LISTEN。
7. 验证四件：`ps -o user -p $(cat pid文件)` = 新用户；实例日志 `[ws] ws client ready`（飞书连通）；`agent <别名>` 能进 TUI 且 `gateway connected`（ctrl-c 退出，不再报任何归属错误）；真实发一条消息，日志见 `dispatch complete` 且有回复。完成：四件全过。

## 报错签名速查

| 报错 | 根因 | 修法 |
| --- | --- | --- |
| `Unsafe fallback OpenClaw temp dir: .../.cache/openclaw-0` | root CLI 的 uid 缓存目录被 chown -R 掠走 | 步骤 3 的归还命令 |
| `device identity coordinator directory belongs to another user`，或 root CLI 大量插件 `suspicious ownership (uid=999, expected uid=0 or root)` 警告 | TUI/CLI 以 root 跑，实例文件归实例用户 | 走 agent-tui.sh 的降权路径（已内置，升级后自动生效）；勿手工 chown identity/插件目录凑合 |
| start-all FAIL，日志 `nohup: failed to run command '<实例>/.openclaw/tmp/agent-cli/openclaw': Permission denied` | 从 agent 会话跑 ops 脚本，PATH 把 openclaw 解析到实例私有 shim（`OPENCLAW_PREPEND_PATH`），setpriv 降权后无权穿越其他实例的 state 目录 | `OPENCLAW_BIN=/usr/local/bin/openclaw` 显式指定（两脚本已内置同款防呆，显式传最稳） |

## 决策规则

- **身份分离后所有入口必须同身份**：网关（start-all.sh）、TUI/CLI（agent-tui.sh）都以实例用户跑；root 专属缓存目录保持 root。三层归属检查（temp dir / device identity / plugins ownership）任一不匹配即拒绝启动或降级告警。
- 单实例重启标准序列 = 步骤 2 → 3（仅迁移期扫尾）→ 6；初次迁移按 1→7 全序。切换完成后运行期新文件自动归新用户，日常重启不再需要 chown。
- 迁移 sxs（wyj 自身所在实例）会重启自己的网关、断掉当前 exec 会话——由操作者执行，或从 `setsid nohup` detached 脚本跑（自杀风险同 channel-delivery-diagnosis 3d）。
- 非映射实例的重启还原法、config watcher 改配置即离线风险、state 迁移坑不在本 skill 范围：见 openclaw-gateway-plugin 与 instance-core-plugin-upgrade。
- **未拆雷清单**：XMT 已迁（ocs_xmt）但 root crontab 仍留 4 条 ahs-datamarket 活跃行（send_daily/send_group/keepalive/sentinel，含每分钟哨兵；2026-10-15 复核仍在）直写 XMT 实例文件——已迁实例被 root 定时写文件正是步骤 4 要防的场景；下次触碰 XMT 或做迁移扫尾时优先按步骤 4 搬迁。
- **MCP 代理进程（mcp-proxy）孤儿判定**：mcp-proxy 是 STDIO 子进程，按需拉起、闲置退出，**出现在进程列表不等于泄漏**——判定标准=①父进程非网关 supervisor（合法父=OpenClaw process/supervisor）②stdin 指向文件而非管道。2026-10-12 实测：GTM 三孤儿挂 4.5 天（stdin 接 mcp.in/q.in/r.in 文件，网关死后被 systemd 收养），全部 kill 后网关自动重新拉起合法 proxy。根因=手动授权脚本把 proxy 的 stdio 重定向到文件（mcp.in/proxy3.log），网关死后无 EOF 永不退出。
- **迁移后输入路径可读性**：实例用户跑的定时任务/技能，其依赖的输入目录必须有遍历位（仅 rw 不够）——2026-10-08 实测 /data/knowledge 为 drw-rw-rw-（root 属主缺 x），ocs_gtm/gyl/pjt/qd 均进不了日报目录，四实例蒸馏首跑全部静默零产物；修复 `chmod -R a+rX /data/knowledge`。新任务铺到非 root 实例前，先 setpriv 以实例用户试读全部输入路径（含目录遍历），勿只验证脚本本身。
