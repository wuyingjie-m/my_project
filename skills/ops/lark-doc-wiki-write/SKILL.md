---
name: "lark-doc-wiki-write"
description: "用 lark-cli 向飞书 wiki 挂载的 docx 文档追加或改写内容时使用：wiki 节点解析、append 追加、markdown 转义与 @file 传参；表格数据走 lark-sheet-data-ops。"
---

# 飞书 Wiki 文档写作（lark-cli）

向形如 `https://xxx.feishu.cn/wiki/<token>` 的 wiki 挂载文档写入内容。系列连载文档一律 append 追加，除非用户明确要求整篇重写。身份按 AGENTS.md 第零铁律（专属 wrapper，必要时 `--as user`）。

## 步骤

1. 解析节点：`lark-cli wiki +node-get --node-token <token或完整URL>`（旗标名是 --node-token；没有 --url/--token）。确认 `obj_type=docx`，记 `obj_token`。完成：拿到 obj_token。
2. 读现状定写入方式：`lark-cli docs +fetch --doc <obj_token> --doc-format markdown`（旗标是 --doc，非 --doc-token）。已有内容（尤其系列文档）→ 定为 append；修正既有小段（如更正错误结论）→ `docs +update --command str_replace --pattern "<fetch 导出的转义形态>" --content "<新文本>" --doc-format markdown`（改动最小、不增篇幅，pattern 勿手打）；仅用户明确要求整篇重写才 overwrite（会丢图片与评论）。完成：写入方式已定。
3. 组稿成 markdown 文件，风格与前文对齐（标题层级、编号、章节骨架）。完成：文件落盘。
4. 追加写入：先 `cd` 到组稿文件目录，再 `docs +update --doc <obj_token> --command append --content @<文件>.md --doc-format markdown`。`@file` 只接受 cwd 相对路径（绝对路径报 unsafe）；长文本一律走 @file，不内联。完成：返回 ok:true 且 revision_id 增长。
5. 回读验证（不可省略）：`docs +fetch` 确认新内容在、既有章节未动、要点齐全。校验必须在 `json.load` 后的 `document.content` 层做、校验字符串从 fetch 原文复制——直接 grep fetch 落地的 JSON 包裹文件、或凭记忆手打标题，都会误报"内容丢失"（2026-10-08 实测：校验串与实际标题差两字，误报第四篇丢失，实际纯追加成功；字节数交叉验证可快速判定）。完成：验证项逐条为真。

## 转义与坑

- markdown 字面 `<`、`[`、`*` 等写入前须转义，规则见 `lark-cli skills read lark-doc/references/lark-doc-md.md`；代码块内无需转义。
- 命令输出 `"identity": "user"` 即走本人身份；agent 会话里先导出 OPENCLAW_AGENT_ID/AGENT_DIR（第零铁律）。
