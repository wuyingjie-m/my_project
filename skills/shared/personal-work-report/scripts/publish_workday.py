import argparse
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path

from common import configure_broker_subject, date_window, lark_csv_rows, load_config, report_title, resolve_date, resolve_lark_command, run_dir, run_shell, write_json


def parse_args():
    parser = argparse.ArgumentParser(description="发布个人工作日报详情到飞书文档")
    parser.add_argument("--date", help="目标日期 YYYY-MM-DD，默认昨天")
    parser.add_argument("--config", help="配置文件路径")
    parser.add_argument("--run-dir", help="运行产物目录")
    return parser.parse_args()


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
    data = None
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        data = None
    return {
        "status": "ok" if result.returncode == 0 else "error",
        "returncode": result.returncode,
        "stdout": result.stdout[-8000:],
        "stderr": result.stderr[-8000:],
        "data": data,
    }


def excel_col_name(index: int) -> str:
    name = ""
    while index:
        index, rem = divmod(index - 1, 26)
        name = chr(65 + rem) + name
    return name


def excel_col_index(name: str) -> int:
    value = 0
    for char in name.upper():
        value = value * 26 + ord(char) - 64
    return value


def date_header(day: str) -> str:
    dt = datetime.strptime(day, "%Y-%m-%d")
    return f"{dt.year}年{dt.month}月{dt.day}日"


def sheet_font_size(sheet_conf: dict) -> int:
    return int(sheet_conf.get("font_size", 12))


def sheet_font_size_px(sheet_conf: dict) -> int:
    return math.ceil(sheet_font_size(sheet_conf) * 4 / 3)


def markdown_to_cell_text(markdown: str) -> str:
    def plain_link(match: re.Match) -> str:
        label = match.group(1).strip()
        url = match.group(2).strip()
        return url if label == url else f"{label}：{url}"

    text = markdown.strip()
    text = re.sub(r"^#\s+", "", text, flags=re.M)
    text = re.sub(r"^##\s*(\d+)\.\s*", lambda m: f"{'一二三四五六七八九十'[int(m.group(1)) - 1]}、", text, flags=re.M)
    text = re.sub(r"^##\s+", "", text, flags=re.M)
    text = re.sub(r"^#{1,6}\s*", "", text, flags=re.M)
    text = re.sub(r"\*\*(.*?)\*\*", r"\1", text)
    text = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"\1", text)
    text = re.sub(r"__([^_\n]+)__", r"\1", text)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", plain_link, text)
    text = re.sub(r"^\s*[-*+]\s+", "", text, flags=re.M)
    text = re.sub(r"^\s*\d+[.)]\s+", "", text, flags=re.M)
    text = re.sub(r"^\s*>\s?", "", text, flags=re.M)
    text = re.sub(r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$", "", text, flags=re.M)

    lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            lines.append("")
            continue
        if stripped.startswith("|") and stripped.endswith("|"):
            cells = [cell.strip() for cell in stripped.strip("|").split("|")]
            if any(cells):
                lines.append("；".join(cell for cell in cells if cell))
            continue
        lines.append(stripped)

    compact = "\n".join(lines)
    compact = re.sub(r"\n{3,}", "\n\n", compact)
    return compact.strip() + "\n"


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
    return cleaned.strip() + "\n"


def write_doc_default(doc_url: str, report_text: str) -> dict:
    command = [
        resolve_lark_command().strip("'\""),
        "docs",
        "+update",
        "--as",
        "user",
        "--api-version",
        "v2",
        "--doc",
        doc_url,
        "--command",
        "append",
        "--doc-format",
        "markdown",
        "--content",
        "-",
    ]
    result = subprocess.run(
        command,
        input="\n\n---\n\n" + report_text.strip() + "\n",
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=180,
    )
    return {
        "status": "ok" if result.returncode == 0 else "error",
        "returncode": result.returncode,
        "stdout": result.stdout[-8000:],
        "stderr": result.stderr[-8000:],
        "doc_url": doc_url,
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
    if result["status"] != "ok":
        return result
    data = result.get("data", {}).get("data", {}) if isinstance(result.get("data"), dict) else {}
    if data.get("obj_type") != "sheet":
        return {"status": "error", "message": f"目标不是飞书电子表格: {data.get('obj_type')}", "node": data}
    return {"status": "ok", "spreadsheet_token": data.get("obj_token"), "node": data}


CSV_GET_ARGS = [
    "lark-cli",
    "sheets",
    "+csv-get",
    "--as",
    "user",
    "--include-row-prefix",
    "--json",
]


def sheet_values(spreadsheet_token: str, sheet_id: str, range_a1: str) -> dict:
    command = [
        *CSV_GET_ARGS,
        "--spreadsheet-token",
        spreadsheet_token,
        "--sheet-id",
        sheet_id,
        "--range",
        range_a1,
    ]
    result = run_lark(command, timeout=180)
    # lark-cli inline reads cap at ~500k chars; large sheets come back truncated
    # (has_more=true, e.g. actual_range A1:AZ9 while the region extends to row 23).
    # Silently missing rows once caused a duplicate person row to be inserted.
    # Always re-read via --output-path (cap auto-raises) and fail loudly if cut.
    fd, out_path = tempfile.mkstemp(prefix="sheet-read-", suffix=".json")
    os.close(fd)
    try:
        full = run_lark([*command, "--output-path", out_path], timeout=300)
        if full.get("status") == "ok":
            try:
                payload = json.loads(Path(out_path).read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                payload = None
            if isinstance(payload, dict) and payload.get("annotated_csv"):
                result["data"] = {"ok": True, "data": payload}
    finally:
        try:
            os.unlink(out_path)
        except OSError:
            pass
    payload = (result.get("data") or {}).get("data") or {}
    if payload.get("has_more"):
        raise ValueError(
            f"表格读取被截断（has_more=true, actual_range={payload.get('actual_range')}），"
            "禁止基于不完整数据定位行/写入"
        )
    return result


def find_daily_cell(rows: list[dict], config: dict, day: str, sheet_conf: dict) -> dict:
    header_text = date_header(day)
    header_row_number = int(sheet_conf.get("header_row", 2))
    name_col = sheet_conf.get("name_column", "B")
    department_col = sheet_conf.get("department_column", "A")
    person_name = config.get("person_name", "")
    department = config.get("department", "")

    header_row = next((row for row in rows if row.get("row_number") == header_row_number), None)
    if not header_row:
        raise ValueError(f"未找到表头行: {header_row_number}")
    date_col = ""
    for col, value in header_row.get("values", {}).items():
        if str(value).strip() == header_text:
            date_col = col
            break

    target_row = None
    for row in rows:
        values = row.get("values", {})
        if str(values.get(name_col, "")).strip() == person_name:
            if not department or str(values.get(department_col, "")).strip() == department:
                target_row = row.get("row_number")
                break
    if target_row is None:
        raise ValueError(f"未找到用户行: {department} / {person_name}")

    return {"row": int(target_row), "date_col": date_col, "date_header": header_text}


def insert_date_column(spreadsheet_token: str, sheet_id: str, rows: list[dict], day: str, sheet_conf: dict) -> dict:
    header_text = date_header(day)
    header_row_number = int(sheet_conf.get("header_row", 2))
    first_date_col = sheet_conf.get("first_date_column", "C")
    header_row = next(row for row in rows if row.get("row_number") == header_row_number)
    wanted = datetime.strptime(day, "%Y-%m-%d")

    date_cols = []
    for col, value in header_row.get("values", {}).items():
        match = re.fullmatch(r"(\d{4})年(\d{1,2})月(\d{1,2})日", str(value).strip())
        if match:
            date_value = datetime(int(match.group(1)), int(match.group(2)), int(match.group(3)))
            date_cols.append((col, date_value))

    insert_col = first_date_col
    for col, existing in sorted(date_cols, key=lambda item: excel_col_index(item[0])):
        if wanted > existing:
            insert_col = col
            break
        insert_col = excel_col_name(excel_col_index(col) + 1)

    insert_result = run_lark(
        [
            "lark-cli",
            "sheets",
            "+dim-insert",
            "--as",
            "user",
            "--spreadsheet-token",
            spreadsheet_token,
            "--sheet-id",
            sheet_id,
            "--position",
            insert_col,
            "--count",
            "1",
            "--inherit-style",
            "after",
            "--json",
        ],
        timeout=180,
    )
    if insert_result["status"] != "ok":
        return insert_result

    header_payload = json.dumps([[{"value": header_text}]], ensure_ascii=False)
    set_header = run_lark(
        [
            "lark-cli",
            "sheets",
            "+cells-set",
            "--as",
            "user",
            "--spreadsheet-token",
            spreadsheet_token,
            "--sheet-id",
            sheet_id,
            "--range",
            f"{insert_col}{header_row_number}",
            "--cells",
            "-",
            "--json",
        ],
        stdin=header_payload,
        timeout=180,
    )
    return {"status": set_header["status"], "insert": insert_result, "set_header": set_header, "date_col": insert_col}


def write_daily_sheet(config: dict, day: str, report_text: str) -> dict:
    sheet_conf = config.get("publish", {}).get("daily_sheet", {})
    url = sheet_conf.get("url") or config.get("publish", {}).get("daily_doc", {}).get("url")
    if not url:
        return {"status": "skipped", "note": "未配置 publish.daily_sheet.url"}

    resolved = resolve_spreadsheet_token(url)
    if resolved.get("status") != "ok":
        return {"status": "error", "step": "resolve_spreadsheet", "detail": resolved}
    token = resolved["spreadsheet_token"]

    workbook = run_lark(["lark-cli", "sheets", "+workbook-info", "--as", "user", "--spreadsheet-token", token, "--json"])
    if workbook["status"] != "ok":
        return {"status": "error", "step": "workbook_info", "detail": workbook}
    sheets = workbook.get("data", {}).get("data", {}).get("sheets", [])
    sheet_name = sheet_conf.get("sheet_name", "")
    sheet_id = sheet_conf.get("sheet_id", "")
    if not sheet_id:
        matched = next((s for s in sheets if sheet_name and s.get("sheet_name") == sheet_name), None)
        if not matched and sheets:
            matched = sheets[0]
        sheet_id = matched.get("sheet_id") if matched else ""
    if not sheet_id:
        return {"status": "error", "message": "未找到可写入的工作表", "workbook": workbook}

    read_range = sheet_conf.get("scan_range", "A1:AZ300")
    values = sheet_values(token, sheet_id, read_range)
    if values["status"] != "ok":
        return {"status": "error", "step": "read_sheet", "detail": values}
    rows = lark_csv_rows(values)
    target = find_daily_cell(rows, config, day, sheet_conf)

    insert_result = None
    if not target["date_col"]:
        insert_result = insert_date_column(token, sheet_id, rows, day, sheet_conf)
        if insert_result.get("status") != "ok":
            return {"status": "error", "step": "insert_date_column", "detail": insert_result}
        target["date_col"] = insert_result["date_col"]

    cell = f"{target['date_col']}{target['row']}"
    cell_text = markdown_to_cell_text(report_text)
    font_size = sheet_font_size(sheet_conf)
    font_size_px = sheet_font_size_px(sheet_conf)
    word_wrap = sheet_conf.get("word_wrap", "word-clip")
    row_height = int(sheet_conf.get("row_height", 120))
    payload = json.dumps(
        [
            [
                {
                    "value": cell_text,
                    "cell_styles": {
                        "horizontal_alignment": "left",
                        "vertical_alignment": "top",
                        "word_wrap": word_wrap,
                        "font_size": font_size,
                        "font_weight": "normal",
                        "number_format": "@",
                    },
                }
            ]
        ],
        ensure_ascii=False,
    )
    write_result = run_lark(
        [
            "lark-cli",
            "sheets",
            "+cells-set",
            "--as",
            "user",
            "--spreadsheet-token",
            token,
            "--sheet-id",
            sheet_id,
            "--range",
            cell,
            "--cells",
            "-",
            "--json",
        ],
        stdin=payload,
        timeout=180,
    )
    if write_result["status"] != "ok":
        return {"status": "error", "step": "write_cell", "detail": write_result, "target_cell": cell}

    style_result = run_lark(
        [
            "lark-cli",
            "sheets",
            "+cells-set-style",
            "--as",
            "user",
            "--spreadsheet-token",
            token,
            "--sheet-id",
            sheet_id,
            "--range",
            f"{cell}:{cell}",
            "--horizontal-alignment",
            "left",
            "--vertical-alignment",
            "top",
            "--word-wrap",
            word_wrap,
            "--font-size",
            str(font_size_px),
            "--font-weight",
            "normal",
            "--number-format",
            "@",
            "--json",
        ],
        timeout=180,
    )
    resize_result = run_lark(
        [
            "lark-cli",
            "sheets",
            "+rows-resize",
            "--as",
            "user",
            "--spreadsheet-token",
            token,
            "--sheet-id",
            sheet_id,
            "--range",
            str(target["row"]),
            "--type",
            "pixel",
            "--height",
            str(row_height),
            "--json",
        ],
        timeout=180,
    )
    verify = sheet_values(token, sheet_id, f"{cell}:{cell}")
    return {
        "status": "ok",
        "spreadsheet_token": token,
        "sheet_id": sheet_id,
        "target_cell": cell,
        "date_header": target["date_header"],
        "font_size": font_size,
        "font_size_px": font_size_px,
        "word_wrap": word_wrap,
        "row_height": row_height,
        "insert_date_column": insert_result,
        "write": write_result,
        "style": style_result,
        "row_resize": resize_result,
        "verify": verify,
    }


def main():
    args = parse_args()
    config = load_config(args.config)
    configure_broker_subject(config)
    day = resolve_date(args.date, config)
    window = date_window(day, config)
    out_dir = run_dir(config, day, args.run_dir)
    report_path = out_dir / "report.md"
    if not report_path.exists():
        raise FileNotFoundError(f"未找到 {report_path}，请先运行 summarize_workday.py")
    report_text = remove_project_progress_section(report_path.read_text(encoding="utf-8"))
    publish = config.get("publish", {})
    title = report_title(config, window)
    result = {"date": day, "title": title, "dry_run": publish.get("dry_run", True), "actions": {}}

    if publish.get("dry_run", True):
        preview = out_dir / "publish_preview.md"
        preview.write_text(report_text, encoding="utf-8")
        result["actions"]["write_doc"] = {"status": "dry_run", "preview": str(preview)}
    else:
        if publish.get("daily_sheet", {}).get("enabled"):
            result["actions"]["write_sheet"] = write_daily_sheet(config, day, report_text)
        command = publish.get("commands", {}).get("write_doc", "")
        if command:
            result["actions"]["write_doc"] = run_shell(
                command,
                {"date": day, "title": title, "report_path": str(report_path), "report_text": report_text},
                180,
            )
        elif publish.get("daily_doc", {}).get("enabled") and publish.get("daily_doc", {}).get("url"):
            result["actions"]["write_doc"] = write_doc_default(publish["daily_doc"]["url"], report_text)
        elif not publish.get("daily_sheet", {}).get("enabled"):
            result["actions"]["write_doc"] = {"status": "skipped", "note": "未配置 publish.daily_doc.url 或 publish.commands.write_doc"}

        send = publish.get("commands", {}).get("send_message", "")
        if send:
            result["actions"]["send_message"] = run_shell(
                send,
                {"date": day, "title": title, "report_path": str(report_path), "report_text": report_text},
                180,
            )

    write_json(out_dir / "publish_result.json", result)
    print(out_dir / "publish_result.json")


if __name__ == "__main__":
    main()
