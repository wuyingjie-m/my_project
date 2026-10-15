import json
import os
import re
import subprocess
import shutil
import csv
import io
import shlex
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = ROOT / "config.json"
EXAMPLE_CONFIG = ROOT / "config.example.json"
BROKER = Path("/data/agent/openclaw_sxs/.openclaw/lark-broker/bin/lark-broker")


def load_config(path: str | None = None) -> dict:
    config_path = Path(path) if path else DEFAULT_CONFIG
    if not config_path.exists():
        config_path = EXAMPLE_CONFIG
    return json.loads(config_path.read_text(encoding="utf-8"))


def configure_broker_subject(config: dict) -> None:
    subject = str(config.get("subject") or os.environ.get("LARK_BROKER_SUBJECT") or "").strip()
    if subject:
        os.environ["LARK_BROKER_SUBJECT"] = subject


def resolve_lark_command() -> str:
    if os.environ.get("LARK_BROKER_SUBJECT"):
        return shlex.quote(str(BROKER))
    return shlex.quote(shutil.which("lark-cli") or "lark-cli")


def resolve_date(value: str | None, config: dict) -> str:
    if value:
        datetime.strptime(value, "%Y-%m-%d")
        return value
    tz = ZoneInfo(config.get("timezone", "Asia/Shanghai"))
    today = datetime.now(tz).date()
    if config.get("default_date_mode", "yesterday") == "today":
        return today.isoformat()
    # 默认取上一工作日（周一回落到周五），配合仅工作日运行的 cron，周末不产出也不丢数据
    day = today - timedelta(days=1)
    while day.weekday() >= 5:
        day -= timedelta(days=1)
    return day.isoformat()


def date_window(day: str, config: dict) -> dict:
    tz = ZoneInfo(config.get("timezone", "Asia/Shanghai"))
    start = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=tz)
    end = start.replace(hour=23, minute=59, second=59)
    return {
        "date": day,
        "start_iso": start.isoformat(),
        "end_iso": end.isoformat(),
        "start_epoch": str(int(start.timestamp())),
        "end_epoch": str(int(end.timestamp())),
        "date_cn": f"{start.year}年{start.month:02d}月{start.day:02d}日",
    }


def run_dir(config: dict, day: str, explicit: str | None = None) -> Path:
    if explicit:
        path = Path(explicit)
    else:
        runs_root = (
            os.environ.get("PERSONAL_WORK_REPORT_RUN_ROOT")
            or config.get("runs_dir")
            or openclaw_workspace_runs_root("personal-work-report")
            or ROOT / "runs"
        )
        path = Path(runs_root) / day
    if not path.is_absolute():
        path = ROOT / path
    path.mkdir(parents=True, exist_ok=True)
    return path


def openclaw_workspace_runs_root(skill_name: str) -> Path | None:
    match = re.match(r"^(/data/agent/openclaw_[^/]+/\.openclaw/workspaces/[^/]+)", os.getcwd())
    if not match:
        return None
    return Path(match.group(1)) / "run" / skill_name


def report_output_path(config: dict, day: str) -> Path:
    configured = config.get("report_output_dir")
    if configured:
        out = Path(configured)
    else:
        out = (
            os.environ.get("PERSONAL_WORK_REPORT_RUN_ROOT")
            or openclaw_workspace_runs_root("personal-work-report")
            or ROOT / "reports"
        )
        out = Path(out)
    if not out.is_absolute():
        out = ROOT / out
    out.mkdir(parents=True, exist_ok=True)
    return out / f"{day}-工作日报.md"


def report_title(config: dict, window: dict) -> str:
    return f"{config.get('department', '')}{config.get('person_name', '')}工作日报 {window['date_cn']}"


def render_command(command: str, values: dict) -> str:
    return command.format(**{k: "" if v is None else v for k, v in values.items()})


def run_shell(command: str, values: dict, timeout: int) -> dict:
    if not command.strip():
        return {"status": "skipped", "command": command, "items": []}
    rendered = render_command(command, values)
    rendered = re.sub(r"(^|\s)lark-cli(?=\s|$)", lambda m: m.group(1) + resolve_lark_command(), rendered, count=1)
    result = subprocess.run(
        rendered,
        shell=True,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    parsed = parse_jsonish(result.stdout)
    has_more, page_token = page_info(parsed)
    return {
        "status": "ok" if result.returncode == 0 else "error",
        "returncode": result.returncode,
        "command": rendered,
        "stdout": result.stdout[-8000:],
        "stderr": result.stderr[-8000:],
        "items": normalize_items(parsed),
        "has_more": has_more,
        "page_token": page_token,
    }


def parse_jsonish(text: str):
    if not text.strip():
        return []
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"(\{.*\}|\[.*\])", text, flags=re.S)
        if match:
            try:
                return json.loads(match.group(1))
            except json.JSONDecodeError:
                pass
    return [{"text": text.strip()}]


def normalize_items(value):
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        for key in ("items", "chats", "records", "events", "messages", "results"):
            inner = value.get(key)
            if isinstance(inner, list):
                return inner
            if isinstance(inner, dict):
                nested = normalize_items(inner)
                if nested or any(name in inner for name in ("items", "chats", "records", "events", "messages", "results")):
                    return nested
        if isinstance(value.get("data"), dict):
            return normalize_items(value["data"])
        if isinstance(value.get("data"), list):
            return value["data"]
        return [value]
    return []


def page_info(value) -> tuple[bool, str]:
    if not isinstance(value, dict):
        return False, ""
    data = value.get("data") if isinstance(value.get("data"), dict) else value
    return bool(data.get("has_more")), str(data.get("page_token") or "")


def compact_text(value, limit: int = 2000) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        text = value
    else:
        text = json.dumps(value, ensure_ascii=False)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def parse_time_to_date(value, config: dict) -> str | None:
    if value in (None, ""):
        return None
    tz = ZoneInfo(config.get("timezone", "Asia/Shanghai"))
    if isinstance(value, (int, float)):
        seconds = value / 1000 if value > 10_000_000_000 else value
        return datetime.fromtimestamp(seconds, tz).date().isoformat()
    text = str(value)
    if re.fullmatch(r"\d{10,13}", text):
        seconds = int(text) / 1000 if len(text) == 13 else int(text)
        return datetime.fromtimestamp(seconds, tz).date().isoformat()
    match = re.search(r"\d{4}-\d{2}-\d{2}", text)
    if match:
        return match.group(0)
    return None


def write_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def lark_csv_rows(csv_get_result: dict) -> list[dict]:
    data = csv_get_result.get("data", {}) if isinstance(csv_get_result, dict) else {}
    inner = data.get("data", data) if isinstance(data, dict) else {}
    if isinstance(inner, dict) and isinstance(inner.get("rows"), list):
        return inner["rows"]
    annotated = inner.get("annotated_csv", "") if isinstance(inner, dict) else ""
    col_indices = inner.get("col_indices", []) if isinstance(inner, dict) else []
    if not annotated or not col_indices:
        return []
    matches = list(re.finditer(r"(?m)^\[row=(\d+)\]\s*", annotated))
    rows = []
    for idx, match in enumerate(matches):
        start = match.end()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(annotated)
        csv_text = annotated[start:end].rstrip("\r\n")
        if not csv_text:
            values = []
        else:
            values = next(csv.reader(io.StringIO(csv_text)), [])
        rows.append(
            {
                "row_number": int(match.group(1)),
                "values": {col: values[pos] if pos < len(values) else "" for pos, col in enumerate(col_indices)},
            }
        )
    return rows
