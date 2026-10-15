#!/usr/bin/env python3
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path("/data/agent/openclaw_sxs/.openclaw")
CONFIG = ROOT / "lark-broker" / "users.json"
AUDIT = ROOT / "lark-broker" / "audit.jsonl"
ALLOWED = {"calendar", "minutes", "vc", "docs", "im", "wiki", "sheets"}


def error(message, code=2):
    print(json.dumps({"status": "error", "message": message}, ensure_ascii=False), file=sys.stderr)
    return code


def main():
    args = sys.argv[1:]
    subject = os.environ.get("LARK_BROKER_SUBJECT", "")
    if args[:1] == ["--subject"]:
        if len(args) < 3:
            return error("usage: lark-broker [--subject SUBJECT] <lark-cli args>")
        subject, args = args[1], args[2:]
    if not subject:
        return error("missing LARK_BROKER_SUBJECT or --subject")
    if not args:
        return error("missing lark-cli command")

    users = json.loads(CONFIG.read_text(encoding="utf-8")).get("users", {})
    user = users.get(subject)
    if not user:
        return error(f"unauthorized subject: {subject}")
    if args[0] not in ALLOWED:
        return error(f"disallowed lark-cli command family: {args[0]}")

    home = Path(user["home"]).resolve()
    agent_dir = Path(user["agent_dir"]).resolve()
    if ROOT.resolve() not in home.parents or ROOT.resolve() not in agent_dir.parents:
        return error("subject path is outside openclaw_sxs")
    cli = agent_dir / "lark-cli"
    if not cli.is_file() or not os.access(cli, os.X_OK):
        return error(f"lark-cli is not executable: {cli}")

    env = os.environ.copy()
    env.update({
        "HOME": str(home),
        "USERPROFILE": str(home),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_CACHE_HOME": str(home / ".cache"),
        "XDG_DATA_HOME": str(home / ".local" / "share"),
        "OPENCLAW_AGENT_ID": subject,
        "OPENCLAW_AGENT_DIR": str(agent_dir),
    })
    (home / ".config").mkdir(parents=True, exist_ok=True)
    (home / ".cache").mkdir(parents=True, exist_ok=True)
    record = {
        "time": datetime.now(timezone.utc).isoformat(),
        "subject": subject,
        "operation": " ".join(args[:2]),
    }
    with AUDIT.open("a", encoding="utf-8") as handle:
        record["status"] = "started"
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    try:
        result = subprocess.run(
            [str(cli), *args],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            timeout=300,
        )
    except subprocess.TimeoutExpired:
        return error("lark-cli timed out", 124)
    record["status"] = "ok" if result.returncode == 0 else "error"
    with AUDIT.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
