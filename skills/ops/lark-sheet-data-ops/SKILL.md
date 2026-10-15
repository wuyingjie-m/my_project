---
name: "lark-sheet-data-ops"
description: "用 lark-cli 读取/解析/写入飞书表格数据时使用：+csv-get 全量读取与 annotated_csv 逻辑行解析、+cells-set 写长文本、+dim-insert 插列、样式补刷与回读验证。lark-cli 安装/授权/路由修复走 lark-cli-repair。"
---

# lark-cli 飞书表格数据读写

通用表格数据操作流程。身份导出（OPENCLAW_AGENT_ID/AGENT_DIR + 本人 wrapper）按 AGENTS.md 第零铁律，所有命令带 `--as user`。周报等业务流程见 workspace 技能（如 weekly-lark-ai-report），本文是表格机制的权威实现细节。

## 步骤

1. 定位表格：`/sheets/<token>` URL 直接取 token；wiki 链接先 `lark-cli wiki +node-get --as user --node-token <wiki_token>`，确认 `obj_type=sheet` 后用返回的 `obj_token`。`+workbook-info --spreadsheet-token <token> --json` 查 sheet_id、行数、列数。完成：拿到 spreadsheet token + sheet_id。
2. 全量读取：`+csv-get --as user --spreadsheet-token <token> --sheet-id <id> --json --output-path <文件>`。stdout 有字符上限，凡供程序解析的一律落文件；stdout 回执必须 `complete: true` 才可信（截断的表会"找不到人/行"）。完成：文件落盘且回执 complete=true。
3. 解析 annotated_csv（最易踩坑步）：按**逻辑行**切分 `csvText.split(/\n(?=\[row=\d+\])/)`，每条记录单独用引号感知解析器解析（处理单元格内换行、逗号、`""` 转义）。**禁止**先按物理行过滤出 `[row=N]` 前缀行再拼接——引号内换行的续行不以 `[row=N]` 开头，过滤即丢失，整表行错位（2026-09-18 实测：日报表吴英杰行"找不到"；改逻辑行切分后一次定位成功）。行号取输出的 `[row=N]` 前缀，列字母取 `col_indices[j]`，不要自己数。完成：能按部门/姓名等键唯一定位目标行。
4. 写入单元格：含换行/长文本的内容用 node 构造 `[[{"value":"..."}]]` 写入临时文件，`+cells-set --cells @<文件>`；禁止内联拼 JSON（换行引号必坏）。`--range` 与 cells 维度必须一致。目标格可能已有内容时先回读确认，覆盖已有内容前需用户确认。完成：返回 `ok: true`。
5. 插入行/列：`+dim-insert --position <列字母或行号> --count 1` 在该位置**之前**插入（周报表"最新周在最前"模式：新周列插在 D 前再写表头）。插入后立即回读表头/边界行，确认移位正确、既有数据无损，再写新内容。完成：回读确认移位与数据完好。
6. 样式：写入后 `+cells-set-style --range <目标> --font-size 12 --horizontal-alignment left --vertical-alignment top`。写入 value 时随附的 cell_styles 回读不直观，统一写入后补刷一次。完成：命令返回 `ok: true`。
7. 回读验证（不可省略的收尾）：`+csv-get --range <目标范围>` 回读，逐项确认内容落在正确行列、无残缺。完成：回读内容与预期一致。
