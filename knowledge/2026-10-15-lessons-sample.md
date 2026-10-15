
## zxy agent 已从 openclaw.json 删除但日报链路仍在运行（10:54 排查）

- 事实：agents.entries 只剩 [wyj, jwh]；但 state 库 cron_jobs 里 workday-report-zxy / workday-morning-card-zxy 仍 enabled 且 agent_id=wyj；users.json 白名单仍含 zxy；agents/zxy/home 凭据槽位仍在磁盘。
- 昨晚实证：zxy 日报 2026-10-14 正常产出（workspaces/zxy/run/ 下有产物+publish_result），audit.jsonl 22:00 有 zxy subject 的 calendar/im 调用全 ok。
- 结论：删除配置只删了「交互式 agent」；数据管线的 zxy 身份 = broker subject + 磁盘凭据槽位 + wyj 名下 cron，三者都没删所以照跑。
- 教训：下线一个身份要清三处（cron 任务、users.json、凭据目录），只删 agents.entries 会留下「幽灵身份」管线。若阿祖确认曾夏杨不再需要日报，按此清单清理。

## 日报定时链路补充事实（11:05 排查）

- workday-report-jwh/zxy 两条 cron 的 payload.kind = **command**（非 agentTurn）：调度器直接跑冻结 shell 命令，全程零模型参与；agentId=wyj 只是任务归属。
- 冻结命令内嵌三重身份锚：① cd 该身份 workspace ② export OPENCLAW_AGENT_ID/DIR ③ --subject + --config。2026-09-14 创建时 --subject 就已写死。
- 关键结论：定时链路从不读 SKILL.md——SKILL.md 只服务交互路径（聊天里手动补报）。文档滞后不影响定时运行，但影响手动补报场景。
- 日志位置：各自 workspace run/personal-work-report/cron-last.log；失败时 diagnostics 会带日志尾部、lastStatus=failed（看板「暂失败」档吃这个字段）。
