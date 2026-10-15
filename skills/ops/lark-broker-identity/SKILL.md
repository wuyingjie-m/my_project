---
name: "lark-broker-identity"
description: "以指定身份调用飞书（LARK_BROKER_SUBJECT / lark-broker）、排查串身份或 unauthorized subject 时使用；跨身份任务链（日报等）的身份路由与 audit.jsonl 取证；下线某身份（删了 agents.entries 但定时任务还在跑的幽灵身份）时使用。"
---

# lark-broker 身份路由与身份下线

## 架构（30 秒版）

- **wrapper**（`<实例>/.openclaw/agents/<id>/lark-cli`）：export HOME/XDG 到该 agent 独立 home 后 exec 真实 CLI——管「凭据存哪」，无校验无审计。修复见 lark-cli-repair。
- **broker**（仅 sxs 实例：`/data/agent/openclaw_sxs/.openclaw/lark-broker/`）：显式声明身份的代理层——校验 subject ∈ `users.json` 白名单、命令族 ∈ ALLOWED（calendar/minutes/vc/docs/im/wiki/sheets）、home 路径不出实例边界，写 `audit.jsonl`（started/ok 各一条，300s 超时），然后 **exec 的就是同身份 wrapper**（凭据仍取本人槽位，不发生"借用"）。
- 单身份实例（如 XMT/fqc）无 broker，wrapper 直连即可；多身份共存的实例（sxs）跨身份调用必须走 broker。出错模式从「静默串身份」变「当场拒绝 + 有据可查」。

## 以指定身份调用

```bash
export OPENCLAW_AGENT_ID=wyj OPENCLAW_AGENT_DIR=/data/agent/openclaw_sxs/.openclaw/agents/wyj LARK_BROKER_SUBJECT=<目标身份>
/data/agent/openclaw_sxs/.openclaw/lark-broker/bin/lark-broker <lark-cli 原参数>
```

- `--subject <身份>` 旗标可替代环境变量。
- 完成：命令返回结果，且 `tail audit.jsonl` 出现该 subject 的 started+ok 两条。
- 报 `unauthorized subject` = 白名单无此身份（查 `users.json`）；报 `disallowed lark-cli command family` = 命令族不在 ALLOWED；报 `subject path is outside openclaw_sxs` = 配置的 home/agent_dir 越界。
- 取证：`grep '"subject": "<id>"' audit.jsonl` 出次数/操作/成败；逐条含 time/subject/operation/status。

## personal-work-report 的接线（三个必记点）

1. `run_workday_report.py --subject <身份>` **必填**（argparse required）——漏传报错退出，不静默串身份。
2. 身份一经声明，`scripts/common.py` 的 `resolve_lark_command()` 把**所有** lark 调用路由进 broker（LARK_BROKER_SUBJECT 有值 → 必走 broker；无值 → 直连 lark-cli，仅限单人本地调试）。模型只做一次决定（选身份），后续几十次调用全是确定性代码——这就是多身份日报（jwh/zxy/wyj）不出错的原因。
3. `config-<id>.json` 里**没有** subject 字段——身份是每次运行的声明，不固化在配置。⚠️ 该 skill 的 SKILL.md（2026-09-07 版）早于 broker（09-14 上线），全文未提 `--subject`：身份问题以代码层为准，勿按 SKILL.md 旧路径排查。

## 幽灵身份（删除 agents.entries ≠ 管线下线）

`openclaw.json` 的 `agents.entries` 删掉某 id 只删交互式 agent；数据管线三件套不随之消失，cron 照跑（2026-10-15 实证：zxy 的 agent 条目已删，但其日报当晚正常产出、audit 全 ok）：

| 管线依赖 | 查/清位置 |
| --- | --- |
| 定时任务 | state 库 `cron_jobs`（/tmp 副本查，见 multi-instance-cron-audit 步骤 2；command 负载任务受限 API 不可见，管理走 CLI，见 openclaw-automation-jobs 步骤 5） |
| broker 白名单 | `lark-broker/users.json` |
| 凭据槽位 | `agents/<id>/home/` |

**下线清单（按序）**：① 停用该身份的定时任务（CLI `openclaw cron edit` 或 disabled），**观察一天**确认无副作用再删；② `users.json` 移除该 subject（先备份）；③ 归档 `agents/<id>/home/`（mv 到带日期的归档目录，不 rm）。只清任何一处都会留残线。
完成：该身份在 `cron_jobs` 与 `audit.jsonl` 中零新增活动。
