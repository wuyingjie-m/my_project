---
name: workday-morning-card
description: 生成和维护个人工作早报卡片自动化。用户提到工作早报、早报卡片、简报卡片、昨日事项回顾、今日重点事项提醒、9:30 推送、从详细日报生成卡片，或需要在详细日报已写入飞书电子表格后读取对应日期日报并结合今日日程/代办生成清新可爱的可检查交互页面时使用。
---

# 工作早报卡片

本 Skill 在“个人工作日报详情”写入飞书电子表格之后运行。它会读取昨日完整日报，再结合今日飞书日程和可选代办，生成一张给用户检查的早报卡片 JPG 图片。

```text
飞书日报表格昨日单元格 + 今日日程/代办 -> generate_morning_card.py -> card.jpg
```

## 快速开始

### 结构化卡片数据（方案A，2026-08-12 确认）

日报 skill 生成日报时会同步产出 `card_data.json`（结构化：today_items/review_items/summary/encouragement），此时卡片脚本**带 `--card-data <路径>` 直接读取渲染**，不再解析日报正文，彻底避免“读旧格式/解析失败”问题：

```powershell
python3 scripts/generate_morning_card.py --config config-cqy.json --card-data run/workday-morning-card/2026-08-12/card_data.json --send
```

- 有 `--card-data` 且数据有效（today_items/review_items 至少一项非空）时，跳过读表格、LLM 生成文案等步骤，直接用结构化数据渲染。
- 没有 `--card-data` 时保持旧流程（读日报表格 → 解析正文 → LLM 兜底）作为回退，确保兼容旧调用。

### 服务器多用户配置规则

本 Skill 放在服务器实例中运行时，一个实例可能同时服务多个子 agent、多个使用者。使用本 Skill 前，agent 必须先核实本次早报对应的真实使用者姓名、部门和接收人 open_id，再创建或使用该使用者专属配置文件。

- 在 OpenClaw 多子 agent 服务器上，正式运行本 Skill 时，必须先 `cd` 到当前子 agent 的 workspace，例如 `/data/agent/openclaw_GTM/.openclaw/workspaces/wyj` 或 `~/.openclaw/workspaces/wyj`，再执行脚本。禁止 `cd` 到共享 Skill 目录或脚本目录后用 `python3 scripts/...` 执行；否则 `os.getcwd()` 无法识别当前 workspace，运行产物会回退写入共享 Skill 目录下的 `runs/`。
- 脚本会从当前 workspace 自动识别 `OPENCLAW_AGENT_ID` 和 `OPENCLAW_AGENT_DIR`。不要把下面的 Bash 逻辑拆成多次单独执行；服务器正式运行优先使用后文给出的单段命令。
- 如果必须手动导出当前 agent 身份，必须先从当前子 agent workspace 执行，且必须在任何可能离开 workspace 的 `cd` 之前执行：

  ```bash
  if [[ "$PWD" =~ ^(/data/agent/openclaw_[^/]+/\.openclaw)/workspaces/([^/]+) ]]; then
    export OPENCLAW_AGENT_ID="${BASH_REMATCH[2]}"
    export OPENCLAW_AGENT_DIR="${BASH_REMATCH[1]}/agents/${OPENCLAW_AGENT_ID}"
  fi
  ```

  后续所有 `lark-cli` 调用必须继承这个环境变量，使早报读取日报、读取今日日程和 `--as bot` 发送图片时都路由到 `${OPENCLAW_AGENT_DIR}/lark-cli`。禁止在未设置 `OPENCLAW_AGENT_DIR` 的情况下从 `/data/agent/openclaw_<实例>/.openclaw/workspace/skills/...` 这类共享 Skill 目录直接执行早报生成或发送；否则 `lark-cli --as bot` 会 fallback 到实例级 `.lark-cli`，可能用其他人的机器人把图片发出去。
- 必须使用 `config-姓名缩写.json` 命名专属配置，例如陈巧源使用 `config-cqy.json`，田细华使用 `config-txh.json`，吴英杰使用 `config-wyj.json`。
- 不允许在服务器多用户场景下直接修改或复用公共 `config.json`。`config.json` 只能作为本地单人调试默认配置或模板入口；多人共用时所有运行命令都必须显式传入 `--config config-姓名缩写.json`。
- 如果用户没有明确说明姓名，agent 必须先确认姓名后再运行；不能根据默认 `config.json`、历史运行记录或当前登录账号自行假设。
- 新建专属配置时，从 `config.example.json` 或已确认无个人敏感差异的模板复制，随后只修改该使用者对应的 `department`、`person_name`、`delivery.user_id`、日报表格来源、推送目标等字段。
- 早报 Skill 的专属配置必须与详细日报 Skill 中同一使用者的配置保持姓名、部门、日报表格 URL/sheet_id/行列定位规则一致，否则会读错日报单元格或把卡片发给错误的人。
- OpenClaw 定时执行本 Skill 的外层 agent/runtime 必须优先使用 DeepSeek 模型，不要使用 GLM-5.2。卡片生成流程会读取较长的 Skill 文档、日报正文、日程和工具返回，GLM-5.2 容易在上下文较大时出现 HTTP 200 但回复空文本、`stop=error` 或 “This reply completed without visible content”。这不是脚本内 `llm.model` 单独能解决的问题；需要在 OpenClaw 的 agent/cron/model 配置中把执行该 Skill 的模型切到 DeepSeek。

单人本地调试时，可以把 `config.example.json` 复制为 `config.json`；服务器正式运行时应复制为专属配置：

```powershell
Copy-Item config.example.json config-cqy.json
```

初始化专属配置时必须填写基础身份和推送目标：

```json
{
  "department": "部门",
  "person_name": "姓名",
  "llm": {
    "provider": "openai_compatible",
    "base_url": "https://api.deepseek.com",
    "model": "deepseek-v4-flash",
    "api_key_env": "DEEPSEEK_API_KEY",
    "command": ""
  },
  "delivery": {
    "enabled": true,
    "as": "bot",
    "user_id": "ou_xxx",
    "chat_id": ""
  }
}
```

其中 `delivery.user_id` 必须填写接收人的飞书 `open_id`，用于把早报卡片发送到“该用户与飞书机器人”的私聊窗口；`delivery.chat_id` 必须留空，除非明确改为群推送。

注意这里有两个模型配置：

- 外层 OpenClaw agent/runtime 模型：负责阅读本 Skill、执行命令、处理工具返回。服务器定时执行早报卡片时必须在 OpenClaw 的 agent/cron/model 配置中使用 DeepSeek，避免 GLM-5.2 因上下文过长返回空内容。
- 脚本内 `llm` 配置：负责 `generate_morning_card.py` 内部生成卡片文案。专属 `config-姓名缩写.json` 中也应保持 `base_url=https://api.deepseek.com`、`model=deepseek-v4-flash`、`api_key_env=DEEPSEEK_API_KEY`。

生成今天早报卡片，默认读取昨日详细日报：

```powershell
python3 scripts/generate_morning_card.py --config config-cqy.json
```

补跑指定日报日期，例如读取 2026-07-24 的详细日报，并按次日生成早报标题：

```powershell
python3 scripts/generate_morning_card.py --report-date 2026-07-24 --config config-cqy.json
```

生成后打开本地交互页面：

```powershell
python3 scripts/generate_morning_card.py --open --config config-cqy.json
```

生成后通过飞书机器人发送到用户与机器人的聊天窗口。OpenClaw 定时任务必须使用该模式（必须带 `--card-data`，详见上方方案A）：

```powershell
python3 scripts/generate_morning_card.py --send --config config-cqy.json --card-data run/workday-morning-card/<卡片日期>/card_data.json
```

OpenClaw 服务器正式运行时，不要照搬上面的相对路径命令，也不要使用 `~/.openclaw/...` 这种依赖 HOME 的路径。必须从子 agent workspace 启动，并从当前 workspace 推导 `.openclaw` 根目录，例如吴英杰 `wyj`：

```bash
cd /data/agent/openclaw_GTM/.openclaw/workspaces/wyj
OPENCLAW_ROOT="$(cd ../.. && pwd)"
python3 "$OPENCLAW_ROOT/workspace/skills/workday-morning-card/scripts/generate_morning_card.py" --send --config "$OPENCLAW_ROOT/workspace/skills/workday-morning-card/config-wyj.json" --card-data "run/workday-morning-card/<卡片日期>/card_data.json"
```

## 数据来源

- 详细日报：优先从 `source.daily_sheet` 指向的飞书电子表格读取，定位规则与 `personal-work-report` 一致：表头行找日期列，姓名列找 `person_name`，部门列校验 `department`。读取表格使用 `lark-cli sheets +csv-get --include-row-prefix --json`，兼容 lark-cli 1.0.69+；解析 `annotated_csv` 时必须按 `[row=N]` 前缀分块，保留单元格内多行日报正文，不能简单 `splitlines()`。
- 生成早报卡片时，只允许从详细日报读取工作事项相关内容：昨日事项只读“核心工作与成果”，今日事项只读“未完成事项/代办/明日计划”。不得读取或概括“协同、风险与所需支持”章节，也不得把协同风险写进今日重要事项、昨日事项回顾、昨日工作总结或今日一句。
- 今日日程：通过 `lark-cli calendar +agenda --as user --start {card_start_iso} --end {card_end_iso} --json` 获取早报当天 00:00-23:59 的日程。如果日程/待办是会议，只读取会议名称；不得读取或渲染会议时间、地点、参会人、会议链接、日程 JSON 字段或会议描述。
- 今日代办：通过 `tasks.command` 获取，可为空。不同 lark-cli task 版本差异较大，默认留空；需要时在 `config.json` 配置可执行命令。
- 天气 emoji：默认通过 `wttr.in` 抓取 `weather.city` 配置城市的早报当天粗略天气，只区分晴 `☀️`、阴 `☁️`、雨 `🌧️` 三类；抓取失败时使用 `weather.fallback_emoji`。

飞书部分一律使用 `lark-cli`。如果缺少 scope，按 stderr 提示执行 `lark-cli auth login --scope "..."` 后重跑。

## 输出格式

早报标题：

```text
YYYY年MM月DD日早报
```

卡片包含四块内容：

1. 今日重要事项：最多5条，优先逐条覆盖详细日报“未完成事项/代办/明日计划”中的每个 `重点工作事项`；只在该章节没有明确事项时再补充今日日程/代办。每条只写工作事项本身，不写交付物、预期成果、当前状态等字段。
2. 昨日事项回顾：最多5条，优先逐条覆盖详细日报“核心工作与成果”中的每一个事项；一个事项只生成一条，不得把某一事项的“工作事项/交付物/当前状态”等字段拆成多条，也不得只展开第一条事项而漏掉其他事项。不得从“协同、风险与所需支持”章节提取事项。
3. 昨日工作总结：2-3 句话，不超过 4 行，必须概括昨日多项工作的整体面，不得只围绕第一条事项展开；总结只概括工作事项，不罗列交付物字段，不写协同风险。
4. 今日一句：结合昨日事项和今日重点生成一句具体、亲和、有趣的鼓励语，不使用名人名言，不要固定句式；在图片中放大展示在最醒目的位置，第一眼要能看到。

事项文字尽量精炼自然，通常控制在 20-60 个中文字符；不要短成词组，也不要长成完整段落；不得为了字数硬截断半句话。需要缩短长事项时，必须优先切在最后一个自然标点边界，例如 `，`、`、`、`/`、`；`，不能硬切固定 14 个字符，也不要用 `...` 或 `…` 拼出半句话。事项过多时，摘要应先写完整一个事项，再自然追加“等 N 项工作/重点”。会议类事项只展示会议名称。

卡片风格要求：清新、可爱，鼓励语可以亲和有趣；JPG 模板可以使用少量 emoji，但不能堆砌。脚本必须自动识别卡片文本中的 emoji，并通过系统彩色 emoji 字体单独渲染，避免中文字体把 emoji 画成方框。页面用于用户检查，不直接替代完整日报存档。

## 风景底图样式

默认卡片样式为 `scenery-glass`：

- 使用 `assets/scenery` 中的竖版山水或建筑照片作为底图，按早报日期稳定选择一张；不是每次随机，避免同一天重复生成时背景变化。
- 卡片为竖版图片，接近移动端卡片视觉；由于 JPG 不支持透明圆角，最终 JPG 不使用透明圆角遮罩，避免四角出现白色空白。
- 风景图必须作为整张卡片的连续底图，不拆成“上方照片 + 下方独立面板”两块。
- 背景整体调暗，保留风景质感但确保白色文字清晰。
- 今日一句使用大字号放在醒目位置，优先级高于日期标题和正文。
- 今日一句最多只保留 1 个 emoji，必须醒目但不能花哨；标题不额外叠加固定 emoji，避免与今日一句重复。
- 正文直接放在暗化后的背景上，不使用正文框、卡片框、毛玻璃框或独立边框。
- 日期标题左对齐、适当放大，作为今日一句之后的第二层信息展示。
- 日期标题最左侧展示当天上海天气 emoji，只需粗略表达晴、阴、雨，不追求精确天气；天气 emoji 与日期标题之间只保留约一个中文字符的空隙，不使用 emoji 字体自身的宽松 advance 作为间距。
- 正文内容整体向卡片中部收拢；今日一句与标题之间保留约两行间隔，标题与正文之间保留约一行间隔。
- 风景照和正文区域之间不能出现明显分界线、硬切色块或独立边框；过渡应像参考图一样柔和。
- 卡片高度根据正文实际结束位置动态生成，正文结束后只保留约一行的底部留白，不保留大段空白。
- 标题、分区标题、今日一句和正文中出现的 emoji 都必须自动识别；JPG 输出时优先使用 `assets/emoji` 内置 PNG 小图标按目标字号缩放绘制，并按同一行中文文字的视觉中心做垂直对齐，避免 emoji 相比标题或今日一句偏上/偏下。Linux/OpenClaw 不得直接使用 `NotoColorEmoji.ttf` 绘制正文中的小 emoji，因为该字体是固定位图字体，容易出现 `invalid pixel size` 或 109px 巨型 emoji。今日一句由脚本强制限制为最多 1 个 emoji。
- JPG 最终只保留卡片本体，不输出卡片外侧的页面背景、白边或预览留白。
- 正文字号应优先保证移动端可读性，正文和总结不使用过小字体。
- 右上角不放爱心、收藏、按钮等装饰控件，标题区域只展示日期和“早报”，不展示用户名字。
- 标题必须单行展示，不换行；通过较小字号、`white-space: nowrap` 和必要时省略号控制。
- 日期标题作为辅助信息展示，不能抢过今日一句。
- 标题下方不放固定副标题；不要使用“昨日复盘完成，今天也轻轻稳稳向前走。”这类每日固定文案。
- 正文区域只允许使用全图暗化或轻微渐变增强可读性，不额外画框。
- 最终输出为 `card.jpg`；不把 HTML 作为默认交付物。
- 页面背景保持浅灰白，整体清新淡雅，不使用厚重商务风。

下载或补充风景底图：

```powershell
python3 scripts/download_scenery_backgrounds.py --count 50
```

下载脚本默认写入 `assets/scenery`，并生成 `manifest.json` 记录来源 URL、关键词和文件大小。若主来源不可用，脚本会自动尝试备用图片源。

补充或替换底图时，应优先选择阳光、明亮、清爽、积极的山水、海景、城市或建筑照片；删除阴暗、压抑、灰败、主体杂乱或不适合早报心情的图片。正式素材统一裁剪/归一为 `1080x1620` 竖版 JPG，替换后必须同步重写 `assets/scenery/manifest.json`，并保持正式 `scenery-*.jpg` 总数为 50 张。

## 文件产物

每次运行会写入当天运行目录，其中日期是早报日期：

- OpenClaw 多子 agent 场景：如果命令从 `/data/agent/openclaw_<实例>/.openclaw/workspaces/<agent>` 或其子目录启动，默认写入该子 agent 自己的 `/data/agent/openclaw_<实例>/.openclaw/workspaces/<agent>/run/workday-morning-card/YYYY-MM-DD`。
- 本地单人场景：默认写入 Skill 目录下的 `runs/YYYY-MM-DD`。
- 如果显式传入 `--run-dir`，则直接使用该目录作为本次运行目录；如果设置环境变量 `WORKDAY_MORNING_CARD_RUN_ROOT` 或配置 `runs_dir`，则写入 `<运行根目录>/YYYY-MM-DD`。

- `card_data.json`：早报结构化数据。
- `card.jpg`：可打开检查或推送的早报卡片图片。
- `delivery_result.json`：当开启飞书机器人发送时，记录发送身份、接收人、幂等键、飞书返回消息等结果。
- `source_report.txt`：从飞书表格读取到的完整详细日报。
- `raw_sources.json`：日程、代办和飞书读取状态。

## OpenClaw 飞书机器人推送

当本 Skill 放到 OpenClaw 上，并由 OpenClaw 连接飞书机器人推送给用户时，最终动作必须是“先生成 JPG，再由 bot 发送图片消息到用户与机器人的私聊窗口”。除非显式传入 `--no-send` 做本地调试，否则不得只停留在本地生成图片。

```text
generate_morning_card.py -> runs/YYYY-MM-DD/card.jpg -> lark-cli im +messages-send --as bot --user-id ou_xxx --image ./card.jpg
```

配置 `config.json`：

```json
{
  "delivery": {
    "enabled": true,
    "as": "bot",
    "user_id": "ou_xxx",
    "chat_id": "",
    "idempotency_prefix": "workday-morning-card",
    "timeout_seconds": 180
  }
}
```

- 发给用户与机器人私聊窗口：必须填写 `delivery.user_id` 为用户 `open_id`，例如 `ou_xxx`，`delivery.chat_id` 留空。
- 发到群聊：填写 `delivery.chat_id` 为群 `oc_xxx`，`delivery.user_id` 留空。
- `delivery.user_id` 和 `delivery.chat_id` 必须且只能填写一个。
- OpenClaw 定时运行时 `delivery.enabled` 必须为 `true`，或命令必须显式加 `--send`。推荐直接在 `config.json` 中设置 `delivery.enabled=true`，避免定时任务漏加参数。
- 如果需要临时禁止发送，即使配置打开，也可以运行 `python3 scripts/generate_morning_card.py --no-send`。

飞书机器人要求：

- 部署到 OpenClaw 时必须随 Skill 一起上传 `assets/fonts/NotoSansSC-VF.ttf`。OpenClaw/Linux 容器通常没有 Windows 中文字体；如果没有打包中文字体，Pillow 会回退到默认字体并把中文画成方块乱码。macOS 环境会优先尝试系统自带的苹方/华文字体，找不到时同样回退到 Skill 自带的 Noto 字体。
- `lark-cli` 已在 OpenClaw 运行环境完成应用配置，具备 bot 身份的 `app_id/app_secret`。
- 多子 agent 部署时，bot 身份的 `app_id/app_secret` 必须配置在当前子 agent 的独立 lark-cli HOME 中，例如 `${OPENCLAW_AGENT_DIR}/home/.lark-cli/...`，且发送前必须确认 `delivery_result.json` 中的 `lark_cli` 是 `${OPENCLAW_AGENT_DIR}/lark-cli`。不得使用实例级 `/data/agent/openclaw_<实例>/.lark-cli` 或全局 `/root/.lark-cli` 的 bot 配置发送早报图片。
- 飞书开发者后台给机器人开通 `im:message:send_as_bot`、`im:resource` 或 `im:resource:upload` 相关权限。
- 机器人必须在应用可见范围内覆盖接收用户；发私聊时，机器人需要具备给该用户发消息的关系/权限。
- 发送图片时脚本会从 `card.jpg` 所在目录执行 `lark-cli`，并传入 `./card.jpg` 相对路径，符合 `lark-cli` 对本地文件路径的安全限制。
- 脚本使用短 `idempotency_key` 防止同一天同一接收人重复发送；飞书会把它映射到消息 `uuid`，因此必须控制长度，避免触发 `field validation failed`。

## 定时任务

详细日报任务建议 08:00 运行；本 Skill 建议 09:30 运行。注册 Windows 定时任务：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/register_windows_task.ps1 -SkillPath . -Time 09:30
```

运行顺序必须保证：先完成详细日报写入飞书表格，再运行早报卡片。若未读到昨日完整日报，脚本会失败并提示检查详细日报任务。

OpenClaw 服务器定时任务必须从当前子 agent workspace 启动命令，例如 `/data/agent/openclaw_GTM/.openclaw/workspaces/wyj` 或 `~/.openclaw/workspaces/wyj`，并使用 `OPENCLAW_ROOT="$(cd ../.. && pwd)"` 推导脚本路径，再执行 `python3 "$OPENCLAW_ROOT/workspace/skills/workday-morning-card/scripts/generate_morning_card.py" --send --config "$OPENCLAW_ROOT/workspace/skills/workday-morning-card/config-姓名缩写.json" --card-data "run/workday-morning-card/<卡片日期>/card_data.json"`。脚本会自动识别当前 workspace，并把运行记录写到该 workspace 的 `run/workday-morning-card/YYYY-MM-DD`，避免同实例多个子 agent 共写共享 Skill 目录下的 `runs`。不得使用 `cd /data/agent/openclaw_<实例>/.openclaw/workspace/skills/workday-morning-card && python3 scripts/generate_morning_card.py ...` 这种写法。

定时任务对应的 OpenClaw agent/model 配置必须使用 DeepSeek，而不是 GLM-5.2。只把 `config-姓名缩写.json` 里的 `llm.model` 改成 DeepSeek，只会影响脚本内部文案生成；如果外层 agent 仍是 GLM-5.2，仍可能在读取 Skill 和处理工具返回时出现空回复。

## 维护规则

- `source.daily_sheet` 的 URL、sheet_id、表头行、部门列、姓名列、日期起始列应与同一使用者的 `personal-work-report` 专属配置保持一致。
- 每次运行前必须核实当前使用者姓名，并确认命令中显式带有对应 `--config config-姓名缩写.json`；如果发现命令会使用默认 `config.json`，必须停止并改用专属配置。
- `config.example.json` 保持通用模板；服务器多用户场景中，个人 open_id、姓名、部门、推送目标、日报表格定位等只能写入 `config-姓名缩写.json`，不得写入或覆盖公共 `config.json`。
- `llm.api_key_env` 只填环境变量名，不写真实 API key。服务器早报卡片专属配置中的脚本内 LLM 推荐保持 DeepSeek：`provider=openai_compatible`、`base_url=https://api.deepseek.com`、`model=deepseek-v4-flash`、`api_key_env=DEEPSEEK_API_KEY`。
- OpenClaw 定时执行本 Skill 的外层 agent/runtime 也必须切到 DeepSeek；不要让卡片 Skill 定时任务继续使用 GLM-5.2。
- `weather.city` 默认 `Shanghai`，可改为其他城市；天气服务失败不应阻断卡片生成。
- OpenClaw 推送时必须用 `delivery.user_id` 发送给用户与机器人私聊；只在明确需要群推送时使用 `delivery.chat_id`。发送身份默认 `bot`，不要把 bot 推送改成 `user` 身份。
- Windows、macOS、Linux/OpenClaw 都必须使用可覆盖简体中文的字体生成 JPG：Windows 优先微软雅黑/等线，macOS 优先苹方/华文，Linux/OpenClaw 优先本 Skill 自带的 `assets/fonts/NotoSansSC-VF.ttf` 或系统 Noto/WenQuanYi。NotoSansSC 可变字体必须显式设置字重，正文不应发虚，标题和分区标题必须使用 Bold/Medium 视觉重量。脚本找不到中文字体时应直接报错，不允许静默使用 `ImageFont.load_default()` 生成乱码图片。
- lark-cli 1.0.69+ 中 `sheets +csv-get` 不再使用 `--rows-json`，应使用 `--include-row-prefix --json` 并解析 `data.annotated_csv`；如果返回旧版 `data.rows`，脚本可继续兼容。
- 从飞书日报表格匹配用户行时必须跳过 `row_number <= header_row` 的表头行；匹配到用户行后还必须校验目标日期单元格的日报正文长度，默认少于 100 字符视为未读到完整日报并中止，不能用日期标题、空内容或极短内容继续生成早报卡片。
- emoji 资产放在 `assets/emoji`，至少包含天气、标题鼓励语和分区图标所需的 `sun/cloud/rain/rocket/pin/receipt/sparkles` 等 PNG。补充新 emoji 时应加入 `EMOJI_ASSET_NAMES` 映射，避免服务器上因彩色 emoji 字体差异导致图标过大、方块或错位。
- 鼓励语必须结合当天事项生成，例如“昨天完成了 X 等 N 项，今天继续把 Y 稳稳推进”；当昨日存在多条事项时必须体现多事项进展，避免只突出第一条事项。
- `card.max_today_items` 和 `card.max_review_items` 默认设为 `0`，表示不限制条数，按详细日报中的每一条事项分别生成；只有明确需要压缩版面时才改成具体数字。
- 卡片正文条目只展示事项文本，不能展示“工作事项：”“交付物：”“当前状态：”等字段名；不得把飞书日程的原始 JSON、`datetime`、`timezone` 等结构化字段渲染到卡片。每条事项尽量控制在 20-60 个中文字符，但必须自然完整，不得硬截断半句话；会议类日程和待办只展示会议名称。
- 早报卡片只读取详细日报中的工作事项，不读取“协同、风险与所需支持”章节；该章节不能进入今日重要事项、昨日事项回顾、昨日工作总结或今日一句。
- 卡片通过逐事项短摘要、动态高度、暗背景和适度行距保证可读性，正文不能显得拥挤；长事项应自然换行，不得因固定字数截断成不完整词语。
- 风景底图素材放在 `assets/scenery`，只保留明亮清新的山水、城市、建筑、桥梁等照片；删除人物、动物、黑猫、车辆特写、书本、食物、花草特写、画作、过暗森林、阴沉建筑等不适合作为早报底图的素材。正式素材必须统一为 `1080x1620`，并在每次增删后更新 `assets/scenery/manifest.json`。`runs/` 只保存每次生成的卡片结果。
