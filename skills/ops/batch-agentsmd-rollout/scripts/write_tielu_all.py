#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把统一规则批量写入多个 OpenClaw 实例的子 agent AGENTS.md（跳过 main，幂等）。

用法：python3 write_tielu_all.py <实例名...>     # 例：openclaw_GTM openclaw_PJT
     实例根 = /data/agent/<实例名>；必须显式传实例名，防止误伤全服。

规则模板 RULE 的源头是 wyj 实例 AGENTS.md 顶部的「第零铁律」：规则文本变化时，
先更新 AGENTS.md，再同步本文件的 RULE（幂等标记自动取 RULE 首行，无需改代码）。

占位符：__INSTANCE__（实例根）/ __AGENT_ID__（agents/ 目录名）/
        __WS_ID__（workspaces/ 实际目录名，可能与 agent id 大小写不同）。
"""
import os
import stat
import sys

BASE = "/data/agent"

RULE = """## 🚨 第零铁律：身份与认证隔离（优先级最高，高于本文件其它一切条款）

**一切需要认证 / 身份信息的操作，都必须把认证信息落到「本 agent 的专属目录」，绝不允许落到实例级共享位置或任何他人 / 其它 agent 的目录。**

适用范围（不限于此）：`lark-cli`（飞书认证 / token）、**aba（datamarket / ahs）**、**datadev（数开）**、**watcher**，以及任何会写 token / cookie / credential / config / 身份缓存的 CLI、脚本、SDK。

**为什么是最高优先级**：一旦授权写错位置、串了别人的身份，**任务会当场失败**——不是样式问题、不是效率问题，是跑不通、结果全废、还可能污染别人的身份。2026-09-16 已真实发生：本实例子 agent 裸跑 `lark-cli`，把用户的 token 写进了实例共享槽位。

### 本 agent 的专属槽位 vs 禁止位置

| 类型 | 路径 |
| --- | --- |
| ✅ 本 agent 凭据根（工作区） | `__INSTANCE__/.openclaw/workspaces/__WS_ID__/` |
| ✅ 本 agent 的 CLI HOME 槽位（lark-cli 等） | `__INSTANCE__/.openclaw/agents/__AGENT_ID__/home/` |
| ✅ 本 agent 的包装脚本 | `__INSTANCE__/.openclaw/agents/__AGENT_ID__/lark-cli` |
| ❌ 实例级共享槽位 | `__INSTANCE__/.lark-cli` |
| ❌ 同实例 main 的目录 | `__INSTANCE__/.openclaw/workspace/main/`、`agents/main/` |
| ❌ 同实例兄弟 agent 的目录 | `__INSTANCE__/.openclaw/workspaces/<其它agent>/`、`agents/<其它agent>/` |
| ❌ 其它实例的任何目录 | `/data/agent/openclaw_<其它实例>/…` |

### 逐工具对照表

| 工具 | 本 agent 的专属位置 | 严禁使用 |
| --- | --- | --- |
| lark-cli（飞书） | `agents/__AGENT_ID__/home/.lark-cli`（+ `agents/__AGENT_ID__/home/.local/share/lark-cli`） | ❌ `__INSTANCE__/.lark-cli`（实例共享槽位）<br>❌ 同实例 main / 兄弟 agent 的 `.lark-cli` |
| aba（datamarket / ahs） | `workspaces/__WS_ID__/creds/`（或该工具约定的子目录） | ❌ main 的 `workspace/main/…`；❌ 他人工作区 cookie 罐 |
| datadev（数开） | `workspaces/__WS_ID__/` 下自建 | ❌ main 的 `workspace/main/datadev-export/creds/`；❌ 其它实例凭据 |
| watcher | `workspaces/__WS_ID__/` 下自建 | ❌ 任何共享 / 他人目录 |
| 其它任何写 token / cookie / credential / config 的 CLI、脚本、SDK | 同上 | ❌ 实例级共享位置、他人 / 其它 agent 的目录 |

### 执行要求（每一次都要做）

1. **先锁身份，再执行**：跑认证类命令前，先确保 `HOME` / `XDG_CONFIG_HOME` / `XDG_CACHE_HOME` / `--config` / `--home` 一律指向本 agent 的专属目录。
2. **永不裸跑凭据类 CLI**：例如 lark-cli 三选一 —— ① `export HOME=__INSTANCE__/.openclaw/agents/__AGENT_ID__/home`；② 直接调包装脚本 `__INSTANCE__/.openclaw/agents/__AGENT_ID__/lark-cli`；③ 显式 `OPENCLAW_AGENT_DIR=__INSTANCE__/.openclaw/agents/__AGENT_ID__`。
3. **跑完必自检身份**：如 `lark-cli whoami` 必须显示**本人**账号；若显示别人的名字 → **立即停手**：不继续、不发送任何结果，先报告主人。
4. **不要相信「看起来跑通了」**：全局 `lark-cli` 路由 shim 在缺少 `OPENCLAW_AGENT_DIR` 时会**静默 fallback** 到真实 CLI，按 `$HOME` 落到实例共享槽位。跑通 ≠ 身份对。
5. **绝不使用他人凭据，也不跨 agent 借用**：既不得用 main 的，也不得用兄弟 agent 的；同理自己的也不外借。
6. **凭据文件落盘一律 `0600`**；密码类**优先不落盘**，必须落盘时只存加密 / 密文（禁止明文密码文件）。
7. **新建凭据目录**直接建在 `workspaces/__WS_ID__/` 下，**不得**图方便写到共享目录或借用别人现成的文件。

### 🚫 已知他人账号（禁止使用）

`周贤 xian.zhou0831`、`付秋诚 fqc`、`Yueyue.Tang`、`bin1.hu`、`邹济乐` 等。
他人实例 / 工作区的凭据路径**只当「禁区清单」看**，绝不作为取用来源。

> **铁律一句话：凭据只进本 agent 专属目录；跑完必验身份；串了身份立即停手。**"""


def find_ws_dir(inst_root, agent_id):
    """定位工作区目录；agent id 与目录名大小写可能不同（如 TeamS data_group/Data_Group）。"""
    ws_root = os.path.join(inst_root, ".openclaw", "workspaces")
    if not os.path.isdir(ws_root):
        return None
    exact = os.path.join(ws_root, agent_id)
    if os.path.isdir(exact):
        return exact
    for d in sorted(os.listdir(ws_root)):
        if d.lower() == agent_id.lower():
            return os.path.join(ws_root, d)
    return None


def insert_rule(path, rule):
    marker = rule.splitlines()[0].strip()
    with open(path, encoding="utf-8") as f:
        content = f.read()
    if marker in content:
        return "already-has"
    lines = content.splitlines(keepends=True)
    out, inserted = [], False
    for line in lines:
        if not inserted and line.startswith("## "):
            out.append(rule.rstrip("\n") + "\n\n")
            inserted = True
        out.append(line)
    if not inserted:
        if content and not content.endswith("\n"):
            out.append("\n")
        out.append(rule.rstrip("\n") + "\n")
    mode = stat.S_IMODE(os.stat(path).st_mode)
    with open(path, "w", encoding="utf-8") as f:
        f.write("".join(out))
    os.chmod(path, mode)
    return "inserted"


def create_file(path, rule):
    content = (
        "# AGENTS.md - Your Workspace\n\nThis folder is home. Treat it that way.\n\n"
        + rule.rstrip("\n") + "\n"
    )
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    os.chmod(path, 0o644)
    return "created"


def main(argv):
    if len(argv) < 2:
        print("用法: write_tielu_all.py <实例名...>   例: openclaw_GTM openclaw_PJT")
        return 2
    report = []
    for name in argv[1:]:
        inst = os.path.join(BASE, name)
        agents_dir = os.path.join(inst, ".openclaw", "agents")
        if not os.path.isdir(agents_dir):
            report.append(f"{name} | - | SKIP no agents dir")
            continue
        for agent_id in sorted(os.listdir(agents_dir)):
            if agent_id == "main" or not os.path.isdir(os.path.join(agents_dir, agent_id)):
                continue
            ws = find_ws_dir(inst, agent_id)
            if ws is None:
                report.append(f"{name} | {agent_id} | SKIP no workspace dir")
                continue
            ws_id = os.path.basename(ws)
            rule = (
                RULE.replace("__INSTANCE__", inst)
                .replace("__WS_ID__", ws_id)
                .replace("__AGENT_ID__", agent_id)
            )
            target = os.path.join(ws, "AGENTS.md")
            try:
                res = insert_rule(target, rule) if os.path.isfile(target) else create_file(target, rule)
            except Exception as e:  # noqa: BLE001
                res = f"ERROR {e}"
            note = f" [ws 目录名大小写: {ws_id}]" if ws_id != agent_id else ""
            report.append(f"{name} | {agent_id} | {res}{note} -> {target}")
    print("\n".join(report))
    print(f"\nTOTAL agents processed: {len(report)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
