---
name: "channel-delivery-diagnosis"
description: "Diagnose bot received-but-no-reply and \"failed to dispatch message\" errors; fix core vs channel-plugin version mismatch."
---

# Channel Delivery Failure Diagnosis

Diagnose OpenClaw chat-channel delivery failures: a bot received the user's message but never replied, or the gateway log shows `failed to dispatch message` (for example `runChannelInboundEvent prepared turns must declare runDispatchLifecycle when creating runDispatch`). Locate the real gateway log, identify the failing stage, and check core-versus-channel-plugin version alignment — the usual root cause of these contract errors.

## Steps

1. Find the right gateway log. The detailed per-day runtime log is `/tmp/openclaw/openclaw-<YYYY-MM-DD>.log` (line timestamps carry the `+08:00` offset). The file under `/data/agent/ops/logs/openclaw_<HOST>.log` is only the stdout mirror (startup/lifecycle lines) and is truncated by restarts — never conclude "no activity" from it alone.
   Completion: you hold a log containing `received message`/`model-fetch` lines around the user's reported time.

2. Reconstruct the delivery stages around the reported time, grepping the channel account (for example `feishu[wyj-bot]`) and the chat id if known:
   - `received message from <user> in <chat>` → the adapter received the message
   - `dispatching to agent (session=...)` → routing to the agent started
   - `failed to dispatch message: Error: ...` right after → routing failed; the message never reached the agent, so no reply was sent
   Completion: you can name the failing stage and quote the exact error.

3. If the error is an internal assertion (like the `runDispatchLifecycle` one), find where core enforces it: `grep -rn "<unique error phrase>" /opt/openclaw/lib/node_modules/openclaw/dist/*.js`, then read about 40 lines around the `throw` to learn the contract (for example: a turn that carries `runDispatch` must also declare `runDispatchLifecycle`, and older adapters build turns that omit it).
   Completion: you know which side (core or the channel adapter) supplies the missing field.

3b. If the failing error is `restart recovery claim changed before agent adoption`, or you see `Channel ingress claim→adoption stalled ... after 300000ms; applying retry policy (handler-timeout)` plus `spooled update ... failed; keeping for retry`, the root cause is stale spooled claims — a `sessions.reset` (or other session-entry change) landed while that chat's events were spooled, so every retry mismatches the persisted session entry; `per-chat task exceeded 300000ms cap (key=...)` lines mark the stuck chat lane. Confirm by grepping the log for `sessions.reset` before the first failure. A restart does NOT repair this branch: after a fresh start the same spooled events stall again — treat failures continuing after a recent gateway start as proof. Repair path (the log itself hints "stop the Gateway and run openclaw doctor --fix"): stop the gateway, run `openclaw doctor --fix` (also repairs `duplicate rows resolve to canonical session key` and the pending `agent database ... uses schema version 1` migration), complete any staged plugin upgrade (a sibling `openclaw-<channel>-*__openclaw-generation__g-*` project directory holding a newer version than the live one means an upgrade never switched), then restart and verify. Healthy dispatch marker for comparison: `dispatch complete (queuedFinal=true, replies=1)`; this failure instead logs `message dispatch completed ... outcome=error` right after `dispatching to agent`.
   Completion: you identified the reset that poisoned the claims and produced a repair plan that includes `openclaw doctor --fix`, not just a restart.

3c. Distinct case: the user reports "I had to send twice" / "did you reply?" although the log shows `received`, `dispatching to agent`, all model calls `status=200`, then `dispatch complete`. If it also logs `streaming start failed; using non-streaming card fallback for 60s: Error: Create card request failed with HTTP 400`, the reply WAS generated — Feishu only rejected creating the streaming card. Confirm the real error body yourself (the log drops it): get a tenant token from `/open-apis/auth/v3/tenant_access_token/internal` (app_id+app_secret from the channel account config), POST `/open-apis/cardkit/v1/cards` with the streaming card JSON (`config.streaming_mode=true`); error `code:99991672 ... [cardkit:card:write]` = missing Feishu app scope. Repair is a Feishu console action, not a server change: grant `cardkit:card:write` at `https://open.feishu.cn/app/<appId>/auth?q=cardkit:card:write` and publish a new version. CardKit streaming is a NEWER plugin feature; an upgrade newly surfaces this even when dispatch is healthy.
   Completion: you can state the reply was generated and name the missing scope (or rule out this branch — no `streaming start failed` line).

3d. On a multi-instance host running CLI/doctor against one deployment, set ALL THREE env vars or the command silently inspects the wrong one — `HOME=/data/agent/openclaw_<X>`, `OPENCLAW_CONFIG_PATH=/data/agent/openclaw_<X>/.openclaw/openclaw.json`, `OPENCLAW_STATE_DIR=/data/agent/openclaw_<X>/.openclaw`. A runtime may already export `OPENCLAW_STATE_DIR` at your deployment, overriding a foreground `VAR=...` prefix; start clean with `env -u OPENCLAW_STATE_DIR -u OPENCLAW_CONFIG_PATH HOME=... OPENCLAW_CONFIG_PATH=... OPENCLAW_STATE_DIR=... <cmd>`. Confirm it read the right deployment: findings reference `/data/agent/openclaw_<X>/.openclaw/agents/` paths. Run `openclaw doctor --fix` only AFTER stopping that instance's gateway — and your exec shell is likely a child of that gateway, so stopping it directly SIGTERMs your own command; do it from a detached `setsid nohup` script (match the pid by its `OPENCLAW_STATE_DIR` in `/proc/<pid>/environ`, then run the ops `start-all.sh`).
   Completion: you inspected/repaired the intended instance without killing your own exec context.

3e. Distinct case: 长任务“没有过程播报”/日志海量的 `300309 streaming mode is closed`（曾单日 3-5 万条）。机制：飞书卡片流式会话有生命周期上限，长回合静默 ~10 分钟触发 `200850 card streaming timeout` 关闭会话，之后所有 update 全部 300309 失败并重试成风暴；插件对这两个终态码无识别、无退避——2026.8.2 与 2026.9.4 的该代码路径逐字节一致（npm pack 拉新版逐段比对过），**升级不修复**。判定：看 `Started streaming` 时间戳——dispatch 后数秒内出现 = 健康；只随最终答案一次性出现且 Start/Close 相差 ~1 秒 = 中间文字从未刷出（坏）；300309 归零若因会话从未建立则不是修复证据。缓解：长任务分阶段短回复 + 关键节点用 lark-cli 以 bot 身份直发当前会话独立消息（操作规则与命令模板在 AGENTS.md「长任务播报」；禁止 `--as user`——消息落到用户自己的另一个窗口，已实测否决）。
   Completion: 你能区分“会话超时型 300309 风暴”、“健康但无流式”与“升级已修复”，并给出与升级无关的结论与替代播报方案。

3f. Distinct case: 飞书侧「完全没反应」，但日志里 `received message`/`dispatching to agent`/模型 `status=200` 都在，伴随 `[diagnostic] stalled session ... reason=blocked_tool_call activeTool=ask_user`（age 逐分钟增长）、`per-chat task exceeded 300000ms cap (key=...) evicting from queue`、重发消息 `cause=skipped:duplicate` 且 `dispatch complete (..., replies=0)`。机制：该会话早前一轮调了 ask_user 等用户回答且永不完成，chat lane 被独占，后续消息全部排队；300s cap 驱逐任务、防重逻辑把用户重发吞掉 → 表现为静默。菜单/卡片按钮连击是已观测诱因（2026-09-22 need 实例：同一菜单事件 7+ 次重复 dispatch）。与 3b 的判定对比：两者都有 `claim→adoption stalled ... 300000ms` 与 `keeping for retry` 行，但 **3f 重启即愈**（卡死的 turn 是内存态，重启即清），3b 重启后同样报错继续（持久化 claim 损坏）——刚重启过仍复发 → 3b；日志有 `blocked_tool_call ... ask_user` 的 stalled 告警 → 3f。恢复：重启该实例网关清队列，核对重启恢复日志（`main-session-restart-recovery` 后续 `status=ok`）确认积压消息已被处理并回复。若复发，属实例会话行为问题（模型在纯 IM 渠道选了无法完成的 ask_user），不是投递故障，转实例侧治理。
   Completion: 你能指出卡死的工具名与起始时刻、用「重启后是否复发」区分 3b/3f，且重启后确认积压消息已回复。

4. Compare core vs channel-plugin versions — the usual root cause:
   - core: `grep '"version"' /opt/openclaw/lib/node_modules/openclaw/package.json`
   - channel plugin: plugins install PER DEPLOYMENT. A host often runs several independent OpenClaw deployments (`ls -d /data/agent/openclaw_*`), each with its own `<deploy>/.openclaw/npm/projects/openclaw-<channel>-*/node_modules/@openclaw/<channel>/package.json` and often a different plugin version. Identify which deployment serves the affected agent from the running gateway's environment, never from `$HOME` or AGENTS.md paths (they can be stale after a deployment migration): `pgrep -f openclaw-gateway`, then `tr '\0' '\n' < /proc/<gateway-pid>/environ | grep OPENCLAW_STATE_DIR`. Read that deployment's plugin version.
   A core upgrade (core files freshly dated; core itself is shared globally under /opt/openclaw) without a matching plugin upgrade breaks dispatch for EVERY bot of that channel in each deployment still on the old plugin, not one agent. Compare file mtimes with `ls --time-style=full-iso` to see which side was upgraded when.
   Completion: you know which deployment serves the affected agent and can state core vs that deployment's plugin version and which is stale.

5. Check which plugin versions exist: `npm view @openclaw/<channel> versions` and `npm view @openclaw/<channel> dist-tags`. Pick the version matching core, or `latest`.
   Completion: you have an exact upgrade target.

6. Do not "fix" by restarting alone — a restart reloads the same stale plugin files. The repair is upgrading the plugin (`openclaw plugins update <id>`, or `openclaw plugins install @openclaw/<channel>@<version>`), then restarting the gateway. On a shared multi-agent gateway this briefly interrupts every agent's channels — state that before acting.
   Completion: plugin version matches core and the gateway restarted cleanly.

7. Verify end to end: ask the user to send a test message in the channel, then confirm the log shows `dispatching to agent` with no following `failed to dispatch`.
   Completion: one successful dispatch observed after the change.

## Pitfalls

- Restart churn in the log (`admission closed: restart drain`, repeated `shutdown completed cleanly`, several gateway processes starting seconds apart) is a symptom of someone already trying restart-only fixes — inspect plugin/core versions instead of restarting again.
- `⚠️ This reply completed without visible content` is a different, later-stage fallback (the turn ran but nothing visible was sent), not a dispatch failure; diagnose it separately.
- Per-day logs rotate: `/tmp/openclaw/openclaw-<date>.log` only exists for recent days, and a gateway that has run for days shows no startup line in today's file — its start time may predate the newest log.
- TUI/gateway-side "OpenClaw config is invalid ... channels.<ch>.streaming: invalid config for plugin <ch>: must be boolean" with `openclaw config validate` passing on the same file: two processes load different plugin generations. Chat keeps working because the gateway runs the new plugin whose schema accepts the new nested form (`streaming.mode`), and legacy scalar/boolean `streaming` is not read at runtime (docs/concepts/streaming.md per-channel legacy table). Find the stale generation the other process loaded: `ls <deploy>/.openclaw/npm/projects/` — a sibling `openclaw-<channel>-*` project dir older than the `__openclaw-generation__g-*` one means the upgrade left a stale non-authoritative generation on disk (doctor reports "Managed npm plugin installs have stale non-authoritative generations"). Run `openclaw doctor --fix` to migrate/clean, then re-verify `openclaw tui` with the exact same env the user used (`HOME`, `OPENCLAW_CONFIG_PATH`, `OPENCLAW_STATE_DIR`) — reproducing with the user's env is what isolates schema mismatch from real config error.
