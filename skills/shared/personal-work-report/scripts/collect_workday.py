import argparse
import json
import re
import shutil
import subprocess
from datetime import datetime
from pathlib import Path

from common import compact_text, configure_broker_subject, date_window, lark_csv_rows, load_config, parse_jsonish, parse_time_to_date, resolve_date, resolve_lark_command, run_dir, run_shell, write_json


def parse_args():
    parser = argparse.ArgumentParser(description="采集前一日飞书与 AI 日报工作证据")
    parser.add_argument("--date", help="目标日期 YYYY-MM-DD，默认昨天")
    parser.add_argument("--config", help="配置文件路径")
    parser.add_argument("--run-dir", help="运行产物目录")
    return parser.parse_args()


def item_text(item) -> str:
    fields = [
        "title", "summary", "content", "text", "message", "name", "doc_title",
        "url", "doc_url", "sender", "chat_name", "description"
    ]
    values = [compact_text(item.get(field), 800) for field in fields if isinstance(item, dict) and item.get(field)]
    return " | ".join(values) or compact_text(item, 1200)


def is_ack(text: str, config: dict) -> bool:
    ack = set(config.get("collection", {}).get("noise_ack_words", []))
    return text.strip() in ack


def hit_keywords(text: str, keywords: list[str]) -> bool:
    lower = text.lower()
    return any(keyword.lower() in lower for keyword in keywords)


def mentioned_me(item: dict, config: dict) -> bool:
    person_id = config.get("person_open_id", "")
    names = [config.get("person_name", "")] + list(config.get("person_aliases", []))
    text = item_text(item)
    mentions = compact_text(item.get("mentions", ""), 2000)
    return bool((person_id and person_id in mentions) or any(name and name in (text + mentions) for name in names))


def sent_by_me(item: dict, config: dict) -> bool:
    person_ids = [config.get("person_open_id", "")] + list(config.get("person_open_ids", []))
    names = [config.get("person_name", "")] + list(config.get("person_aliases", []))
    sender = compact_text(item.get("sender") or item.get("sender_id") or item.get("open_id"), 800)
    return bool(any(person_id and person_id in sender for person_id in person_ids) or any(name and name in sender for name in names))


def is_blacklisted_chat(chat: dict, config: dict) -> bool:
    if isinstance(chat, str):
        chat = {"chat_id": chat}
    blacklist = config.get("blacklist", {})
    chat_name = str(chat.get("chat_name") or chat.get("name") or chat.get("title") or "")
    chat_id = str(chat.get("chat_id") or chat.get("id") or "")
    return chat_id in set(blacklist.get("chat_ids", [])) or any(name and name in chat_name for name in blacklist.get("chat_names", []))


def chat_kind(chat: dict) -> str:
    if isinstance(chat, str):
        chat = {"chat_id": chat}
    value = str(
        chat.get("chat_type")
        or chat.get("type")
        or chat.get("chat_mode")
        or chat.get("mode")
        or ""
    ).lower()
    if any(token in value for token in ("p2p", "private", "single", "user")):
        return "p2p"
    if any(token in value for token in ("group", "oc_")):
        return "group"
    chat_id = str(chat.get("chat_id") or chat.get("id") or "")
    if chat_id.startswith("oc_"):
        return "group"
    return "group"


def filter_docs(items: list[dict], day: str, config: dict) -> list[dict]:
    blocked = config.get("blacklist", {}).get("doc_title_keywords", [])
    kept = []
    for item in items:
        text = item_text(item)
        if any(word and word in text for word in blocked):
            continue
        date_candidates = [
            item.get("edit_time"), item.get("edited_time"), item.get("update_time"),
            item.get("created_time"), item.get("create_time"), item.get("time")
        ]
        dates = [parse_time_to_date(value, config) for value in date_candidates]
        if any(value == day for value in dates if value) or not any(dates):
            kept.append({"type": "doc", "text": text, "raw": item})
    return kept


def filter_im(items: list[dict], chat: dict, config: dict) -> list[dict]:
    if isinstance(chat, str):
        chat = {"chat_id": chat}
    kept = []
    kind = chat_kind(chat)
    chat_name = chat.get("chat_name") or chat.get("name")
    chat_id = chat.get("chat_id") or chat.get("id")
    normalized = []
    for index, item in enumerate(items):
        text = item_text(item)
        if not text:
            continue
        anchor = sent_by_me(item, config) or mentioned_me(item, config)
        if is_ack(text, config) and not anchor:
            continue
        normalized.append((index, item, text))

    if kind == "p2p":
        for _, item, text in normalized:
            kept.append({
                "type": "im_private",
                "chat_kind": kind,
                "chat_name": chat_name,
                "chat_id": chat_id,
                "relation_to_me": "private_chat_context",
                "text": text,
                "raw": item,
            })
        return kept

    before = int(config.get("collection", {}).get("im_group_context_before", 2))
    after = int(config.get("collection", {}).get("im_group_context_after", 2))
    anchor_positions = []
    for pos, (_, item, _) in enumerate(normalized):
        if sent_by_me(item, config) or mentioned_me(item, config):
            anchor_positions.append(pos)

    selected = {}
    for anchor_pos in anchor_positions:
        for pos in range(max(0, anchor_pos - before), min(len(normalized), anchor_pos + after + 1)):
            selected[pos] = anchor_pos

    for pos in sorted(selected):
        _, item, text = normalized[pos]
        anchor_pos = selected[pos]
        if sent_by_me(item, config):
            relation = "sent_by_me"
        elif mentioned_me(item, config):
            relation = "mentioned_me"
        elif pos < anchor_pos:
            relation = "group_context_before_anchor"
        else:
            relation = "group_context_after_anchor"
        kept.append({
            "type": "im_group_context",
            "chat_kind": kind,
            "chat_name": chat_name,
            "chat_id": chat_id,
            "relation_to_me": relation,
            "text": text,
            "raw": item,
        })
    return kept


def extract_minute_tokens(items: list[dict]) -> str:
    tokens = []
    for item in items:
        blob = json.dumps(item, ensure_ascii=False)
        for key in ("minute_token", "token"):
            value = item.get(key) if isinstance(item, dict) else None
            if value and value not in tokens:
                tokens.append(str(value))
        for match in re.findall(r"minute_token=([A-Za-z0-9_-]+)|/minutes/([A-Za-z0-9_-]+)", blob):
            token = next((part for part in match if part), "")
            if token and token not in tokens:
                tokens.append(token)
    return ",".join(tokens)


def extract_h2_for_date(markdown: str, day: str) -> str:
    date_patterns = [day, day.replace("-", "."), day[5:].replace("-", "."), day[5:].replace("-", "月") + "日"]
    lines = markdown.splitlines()
    sections = []
    current = []
    keep = False
    for line in lines:
        if line.startswith("## "):
            if keep and current:
                sections.append("\n".join(current).strip())
            current = [line]
            keep = any(pattern in line for pattern in date_patterns)
        elif keep:
            current.append(line)
    if keep and current:
        sections.append("\n".join(current).strip())
    return "\n\n".join(sections)


def collect_source(name: str, command: str, values: dict, config: dict) -> dict:
    timeout = int(config.get("collection", {}).get("timeout_seconds", 180))
    result = run_shell(command, values, timeout)
    return {"source": name, **result}


def run_lark(command: list[str], stdin: str | None = None, timeout: int = 180) -> dict:
    if command and command[0] == "lark-cli":
        command = [resolve_lark_command().strip("'\""), *command[1:]]
    result = subprocess.run(
        command,
        input=stdin,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    data = parse_jsonish(result.stdout)
    return {
        "status": "ok" if result.returncode == 0 else "error",
        "returncode": result.returncode,
        "command": command,
        "stdout": result.stdout[-8000:],
        "stderr": result.stderr[-8000:],
        "data": data,
    }


def resolve_spreadsheet_token(url_or_token: str) -> dict:
    if "/wiki/" not in url_or_token:
        return {"status": "ok", "spreadsheet_token": url_or_token, "node": None}
    result = run_lark(
        [
            "lark-cli",
            "wiki",
            "+node-get",
            "--as",
            "user",
            "--node-token",
            url_or_token,
            "--json",
        ]
    )
    data = result.get("data", {}).get("data", {}) if isinstance(result.get("data"), dict) else {}
    if result["status"] != "ok":
        return result
    if data.get("obj_type") != "sheet":
        return {"status": "error", "message": f"目标不是飞书电子表格: {data.get('obj_type')}", "node": data}
    return {"status": "ok", "spreadsheet_token": data.get("obj_token"), "node": data}


def sheet_values(spreadsheet_token: str, sheet_id: str, range_a1: str) -> dict:
    return run_lark(
        [
            "lark-cli",
            "sheets",
            "+csv-get",
            "--as",
            "user",
            "--spreadsheet-token",
            spreadsheet_token,
            "--sheet-id",
            sheet_id,
            "--range",
            range_a1,
            "--include-row-prefix",
            "--json",
        ],
        timeout=180,
    )


def value_at(row: dict, col: str) -> str:
    return str(row.get("values", {}).get(col, "")).strip()


def header_matches_day(value: str, day: str) -> bool:
    target = datetime.strptime(day, "%Y-%m-%d")
    text = str(value).strip()
    match = re.search(r"(\d{4})\D+(\d{1,2})\D+(\d{1,2})", text)
    if match:
        return (int(match.group(1)), int(match.group(2)), int(match.group(3))) == (target.year, target.month, target.day)
    return text == day


def collect_ai_usage_sheet(day: str, config: dict) -> tuple[dict, dict]:
    settings = config.get("feishu", {}).get("ai_usage_sheet", {})
    if not settings.get("enabled", False):
        return {"source": "ai_usage_sheet", "status": "skipped", "items": []}, {"source": "ai_usage_sheet", "items": []}

    url = settings.get("url", "")
    if not url:
        return {"source": "ai_usage_sheet", "status": "skipped", "reason": "未配置 feishu.ai_usage_sheet.url", "items": []}, {"source": "ai_usage_sheet", "items": []}

    resolved = resolve_spreadsheet_token(url)
    if resolved.get("status") != "ok":
        return {"source": "ai_usage_sheet", **resolved, "items": []}, {"source": "ai_usage_sheet", "items": []}
    token = resolved["spreadsheet_token"]

    workbook = run_lark(["lark-cli", "sheets", "+workbook-info", "--as", "user", "--spreadsheet-token", token, "--json"])
    if workbook.get("status") != "ok":
        return {"source": "ai_usage_sheet", "status": "error", "step": "workbook_info", "detail": workbook, "items": []}, {"source": "ai_usage_sheet", "items": []}
    sheets = workbook.get("data", {}).get("data", {}).get("sheets", []) if isinstance(workbook.get("data"), dict) else []
    sheet_id = settings.get("sheet_id", "")
    sheet_name = settings.get("sheet_name", "")
    if not sheet_id:
        matched = next((s for s in sheets if sheet_name and s.get("sheet_name") == sheet_name), None)
        if not matched and sheets:
            matched = sheets[0]
        sheet_id = matched.get("sheet_id") if matched else ""
    if not sheet_id:
        return {"source": "ai_usage_sheet", "status": "error", "message": "未找到 AI 使用记录工作表", "workbook": workbook, "items": []}, {"source": "ai_usage_sheet", "items": []}

    values = sheet_values(token, sheet_id, settings.get("scan_range", "A1:AZ300"))
    if values.get("status") != "ok":
        return {"source": "ai_usage_sheet", "status": "error", "step": "read_sheet", "detail": values, "items": []}, {"source": "ai_usage_sheet", "items": []}
    rows = lark_csv_rows(values)

    header_row_number = int(settings.get("header_row", 2))
    header_row = next((row for row in rows if row.get("row_number") == header_row_number), None)
    if not header_row:
        return {"source": "ai_usage_sheet", "status": "error", "message": f"未找到表头行: {header_row_number}", "items": []}, {"source": "ai_usage_sheet", "items": []}

    date_col = next((col for col, value in header_row.get("values", {}).items() if header_matches_day(value, day)), "")
    if not date_col:
        return {"source": "ai_usage_sheet", "status": "ok", "reason": f"未找到日期列: {day}", "items": []}, {"source": "ai_usage_sheet", "items": []}

    department = config.get("department", "")
    person_name = config.get("person_name", "")
    department_col = settings.get("department_column", "A")
    name_col = settings.get("name_column", "B")
    target_row = next(
        (
            row for row in rows
            if value_at(row, name_col) == person_name and (not department or value_at(row, department_col) == department)
        ),
        None,
    )
    if not target_row:
        return {"source": "ai_usage_sheet", "status": "ok", "reason": f"未找到用户行: {department} / {person_name}", "items": []}, {"source": "ai_usage_sheet", "items": []}

    text = value_at(target_row, date_col)
    raw_item = {
        "type": "ai_usage_sheet",
        "department": department,
        "person_name": person_name,
        "date": day,
        "sheet_id": sheet_id,
        "cell": f"{date_col}{target_row.get('row_number')}",
        "text": text,
    }
    items = [raw_item] if text else []
    raw = {"source": "ai_usage_sheet", "status": "ok", "spreadsheet_token": token, "sheet_id": sheet_id, "items": items}
    evidence = {"source": "ai_usage_sheet", "items": items}
    return raw, evidence


def pagination_info(stdout: str) -> tuple[bool, str]:
    parsed = parse_jsonish(stdout)
    if not isinstance(parsed, dict):
        return False, ""
    data = parsed.get("data") if isinstance(parsed.get("data"), dict) else parsed
    return bool(data.get("has_more")), str(data.get("page_token") or "")


def collect_paged_source(name: str, command: str, values: dict, config: dict, max_pages_key: str) -> tuple[list[dict], list[dict]]:
    timeout = int(config.get("collection", {}).get("timeout_seconds", 180))
    max_pages = int(config.get("collection", {}).get(max_pages_key, 10))
    sources = []
    items = []
    page_token = ""
    for page in range(max_pages):
        page_values = {**values, "page_token": page_token}
        page_command = command
        if page_token and "--page-token" not in page_command:
            page_command = page_command.rstrip() + " --page-token {page_token}"
        src = {"source": f"{name}:page{page + 1}", **run_shell(page_command, page_values, timeout)}
        sources.append(src)
        items.extend(src.get("items", []))
        has_more = bool(src.get("has_more"))
        next_token = str(src.get("page_token") or "")
        if src.get("status") != "ok" or not has_more or not next_token:
            break
        page_token = next_token
    return sources, items


def redact_text(text: str, patterns: list[str]) -> str:
    redacted = text
    for pattern in patterns:
        redacted = re.sub(pattern, "[REDACTED]", redacted)
    return redacted


def file_matches_day(path: Path, day: str, config: dict) -> bool:
    try:
        if parse_time_to_date(path.stat().st_mtime, config) == day:
            return True
        sample = path.read_text(encoding="utf-8", errors="ignore")[:200000]
    except OSError:
        return False
    if day in sample:
        return True
    for line in sample.splitlines():
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(obj, dict):
            continue
        for key in ("timestamp", "created_at", "updated_at", "time", "date"):
            if parse_time_to_date(obj.get(key), config) == day:
                return True
    return False


def collect_local_ai_usage(day: str, config: dict) -> tuple[dict, dict]:
    settings = config.get("local_sources", {}).get("local_ai_usage", {})
    if not settings.get("enabled", False):
        return {"source": "local_ai_usage", "status": "skipped", "items": []}, {"source": "local_ai_usage", "items": []}

    max_files = int(settings.get("max_files", 80))
    max_chars = int(settings.get("max_chars_per_file", 6000))
    patterns = settings.get("redact_patterns", [])
    raw_items = []
    evidence_items = []

    for source_id, source in settings.get("sources", {}).items():
        if not source.get("enabled", False):
            continue
        display_name = source.get("display_name", source_id)
        for base in source.get("paths", []):
            base_path = Path(base).expanduser()
            if not base_path.exists():
                raw_items.append({"source": source_id, "path": str(base_path), "status": "missing"})
                continue
            files = []
            for glob_pattern in source.get("file_globs", ["**/*.jsonl", "**/*.json", "**/*.md", "**/*.txt"]):
                files.extend(path for path in base_path.glob(glob_pattern) if path.is_file())
            files = sorted(set(files), key=lambda p: p.stat().st_mtime, reverse=True)
            for path in files:
                if len(evidence_items) >= max_files:
                    break
                if not file_matches_day(path, day, config):
                    continue
                text = path.read_text(encoding="utf-8", errors="ignore")
                text = redact_text(text[-max_chars:], patterns)
                raw_items.append({
                    "source": source_id,
                    "display_name": display_name,
                    "path": str(path),
                    "modified_at": datetime.fromtimestamp(path.stat().st_mtime).isoformat(),
                    "chars": len(text),
                })
                evidence_items.append({
                    "type": "local_ai_usage",
                    "tool": display_name,
                    "path": str(path),
                    "text": text,
                })

    raw = {"source": "local_ai_usage", "status": "ok", "items": raw_items}
    evidence = {"source": "local_ai_usage", "items": evidence_items}
    return raw, evidence


def main():
    args = parse_args()
    config = load_config(args.config)
    configure_broker_subject(config)
    day = resolve_date(args.date, config)
    window = date_window(day, config)
    out_dir = run_dir(config, day, args.run_dir)
    max_items = int(config.get("collection", {}).get("max_items_per_source", 200))
    feishu = config.get("feishu", {})
    values = {**window, "page_size": config.get("collection", {}).get("im_context_page_size", 50)}

    raw = {"date": day, "sources": []}
    evidence = {
        "date": day,
        "department": config.get("department", ""),
        "person_name": config.get("person_name", ""),
        "person_open_id": config.get("person_open_id", ""),
        "sources": [],
    }

    calendar = feishu.get("calendar_events", {})
    if calendar.get("enabled"):
        src = collect_source("calendar_events", calendar.get("command", ""), values, config)
        raw["sources"].append(src)
        evidence["sources"].append({
            "source": "calendar_events",
            "items": [{"type": "calendar", "text": item_text(item), "raw": item} for item in src.get("items", [])[:max_items]],
        })

    minutes = feishu.get("minutes", {})
    if minutes.get("enabled"):
        search = collect_source("minutes_search", minutes.get("search_command", ""), values, config)
        raw["sources"].append(search)
        minute_items = search.get("items", [])[:max_items]
        token_values = {**values, "minute_tokens": extract_minute_tokens(minute_items)}
        notes = collect_source("minutes_notes", minutes.get("notes_command", ""), token_values, config) if token_values["minute_tokens"] else {"source": "minutes_notes", "status": "skipped", "items": []}
        raw["sources"].append(notes)
        combined = minute_items + notes.get("items", [])
        evidence["sources"].append({
            "source": "minutes",
            "items": [{"type": "minutes", "text": item_text(item), "raw": item} for item in combined[:max_items]],
        })

    docs = feishu.get("docs", {})
    if docs.get("enabled"):
        src = collect_source("docs", docs.get("command", ""), values, config)
        raw["sources"].append(src)
        evidence["sources"].append({"source": "docs", "items": filter_docs(src.get("items", [])[:max_items], day, config)})

    im = feishu.get("im_messages", {})
    if im.get("enabled"):
        chats = list(im.get("configured_chats", []))
        if im.get("read_all_chats", True) and im.get("chat_list_command"):
            chat_sources, chat_items = collect_paged_source("im_chat_list", im.get("chat_list_command", ""), values, config, "im_chat_list_max_pages")
            raw["sources"].extend(chat_sources)
            chats.extend(chat_items)
        seen = set()
        im_items = []
        for chat in chats:
            if isinstance(chat, str):
                chat = {"chat_id": chat}
            if is_blacklisted_chat(chat, config):
                continue
            chat_id = chat.get("chat_id") or chat.get("id")
            if not chat_id or chat_id in seen:
                continue
            if not str(chat_id).startswith("oc_"):
                raw["sources"].append({
                    "source": f"im_messages:{chat_id}",
                    "status": "skipped",
                    "reason": "lark-cli im +chat-messages-list requires chat_id starting with oc_",
                    "items": [],
                })
                continue
            seen.add(chat_id)
            msg_values = {**values, "chat_id": chat_id}
            msg_sources, msg_items = collect_paged_source(f"im_messages:{chat_id}", im.get("message_command", ""), msg_values, config, "im_message_max_pages")
            raw["sources"].extend(msg_sources)
            im_items.extend(filter_im(msg_items[:max_items], chat, config))
        evidence["sources"].append({"source": "im_messages", "items": im_items[:max_items]})

    ai_raw, ai_evidence = collect_ai_usage_sheet(day, config)
    raw["sources"].append(ai_raw)
    evidence["sources"].append(ai_evidence)

    for source in evidence["sources"]:
        source["kept_count"] = len(source.get("items", []))

    write_json(out_dir / "raw.json", raw)
    write_json(out_dir / "filtered.json", evidence)
    print(out_dir / "filtered.json")


if __name__ == "__main__":
    main()
