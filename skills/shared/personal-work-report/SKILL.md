---
name: personal-work-report
description: 生成和维护个人工作日周报自动化。用户提到日报、工作日报、个人日报、日周报、周报材料、工作记录沉淀，或需要通过 lark-cli 采集前一日飞书日历、妙记纪要、云文档、所有私聊和群聊消息，并从飞书“本地Agent使用记录”电子表格读取 AI 使用情况，再生成可沉淀到周报材料、知识库和 AI 资产库的结构化日报时使用。
---

# 个人工作日周报

使用本 Skill 运行或维护“每天早晨 8:00 存储前一日工作日报详情”的自动化流程。

整体流程先做确定性采集，再交给模型总结：

```text
collect_workday.py -> summarize_workday.py -> publish_workday.py
```

## 快速开始

### 服务器多用户配置规则

本 Skill 放在服务器实例中运行时，一个实例可能同时服务多个子 agent、多个使用者。使用本 Skill 前，agent 必须先核实本次日报对应的真实使用者姓名、部门和必要的飞书 open_id，再创建或使用该使用者专属配置文件。

- 在 OpenClaw 多子 agent 服务器上，正式运行本 Skill 时，必须先 `cd` 到当前子 agent 的 workspace，例如 `/data/agent/openclaw_GTM/.openclaw/workspaces/wyj`，再执行脚本。禁止 `cd` 到共享 Skill 目录或脚本目录后用 `python3 scripts/...` 执行；否则 `os.getcwd()` 无法识别当前 workspace，运行产物会回退写入共享 Skill 目录下的 `runs/`。
- 开始执行本 Skill 的任何命令前，必须先从当前子 agent workspace 导出当前 agent 身份，且必须在任何可能离开 workspace 的 `cd` 之前执行：

  ```bash
  if [[ "$PWD" =~ ^(/data/agent/openclaw_[^/]+/\.openclaw)/workspaces/([^/]+) ]]; then
    export OPENCLAW_AGENT_ID="${BASH_REMATCH[2]}"
    export OPENCLAW_AGENT_DIR="${BASH_REMATCH[1]}/agents/${OPENCLAW_AGENT_ID}"
  fi
  ```

  后续所有 `lark-cli` 调用必须继承这个环境变量，使全局 lark-cli shim 路由到 `${OPENCLAW_AGENT_DIR}/lark-cli`，再使用该子 agent 独立的 HOME 和授权。禁止在未设置 `OPENCLAW_AGENT_DIR` 的情况下从 `/data/agent/openclaw_<实例>/.openclaw/workspace/skills/...` 这类共享 Skill 目录直接执行飞书采集；否则会 fallback 到实例级 `.lark-cli` 并串用其他人的授权。
- 必须使用 `config-姓名缩写.json` 命名专属配置，例如陈巧源使用 `config-cqy.json`，田细华使用 `config-txh.json`，吴英杰使用 `config-wyj.json`。
- 不允许在服务器多用户场景下直接修改或复用公共 `config.json`。`config.json` 只能作为本地单人调试默认配置或模板入口；多人共用时所有运行命令都必须显式传入 `--config config-姓名缩写.json`。
- 如果用户没有明确说明姓名，agent 必须先确认姓名后再运行；不能根据默认 `config.json`、历史运行记录或当前登录账号自行假设。
- 新建专属配置时，从 `config.example.json` 或已确认无个人敏感差异的模板复制，随后只修改该使用者对应的 `department`、`person_name`、`person_open_id`、黑名单、发布目标等字段。

单人本地调试时，可以把 `config.example.json` 复制为 `config.json`；服务器正式运行时应复制为专属配置：

```powershell
Copy-Item config.example.json config-cqy.json
```

填写部门、姓名、飞书文档地址、聊天黑名单、大模型环境变量名和本地 AI 记录路径，然后显式指定配置运行：

```powershell
python3 scripts/run_workday_report.py --config config-cqy.json
```

补跑指定日期：

```powershell
python3 scripts/run_workday_report.py --date 2026-07-23 --config config-cqy.json
```

只生成本地文件、不写入飞书：

```powershell
python3 scripts/run_workday_report.py --skip-publish --config config-cqy.json
```

OpenClaw 服务器正式运行时，不要照搬上面的相对路径命令。必须从子 agent workspace 启动，并用绝对路径引用脚本和配置，例如吴英杰 `wyj`：

```bash
cd /data/agent/openclaw_GTM/.openclaw/workspaces/wyj
if [[ "$PWD" =~ ^(/data/agent/openclaw_[^/]+/\.openclaw)/workspaces/([^/]+) ]]; then
  export OPENCLAW_AGENT_ID="${BASH_REMATCH[2]}"
  export OPENCLAW_AGENT_DIR="${BASH_REMATCH[1]}/agents/${OPENCLAW_AGENT_ID}"
fi
python3 /data/agent/openclaw_GTM/.openclaw/workspace/skills/personal-work-report/scripts/run_workday_report.py \
  --config /data/agent/openclaw_GTM/.openclaw/workspace/skills/personal-work-report/config-wyj.json
```

## 数据来源

启用后从本次命令 `--config` 指定的使用者专属配置读取这些来源：

- `calendar_events`：通过 `lark-cli calendar +agenda --as user` 采集昨天 00:00-23:59 的会议/日程。
- `minutes`：通过 `lark-cli minutes +search --as user` 搜索昨天参与的妙记，必要时再用 `lark-cli vc +notes` 拉取纪要详情。
- `docs`：通过 `lark-cli docs +search --as user` 采集昨天创建或编辑过的飞书云文档，并按标题黑名单排除日报类文档。
- `im_messages`：默认通过 `lark-cli im +chat-list --as user --types=group,p2p --page-size 100 --sort active_time --json` 读取该用户当前可见的所有私聊和群聊，并自动翻页；再排除 `blacklist.chat_names` 和 `blacklist.chat_ids`。私聊保留当天对话上下文；群聊只围绕“我发的消息”或“@我的消息”保留前后上下文，避免把群里其他人的普通发言归纳为该用户工作。
- `ai_usage_sheet`：通过飞书“本地Agent使用记录”电子表格读取 AI 使用情况。脚本按 `department`、`person_name` 和目标日期列定位单元格，该单元格内容即为当天 AI 使用记录。

飞书部分一律使用 `lark-cli`。如果命令因为权限失败，按 stderr 提示执行对应的 `lark-cli auth login --scope "..."` 增量授权后再重跑。

## 聊天黑名单

默认 IM 采集会读取当前飞书用户可见的所有私聊和群聊。因此，任何不希望进入采集范围的群聊、私聊、机器人会话、生活群、敏感群，都必须先写入黑名单：

- `blacklist.chat_names`：按群聊或私聊名称关键词排除，例如 `"闲聊"`、`"生活"`。
- `blacklist.chat_ids`：按飞书 chat_id 精确排除，例如 `"oc_xxx"`。

黑名单在拉取具体消息前生效；命中黑名单的聊天不会进入日报采集。

`feishu.im_messages.configured_chats` 只用于补充指定聊天，或在 `chat_list_command` 不可用时兜底。默认场景保持空数组即可。

## 大模型配置

`llm.api_key_env` 填的是环境变量名，不是 API key 明文。不要把 `sk-...` 这类真实 key 写进 `config.json`。

默认配置：

```json
{
  "provider": "openai_compatible",
  "base_url": "https://api.deepseek.com",
  "model": "deepseek-v4-flash",
  "api_key_env": "DEEPSEEK_API_KEY"
}
```

运行前在系统环境变量中设置真实 key，例如 PowerShell 当前窗口：

```powershell
$env:DEEPSEEK_API_KEY="你的真实 API key"
```

`summarize_workday.py` 会读取 `DEEPSEEK_API_KEY` 并调用 `base_url/model` 指定的模型生成日报。没有配置 key 时会生成本地兜底草稿。

## AI 使用采集口径

AI 使用记录只允许来自配置的飞书电子表格 `feishu.ai_usage_sheet`：

- 表格结构默认第 2 行为表头，A 列为部门，B 列为姓名，C 列起为日期。
- 脚本会按部门、姓名和目标日期定位唯一单元格。
- 该单元格内容就是当天 AI 使用记录；日报第 4 节只能基于该内容总结。

不要扫描本地 Codex、Claude Code、OpenClaw 等 Agent 会话目录。AI 记录进入日报时，要归并成工作口径：AI 做了什么、产生了什么效果、形成了什么可复用资产。不要把完整原文流水写进日报。

## 日报格式

日报标题必须是：

```text
部门 + 姓名 + 工作日报 YYYY年MM月DD日
```

正文必须包含五个章节，最终发布到飞书的版本不包含“重点项目与任务进展”：

1. 核心工作与成果
2. 协同、风险与所需支持
3. AI提效与知识资产沉淀
4. 未完成事项/代办/明日计划
5. 重要文档与链接

写作要求：

- 说清完成了什么工作、交付了什么内容、形成了什么成果、产生了什么业务价值。
- “核心工作与成果”中的每个事项，如果证据中有相关飞书文档、会议纪要、妙记或其他交付物链接，必须在该事项内附上链接；如果没有明确链接证据，写“相关文档/会议纪要：无明确证据”，不要省略字段。
- 不要输出“重点项目与任务进展”章节；跨周期事项如当天有实际推进，应合并写入“核心工作与成果”或“未完成事项/代办/明日计划”。
- 证据不足的事项写“待确认”，不要编造责任人、状态、日期、交付物或链接。
- AI 记录只作为提效和资产沉淀证据，不写工具流水账。
- “重要文档与链接”只放筛选后值得进入部门知识沉淀的高价值文档，写文档名称、链接、分类和建议存储的知识库位置；不要把会议纪要、妙记、普通过程文档或所有关联文档全量放入第 5 节，除非它们已经整理成可复用方法论、标准流程、项目复盘、关键方案或正式交付物。

## 输出文件

每次运行会写入当天运行目录：

- OpenClaw 多子 agent 场景：如果命令从 `/data/agent/openclaw_<实例>/.openclaw/workspaces/<agent>` 或其子目录启动，默认写入该子 agent 自己的 `/data/agent/openclaw_<实例>/.openclaw/workspaces/<agent>/run/personal-work-report/YYYY-MM-DD`。
- 本地单人场景：默认写入 Skill 目录下的 `runs/YYYY-MM-DD`。
- 如果显式传入 `--run-dir`，则直接使用该目录作为本次运行目录；如果设置环境变量 `PERSONAL_WORK_REPORT_RUN_ROOT` 或配置 `runs_dir`，则写入 `<运行根目录>/YYYY-MM-DD`。

- `raw.json`：原始命令输出和来源状态。
- `filtered.json`：模型使用的归一化证据。
- `prompt.md`：发送给模型的提示词。
- `report.md`：最终 Markdown 日报。
- `weekly_materials.json`：可复用到周报的结构化材料。
- `publish_result.json`：飞书写入或 dry-run 状态。

## 发布规则

`publish_workday.py` 总会存储本地文件。只有当 `publish.dry_run` 为 `false`，且没有使用 `--skip-publish` 时，才写入飞书文档。

### 发布到飞书电子表格

如果日报要写入“工作日报”类飞书电子表格，优先使用 `publish.daily_sheet`。脚本会：

- 解析 `daily_sheet.url`，支持飞书 Wiki 链接和原始 spreadsheet token。
- 读取工作簿，定位 `sheet_id`；没有配置 `sheet_id` 时使用 `sheet_name`，仍没有命中时使用第一个工作表。
- 在 `header_row` 中查找目标日期列，日期格式为 `YYYY年M月D日`，例如 `2026年7月24日`。
- 在 `name_column` 中查找 `person_name`，并用 `department_column` 校验 `department`。
- 如果目标日期列不存在，按日期倒序插入新列并写入表头。
- 写入飞书表格前必须把 Markdown 日报转换为适合单元格阅读的纯文本分段格式：保留标题、章节、条目和链接内容，但单元格内不得保留 Markdown 语法标记，例如 `#`/`###` 标题符、`**` 粗体、反引号、Markdown 链接写法、表格分隔线或列表前缀；链接统一转成 `文档名：URL` 或直接 URL，避免飞书表格无法渲染 Markdown。
- 写入单元格时强制设置：左对齐、顶部对齐、裁剪显示、普通字重、默认飞书界面 11 号字体、文本格式；配置中的 `font_size` 表示飞书界面字号。脚本发布到任意目标单元格时都必须同时写入 `cell_styles.font_size`，并在后续 `cells-set-style` 中按 `ceil(font_size * 4 / 3)` 换算为 px 后再次设置字号，确保飞书表格界面显示为 11 号而不是 9 号。
- 写入后执行 `lark-cli sheets +rows-resize --type pixel --size <row_height>`，默认固定为 120px 行高；未点开单元格时只展示前面部分，点开单元格后再查看完整上下文，避免日报内容把行高撑得过长。

示例配置：

```json
{
  "publish": {
    "dry_run": false,
    "daily_sheet": {
      "enabled": true,
      "url": "https://atrenew.feishu.cn/wiki/...",
      "sheet_id": "",
      "sheet_name": "",
      "scan_range": "A1:AZ300",
      "header_row": 2,
      "department_column": "A",
      "name_column": "B",
      "first_date_column": "C",
      "font_size": 11,
      "word_wrap": "word-clip",
      "row_height": 120
    }
  }
}
```

发布到飞书表格需要 `lark-cli` 用户权限：`sheets:spreadsheet:read` 和 `sheets:spreadsheet:write_only`。如果命令提示缺 scope，按提示执行 `lark-cli auth login --scope "..."` 后重跑。

### 发布到飞书文档

默认写入飞书文档的命令是：

```powershell
lark-cli docs +update --as user --api-version v2 --doc <url> --command append --doc-format markdown --content -
```

如果当前 lark-cli 版本需要其他写入方式，在 `config.json` 的 `publish.commands.write_doc` 中配置命令。脚本会替换 `{date}`、`{report_path}`、`{report_text}` 和 `{title}`。

## 定时任务

手动 dry-run 跑通后，用内置 Windows 脚本注册每天 08:00 的定时任务：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/register_windows_task.ps1 -SkillPath . -Time 08:00
```

定时任务每天按本地时区生成前一日工作日报。启用真实飞书写入前，先确认本地报告质量稳定。

OpenClaw 服务器定时任务必须从当前子 agent workspace 启动命令，例如 `/data/agent/openclaw_GTM/.openclaw/workspaces/wyj`，并使用 `python3 /绝对路径/scripts/run_workday_report.py --config /绝对路径/config-姓名缩写.json`。脚本会自动识别当前 workspace，并把运行记录写到该 workspace 的 `run/personal-work-report/YYYY-MM-DD`，避免同实例多个子 agent 共写共享 Skill 目录下的 `runs`。不得使用 `cd /data/agent/openclaw_<实例>/.openclaw/workspace/skills/personal-work-report && python3 scripts/run_workday_report.py ...` 这种写法。

## 维护规则

- `config.example.json` 保持通用模板；服务器多用户场景中，个人群 ID、文档 URL、open_id、姓名、部门、推送目标等只能写入 `config-姓名缩写.json`，不得写入或覆盖公共 `config.json`。真实 API key 不要写入任何配置文件，只放环境变量。
- 每次运行前必须核实当前使用者姓名，并确认命令中显式带有对应 `--config config-姓名缩写.json`；如果发现命令会使用默认 `config.json`，必须停止并改用专属配置。
- IM 时间优先使用带时区的 ISO 字符串；只有本地 lark-cli 命令明确要求时才改用 epoch 秒。
- 日报类文档标题必须加入黑名单，避免生成内容被再次喂回日报链路。
- 变更日报章节时，同步更新 `references/report_schema.md` 和 `scripts/summarize_workday.py`。
