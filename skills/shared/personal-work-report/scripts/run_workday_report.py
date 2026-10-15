import argparse
import os
import re
import subprocess
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent


def bootstrap_openclaw_agent_env():
    """Preserve the per-subagent lark-cli route before child scripts run."""
    if os.environ.get("OPENCLAW_AGENT_DIR"):
        return
    match = re.match(r"^(/data/agent/openclaw_[^/]+/\.openclaw)/workspaces/([^/]+)", os.getcwd())
    if not match:
        return
    openclaw_root, agent_id = match.groups()
    os.environ["OPENCLAW_AGENT_ID"] = agent_id
    os.environ["OPENCLAW_AGENT_DIR"] = str(Path(openclaw_root) / "agents" / agent_id)


def parse_args():
    parser = argparse.ArgumentParser(description="一键执行个人工作日报详情采集、总结和发布")
    parser.add_argument("--date", help="目标日期 YYYY-MM-DD，默认昨天")
    parser.add_argument("--config", help="配置文件路径")
    parser.add_argument("--run-dir", help="运行产物目录")
    parser.add_argument("--skip-publish", action="store_true", help="只生成本地文件，不发布到飞书")
    parser.add_argument("--subject", required=True, help="日报对应的身份 subject")
    return parser.parse_args()


def run(script: str, args):
    command = [sys.executable, str(SCRIPT_DIR / script)]
    if args.date:
        command += ["--date", args.date]
    if args.config:
        command += ["--config", args.config]
    if args.run_dir:
        command += ["--run-dir", args.run_dir]
    subprocess.run(command, check=True)


def main():
    args = parse_args()
    os.environ["LARK_BROKER_SUBJECT"] = args.subject
    run("collect_workday.py", args)
    run("summarize_workday.py", args)
    if not args.skip_publish:
        run("publish_workday.py", args)


if __name__ == "__main__":
    main()
