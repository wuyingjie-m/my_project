import argparse
import json
import os
import re
import subprocess
import urllib.error
import urllib.request
from pathlib import Path

from common import compact_text, date_window, load_config, report_output_path, report_title, resolve_date, run_dir, write_json


def parse_args():
    parser = argparse.ArgumentParser(description="根据采集证据生成个人工作日报详情")
    parser.add_argument("--date", help="目标日期 YYYY-MM-DD，默认昨天")
    parser.add_argument("--config", help="配置文件路径")
    parser.add_argument("--run-dir", help="运行产物目录")
    return parser.parse_args()


def compact_evidence_for_prompt(evidence: dict, max_items_per_source: int = 80, max_total_chars: int = 90000) -> dict:
    compacted = {key: value for key, value in evidence.items() if key != "sources"}
    compacted["sources"] = []
    total_chars = 0
    for source in evidence.get("sources", []):
        compact_source = {
            "source": source.get("source"),
            "kept_count": source.get("kept_count", len(source.get("items", []))),
            "items": [],
        }
        for item in source.get("items", [])[:max_items_per_source]:
            if total_chars >= max_total_chars:
                break
            kept = {}
            if isinstance(item, dict):
                for key in (
                    "type",
                    "chat_kind",
                    "chat_name",
                    "relation_to_me",
                    "text",
                    "title",
                    "url",
                    "doc_url",
                    "app_link",
                    "token",
                    "cell",
                ):
                    if item.get(key) not in (None, ""):
                        kept[key] = item.get(key)
                raw = item.get("raw") if isinstance(item.get("raw"), dict) else {}
                for raw_key in ("create_time", "message_app_link", "sender", "content", "app_link", "description"):
                    if raw.get(raw_key) not in (None, ""):
                        kept[f"raw_{raw_key}"] = raw.get(raw_key)
            else:
                kept = {"text": item}
            compact_item = {key: compact_text(value, 1200) for key, value in kept.items()}
            item_chars = len(json.dumps(compact_item, ensure_ascii=False))
            total_chars += item_chars
            compact_source["items"].append(compact_item)
        compacted["sources"].append(compact_source)
    return compacted


def build_prompt(config: dict, evidence: dict, title: str) -> str:
    prompt_evidence = compact_evidence_for_prompt(evidence)
    return f"""你是严谨的个人工作日周报助手。请只基于证据生成中文工作日报详情。

硬性要求：
1. 不编造事实、数字、链接、责任人、完成时间；证据不足写“待确认”。
2. 报告标题必须是：{title}
3. 必须输出合法 JSON，不要输出额外解释。
4. report_markdown 必须是完整 Markdown，包含 1-5 五个章节，不要输出“重点项目与任务进展”章节。
5. weekly_materials 必须把可进入周报的事项结构化，便于周报复用。
6. AI 使用记录只写成工作口径：AI做了什么、有什么效果、形成什么可复用资产，不写原始对话流水。
7. 群聊消息只作为工作信号和协同证据，不能把别人的普通发言写成“我完成了”。
8. `im_group_context` 中 relation_to_me 为 `group_context_before_anchor` 或 `group_context_after_anchor` 的消息只是上下文；只有 `sent_by_me`、`mentioned_me` 或其他证据证明本人动作时，才能归纳为本人工作。
9. “核心工作与成果”中的每个事项，如果证据中有相关飞书文档、会议纪要、妙记或其他交付物链接，必须在该事项内附上链接；如果没有明确链接证据，写“相关文档/会议纪要：无明确证据”，不要省略字段。
10. “重要文档与链接”只放筛选后值得进入部门知识沉淀的高价值文档；不要把会议纪要、妙记、普通过程文档或所有关联文档全量放入第 5 节，除非它们已经整理成可复用方法论、标准流程、项目复盘、关键方案或正式交付物。
11. “AI提效与知识资产沉淀”只能基于 `ai_usage_sheet` 来源的证据总结，不要引用或推断本地 Codex、Claude Code、OpenClaw 等 Agent 会话目录中的内容。
12. 报告正文只允许使用 1-5 五个 `##` 章节标题；章节内部事项不要使用 `#` 或 `###` 标题，统一用普通条目或加粗事项名，避免把证据原文中的 Markdown 标题带入日报。

输出 JSON 格式：
{{
  "report_markdown": "# {title}\\n\\n## 1. 核心工作与成果\\n...",
  "weekly_materials": {{
    "core_results": [],
    "projects": [],
    "risks_and_support": [],
    "ai_assets": [],
    "next_plan": [],
    "important_docs": []
  }}
}}

报告章节要求：

## 1. 核心工作与成果
每条包含：工作事项、本期完成内容、核心成果、交付物、相关文档/会议纪要、业务价值、当前状态。
统一描述：完成了什么工作 + 交付了什么内容 + 形成了什么成果 + 产生了什么价值。
如果该事项产生或关联了飞书文档、会议纪要、妙记或其他交付物链接，必须在“相关文档/会议纪要”中附上名称和链接；没有明确链接证据时写“无明确证据”。

## 2. 协同、风险与所需支持
每条包含：事项描述、事项类型、协同对象/责任人、当前进展、影响范围、需要的支持、期望完成时间。

## 3. AI提效与知识资产沉淀
每条包含：AI/自动化应用场景、使用的Skill或Workflow、本期优化内容、节省时间/提升效率、形成的文档或链接、是否具备复用价值、建议沉淀类型、后续优化计划。

## 4. 未完成事项/代办/明日计划
每条包含：重点工作事项、预期成果、计划交付物、优先级、计划完成时间、所需协同或资源。

## 5. 重要文档与链接
每条包含：文档名称、文档链接、文档分类、应当存储知识库位。
只放筛选后值得进入部门知识沉淀的高价值文档，不要把会议纪要、妙记、普通过程文档或所有关联文档全量放入本节，除非它们已经整理成可复用方法论、标准流程、项目复盘、关键方案或正式交付物。
如果当天没有明确值得沉淀的文档，写“无明确需要沉淀的重要文档”，不要为了凑数放入普通会议纪要或运行证据。

证据：
```json
{json.dumps(prompt_evidence, ensure_ascii=False, indent=2)}
```
"""


def call_command(command: str, prompt: str, out_dir: Path) -> str:
    prompt_path = out_dir / "prompt.md"
    env = os.environ.copy()
    env["WORKDAY_REPORT_PROMPT"] = prompt
    result = subprocess.run(
        command.format(prompt=str(prompt_path), run_dir=str(out_dir)),
        shell=True,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        timeout=300,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr or result.stdout)
    return result.stdout


def call_openai_compatible(llm: dict, prompt: str) -> str:
    api_key_env = llm.get("api_key_env", "DEEPSEEK_API_KEY")
    api_key = os.environ.get(api_key_env, "")
    if not api_key:
        raise RuntimeError(f"未设置大模型 API Key 环境变量：{api_key_env}")
    base_url = llm.get("base_url", "https://api.openai.com/v1").rstrip("/")
    payload = {
        "model": llm.get("model", "gpt-4.1"),
        "messages": [
            {"role": "system", "content": "你只输出合法 JSON，不输出 Markdown 代码围栏。"},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.2,
        "max_tokens": llm.get("max_tokens", 8192),
    }
    extra_body = llm.get("extra_body")
    if isinstance(extra_body, dict):
        payload.update(extra_body)
    request = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(exc.read().decode("utf-8", errors="replace")) from exc
    return data["choices"][0]["message"]["content"]


def parse_model_output(text: str) -> dict:
    """解析模型输出为报告 JSON；容忍尾随文本或重复 JSON 对象。"""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    decoder = json.JSONDecoder()
    fallback_obj = None
    idx = text.find("{")
    while idx != -1:
        try:
            obj, _end = decoder.raw_decode(text, idx)
        except json.JSONDecodeError:
            idx = text.find("{", idx + 1)
            continue
        if isinstance(obj, dict):
            if obj.get("report_markdown"):
                return obj
            if fallback_obj is None:
                fallback_obj = obj
        idx = text.find("{", idx + 1)
    if fallback_obj is not None:
        return fallback_obj
    match = re.search(r"\{.*\}", text, flags=re.S)
    if match:
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            pass
    return {"report_markdown": text.strip(), "weekly_materials": {}}


def remove_project_progress_section(markdown: str) -> str:
    section_re = re.compile(r"(?m)^##\s*(?:\d+[.、]\s*)?([^\n]+?)\s*$")
    matches = list(section_re.finditer(markdown))
    if not matches:
        return markdown

    kept_parts = []
    cursor = 0
    removed = False
    for idx, match in enumerate(matches):
        title = match.group(1).strip()
        start = match.start()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(markdown)
        if title == "重点项目与任务进展":
            kept_parts.append(markdown[cursor:start])
            cursor = end
            removed = True
    if not removed:
        return markdown
    kept_parts.append(markdown[cursor:])
    cleaned = "".join(kept_parts)

    section_titles = [
        "核心工作与成果",
        "协同、风险与所需支持",
        "AI提效与知识资产沉淀",
        "未完成事项/代办/明日计划",
        "重要文档与链接",
    ]
    for idx, title in enumerate(section_titles, start=1):
        cleaned = re.sub(
            rf"(?m)^##\s*(?:\d+[.、]\s*)?{re.escape(title)}\s*$",
            f"## {idx}. {title}",
            cleaned,
            count=1,
        )
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def fallback_report(title: str, evidence: dict, error: str) -> dict:
    source_lines = []
    for source in evidence.get("sources", []):
        source_lines.append(f"- {source.get('source')}: {source.get('kept_count', len(source.get('items', [])))} 条")
    markdown = f"""# {title}

## 1. 核心工作与成果

- 工作事项：待模型提炼
- 本期完成内容：已完成前一日数据采集，本地生成兜底草稿
- 核心成果：形成 `filtered.json` 证据文件
- 交付物：本地运行目录中的采集文件
- 相关文档/会议纪要：本地 `filtered.json`
- 业务价值：为日报和周报材料提供可追溯证据
- 当前状态：待补充模型总结

## 2. 协同、风险与所需支持

- 事项描述：大模型调用失败：{error}
- 事项类型：工具配置
- 协同对象/责任人：待确认
- 当前进展：已保留采集证据
- 影响范围：日报正文需要人工或模型重跑
- 需要的支持：检查模型 API Key 或 llm.command
- 期望完成时间：待确认

## 3. AI提效与知识资产沉淀

- AI/自动化应用场景：个人日报采集与总结
- 使用的Skill或Workflow：personal-work-report
- 本期优化内容：完成数据采集落盘
- 节省时间/提升效率：待确认
- 形成的文档或链接：`filtered.json`
- 是否具备复用价值：是
- 建议沉淀类型：日报自动化运行证据
- 后续优化计划：修复模型配置后重跑 `summarize_workday.py`

## 4. 未完成事项/代办/明日计划

- 重点工作事项：重新生成正式日报
- 预期成果：得到完整五段式日报
- 计划交付物：`report.md`
- 优先级：高
- 计划完成时间：待确认
- 所需协同或资源：模型 API 或自定义总结命令

## 5. 重要文档与链接

- 无明确需要沉淀的重要文档

## 采集概览

{chr(10).join(source_lines)}
"""
    return {
        "report_markdown": markdown,
        "weekly_materials": {
            "core_results": [],
            "projects": [],
            "risks_and_support": [{"description": error, "type": "模型配置"}],
            "ai_assets": [],
            "next_plan": [],
            "important_docs": [],
        },
    }


def main():
    args = parse_args()
    config = load_config(args.config)
    day = resolve_date(args.date, config)
    window = date_window(day, config)
    out_dir = run_dir(config, day, args.run_dir)
    data_path = out_dir / "filtered.json"
    if not data_path.exists():
        raise FileNotFoundError(f"未找到 {data_path}，请先运行 collect_workday.py")
    evidence = json.loads(data_path.read_text(encoding="utf-8"))
    title = report_title(config, window)
    prompt = build_prompt(config, evidence, title)
    (out_dir / "prompt.md").write_text(prompt, encoding="utf-8")

    llm = config.get("llm", {})
    parsed = None
    last_error = "unknown error"
    for attempt in range(2):
        try:
            response = call_command(llm["command"], prompt, out_dir) if llm.get("command") else call_openai_compatible(llm, prompt)
            if not response.strip():
                raise RuntimeError("大模型返回空内容")
            (out_dir / "llm_raw_response.txt").write_text(response, encoding="utf-8")
            parsed = parse_model_output(response)
            write_json(out_dir / "summary_response.json", {"ok": True, "response": response})
            break
        except Exception as exc:
            parsed = None
            last_error = str(exc)
    if parsed is None:
        parsed = fallback_report(title, evidence, last_error)
        write_json(out_dir / "summary_response.json", {"ok": False, "error": last_error})

    report = parsed.get("report_markdown", "").strip()
    if not report.startswith("#"):
        report = f"# {title}\n\n{report}"
    report = remove_project_progress_section(report)
    (out_dir / "report.md").write_text(report + "\n", encoding="utf-8")
    write_json(out_dir / "weekly_materials.json", parsed.get("weekly_materials", {}))
    final_path = report_output_path(config, day)
    final_path.write_text(report + "\n", encoding="utf-8")
    print(final_path)


if __name__ == "__main__":
    main()
