# Usage v3 脱敏 wire 样本

以下三份 body 与 `usage-client-interface.md` §18 第 8 项要求的三类样本对应。
所有 ID 已脱敏；结构、字段名与守恒关系与实际产物一致。
时间戳取整到秒，token 与时长是真实量级但非真实用户数据。

## 样本 A：单模型单角色

一次任务角色的请求，模型 `anthropic / claude-sonnet-4.5`，带两个工具调用与一项 checklist 完成。

```json
{
  "schema_version": 3,
  "client": { "version": "0.11.1" },
  "window": {
    "started_at": 1792456800000,
    "ended_at": 1792456860000,
    "active_seconds": 60,
    "dropped_seconds": 0
  },
  "sessions_started": 1,
  "facts": [
    {
      "role": "task",
      "provider": "anthropic",
      "model": "claude-sonnet-4.5",
      "custom": false,
      "requests": { "completed": 3, "cancelled": 0, "failed": 0 },
      "tokens": { "input": 12480, "output": 2360, "cache_read": 8192, "cache_write": 1024 },
      "turns": { "completed": 3, "cancelled": 0, "failed": 0, "aborted": 0 },
      "duration_ms": { "count": 3, "sum": 18400, "min": 4200, "max": 8100, "buckets": [0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0] },
      "turn_duration_ms": { "count": 3, "sum": 18400, "min": 4200, "max": 8100 },
      "tools": {
        "completed": 2,
        "failed": 0,
        "cancelled": 0,
        "by_name": {
          "read_file": { "completed": 1, "failed": 0, "cancelled": 0 },
          "write_to_file": { "completed": 1, "failed": 0, "cancelled": 0 }
        },
        "unlisted": { "completed": 0, "failed": 0, "cancelled": 0 }
      },
      "todos": {
        "declared": 2,
        "completed": 1,
        "reopened": 0,
        "abandoned": 0,
        "rounds_to_complete": { "count": 1, "sum": 2, "min": 2, "max": 2, "buckets": [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0] }
      },
      "task_attempts": { "count": 3, "sum": 4, "min": 1, "max": 2 },
      "errors": {},
      "retries": 1
    }
  ]
}
```

守恒检查：`by_name` 两项合计 `completed: 2` 等于 `tools.completed: 2`；
`todos.completed (1) <= todos.declared (2) + todos.reopened (0)`；
`task_attempts.count (3)` 等于 `requests` 总数 `3`。

## 样本 B：同模型跨角色

同一模型同时服务任务与子代理，两个 fact 并列，**不合并**。

```json
{
  "schema_version": 3,
  "client": { "version": "0.11.1" },
  "window": {
    "started_at": 1792456800000,
    "ended_at": 1792456860000,
    "active_seconds": 60,
    "dropped_seconds": 0
  },
  "sessions_started": 0,
  "facts": [
    {
      "role": "task",
      "provider": "anthropic",
      "model": "claude-sonnet-4.5",
      "custom": false,
      "requests": { "completed": 2, "cancelled": 0, "failed": 0 },
      "tokens": { "input": 9100, "output": 1500, "cache_read": 4096, "cache_write": 0 },
      "turns": { "completed": 2, "cancelled": 0, "failed": 0, "aborted": 0 },
      "turn_duration_ms": { "count": 2, "sum": 11000, "min": 5000, "max": 6000 },
      "duration_ms": { "count": 2, "sum": 11000, "min": 5000, "max": 6000, "buckets": [0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0] },
      "tools": { "completed": 1, "failed": 0, "cancelled": 0, "by_name": { "read_file": { "completed": 1, "failed": 0, "cancelled": 0 } } },
      "task_attempts": { "count": 2, "sum": 2, "min": 1, "max": 1 },
      "errors": {},
      "retries": 0
    },
    {
      "role": "subagent",
      "provider": "anthropic",
      "model": "claude-sonnet-4.5",
      "custom": false,
      "requests": { "completed": 1, "cancelled": 0, "failed": 0 },
      "tokens": { "input": 4020, "output": 640, "cache_read": 0, "cache_write": 0 },
      "turns": { "completed": 1, "cancelled": 0, "failed": 0, "aborted": 0 },
      "duration_ms": { "count": 1, "sum": 3900, "min": 3900, "max": 3900, "buckets": [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0] },
      "task_attempts": { "count": 1, "sum": 1, "min": 1, "max": 1 },
      "errors": {},
      "retries": 0
    }
  ]
}
```

要点：`(task, anthropic, claude-sonnet-4.5, false)` 与 `(subagent, anthropic, claude-sonnet-4.5, false)`
是**两个事实**。读取方可以自行相加，但客户端不在发送前折叠成 `(anthropic, model)` 边际。

## 样本 C：同 ID 的 custom / non-custom

同一 model 字符串，一次来自 Profile 的自由输入（custom），一次来自注册表（非 custom）。

```json
{
  "schema_version": 3,
  "client": { "version": "0.11.1" },
  "window": {
    "started_at": 1792456800000,
    "ended_at": 1792456860000,
    "active_seconds": 60,
    "dropped_seconds": 0
  },
  "sessions_started": 0,
  "facts": [
    {
      "role": "task",
      "provider": "openrouter",
      "model": "deepseek_deepseek-chat",
      "custom": true,
      "requests": { "completed": 1, "cancelled": 0, "failed": 0 },
      "tokens": { "input": 3300, "output": 410, "cache_read": 0, "cache_write": 0 },
      "turns": { "completed": 1, "cancelled": 0, "failed": 0, "aborted": 0 },
      "duration_ms": { "count": 1, "sum": 2600, "min": 2600, "max": 2600, "buckets": [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
      "task_attempts": { "count": 1, "sum": 1, "min": 1, "max": 1 },
      "errors": {},
      "retries": 0
    },
    {
      "role": "task",
      "provider": "openrouter",
      "model": "deepseek_deepseek-chat",
      "custom": false,
      "requests": { "completed": 4, "cancelled": 0, "failed": 0 },
      "tokens": { "input": 15800, "output": 2100, "cache_read": 12288, "cache_write": 512 },
      "turns": { "completed": 4, "cancelled": 0, "failed": 0, "aborted": 0 },
      "duration_ms": { "count": 4, "sum": 14800, "min": 2900, "max": 4400, "buckets": [0, 0, 1, 2, 1, 0, 0, 0, 0, 0, 0] },
      "task_attempts": { "count": 4, "sum": 5, "min": 1, "max": 2 },
      "errors": {},
      "retries": 1
    }
  ]
}
```

要点：`custom` 是身份的一部分，因此两行不能相加。这样读取方才能区分
「用户手填 ID 的行为」与「注册表模型的默认使用行为」——合并会永久丢失这个区分。

## 关于身份归一化的说明

样本中的 `model` 已处于归一化形式。真实输入可能是 `DeepSeek/DeepSeek-Chat` 或带空格的形式，
`normalizeModel` 会做**替换式**归一化（非法字符 → `_`、截断 64），并保证：

- 同一逻辑 model 在不同调用点得到同一键；
- 归一化结果为空或长度越界时折成 `_unknown`，此时 `custom` 必须为 `false`；
- 不产生 `_custom` / `_other` 这类折叠占位符。
