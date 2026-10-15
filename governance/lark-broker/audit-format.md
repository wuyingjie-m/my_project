# audit.jsonl — 审计日志格式与取证查询

## 行格式

broker 每次调用写两行 JSON（开始一行、结束一行），字段：

| 字段 | 说明 |
|---|---|
| `time` | UTC ISO-8601，如 `2026-10-14T00:50:06.819836+00:00` |
| `subject` | 声明的调用身份（LARK_BROKER_SUBJECT），即 users.json 白名单键 |
| `operation` | lark-cli 命令族 + 子命令，如 `im +messages-send`（截取前两个参数） |
| `status` | `started`（开始）/ `ok`（退出码 0）/ `error`（非零或超时） |

示例：

```json
{"time": "2026-10-14T22:00:08.245230+00:00", "subject": "zxy", "operation": "im +messages-send", "status": "started"}
{"time": "2026-10-14T22:00:08.245230+00:00", "subject": "zxy", "operation": "im +messages-send", "status": "ok"}
```

## 常用取证查询

```bash
# 某身份的全部调用轨迹
grep '"subject": "jwh"' audit.jsonl

# 某时间窗内的失败调用
grep '"status": "error"' audit.jsonl | grep '2026-10-15T'

# 各身份调用量排行
python3 -c "
import json, collections
c = collections.Counter()
for line in open('audit.jsonl'):
    try:
        r = json.loads(line)
        if r.get('status') == 'started': c[r['subject']] += 1
    except: pass
for k, v in c.most_common(): print(k, v)
"

# 找出被白名单拒绝的调用（broker 拒绝时只输出 stderr，不落审计——需查调用方日志）
```

## 设计说明

- **为什么 started/ok 成对写**：`started` 无配对 `ok`/`error` = 进程被杀/超时强杀，本身就是异常信号
- **拒绝调用不落盘**：白名单拒绝发生在业务调用前，属安全事件而非使用记录——如需安全审计，可在 error() 分支加一行 `status=denied`
- **明文约束**：日志里只有 subject/操作名，绝无 key、消息内容——审计可分享，凭据不出库
