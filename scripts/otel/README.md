# Dline OpenTelemetry Dashboard

本目录提供本地 OpenTelemetry LGTM 环境和可导入 Grafana 的 Dline Dashboard。

## 文件

| 文件 | 用途 |
| --- | --- |
| `docker-compose.yml` | 启动本地 Grafana、Prometheus、Loki、Tempo、Pyroscope 和只读 Grafana MCP |
| `dline-usage-dashboard.json` | 现有 usage、token、cache 和 cost 视图 |
| `dline-performance-dashboard.json` | runtime health、API latency、调用结果和 provider/model 维度性能 |
| `dline-errors-dashboard.json` | API 错误、Task 状态/快照/用量时间线和 Tempo 调用链瀑布图 |
| `dline-alert-rules.yaml` | 存储层慢提交、回退重写和状态发布耗时的 Grafana 统一告警规则 |

Dashboard 和告警规则都是配置文件，不会自动安装、修改 datasource 或写入 Grafana。

## 前提

1. Dline 的 OTLP logs、metrics 和 traces 能到达 collector。默认 loopback endpoint 为：

   ```text
   http://127.0.0.1:4318
   ```

2. 在 **Dline Settings → About** 中启用 **Allow error reporting**。该 consent 负责 runtime/error logs、operation spans 和 runtime metrics；`unset` 或 `disabled` 不会补发历史信号。
3. IDE telemetry 不能被主机设置禁用。
4. Grafana 中需要可用的 Prometheus、Loki 和 Tempo datasource。性能 Dashboard 只需要 Prometheus；错误 Dashboard 需要三者。

如需启动仓库提供的本地容器，以下命令会创建并启动本地 Docker 资源：

```powershell
# PowerShell, repository root
docker compose -f scripts/otel/docker-compose.yml up -d
```

本地 Grafana 默认监听：

```text
http://127.0.0.1:3000
```

## 导入 Dashboard

1. 打开 Grafana 的 **Dashboards → New → Import**。
2. 上传一个 JSON 文件，或粘贴完整 JSON。
3. 为导入页中的 datasource inputs 选择实际 datasource：
   - `DS_PROMETHEUS` → Prometheus；
   - `DS_LOKI` → Loki；
   - `DS_TEMPO` → Tempo。
4. 错误 Dashboard 可先选择 `Log Service Instance`，避免把不同 extension-host 的 Loki 现场混在一起。当前本地 Prometheus 不会把 resource `service.instance.id` 提升为 metric label，因此性能指标保持跨实例聚合。

三个 Dashboard 使用不同的固定 UID，可以并存导入。

## 性能 Dashboard

`dline-performance-dashboard.json` 使用以下 runtime metrics：

```text
runtime_event_loop_delay_ms
runtime_cpu_utilization_ratio
runtime_rss_bytes
runtime_heap_growth_bytes
dline_runtime_operation_duration_bucket|sum|count
```

API 面板统一使用：

```promql
dline_runtime_operation_duration_count{operation="api.request"}
```

这保证调用量、延迟和失败率来自同一个观测边界。

### 指标语义

- 一个 `api.request` 样本表示一次 API adapter invocation，不表示 provider SDK 内部每次物理 HTTP attempt。
- API duration 覆盖 stream consumer 等待时间，以及 adapter 内部执行的 retry/fallback 时间。
- Failure ratio 为 `failed / (completed + failed)`；`cancelled` 单独显示，但不计为失败。
- runtime gauge 没有样本时保持 no-data，不使用 `or vector(0)` 把缺失伪装成健康零值。
- production PromQL 默认使用 `canary_id!~".+"` 排除显式 live canary series。
- `provider`、`model`、`api_format`、`operation` 和 `outcome` 是查询维度；Task ID 不进入 metric labels。

### 存储层提交

所有 instrumented phase 共用 `dline_runtime_operation_duration_*`，用 `operation` label 区分，因此新增观测点不需要新建 instrument。存储层提交为：

```promql
dline_runtime_operation_duration_bucket{operation="buffered_store.flush_commit"}
```

`commit` label 表示本次提交的形状：

| 取值 | 含义 |
| --- | --- |
| `buffered_append` | buffer 干净，直接追加新尾部 |
| `append` | 锁内事务判定为纯尾部增长，追加提交 |
| `rewrite` | 回退到重写整个集合 |

需要关注的是形状分布而非单次耗时：`rewrite` 的代价随集合增长，一个长会话若每次 flush 都重写，就会为追加一条记录而重写数十 MB。非尾部编辑和截断本身就需要重写，因此短暂出现属正常，持续偏移才是信号。

慢提交同时会由扩展写入 warn log，包含耗时、形状和条目数：

```text
[BufferedUnifyStore] slow commit: durationMs=..., commit=..., items=...
```

### 工具耗时

工具执行同时产出 span 和 histogram。span 进 Tempo 用于单次调用的调用链，histogram 用于查询和告警：

```promql
dline_runtime_operation_duration_bucket{operation="tool.execution"}
```

维度为 `tool`、`outcome` 和 `is_native`。

上报的是**工具自身的工作时间**，不含两类等待：

| 扣除项 | 原因 |
| --- | --- |
| 审批等待 | 由用户决定，计入会变成衡量审阅速度 |
| 命令执行 | 由工作区决定，一次长时间构建不代表工具慢 |

两者分别以 `approvalWaitMs` 和 `commandWaitMs` 维度单独上报，因此「工具本身很快但审批等了很久」与「工具确实慢」可以区分。扣除在 tool config 组装处统一包裹，所有 handler 自动生效；等待重叠（例如命令执行中途触发审批）不会被重复扣除。

流式的 partial block 不计入，避免一次调用的多个片段污染直方图。

### 告警规则

`dline-alert-rules.yaml` 提供四条规则：存储慢提交、回退重写占比、工具慢调用、以及设置驱动的状态发布耗时。

告警规则与 Dashboard 的导入方式不同：Dashboard 导出携带 `${DS_PROMETHEUS}` 占位符，由导入页映射；而告警规则需要目标实例上真实的 datasource UID。使用步骤：

1. 在 **Connections → Data sources → Prometheus** 中复制 UID；
2. 替换文件中全部 `REPLACE_WITH_PROMETHEUS_UID`；
3. 将文件挂载到 Grafana 的 `/etc/grafana/provisioning/alerting/` 并重启。

当前 `docker-compose.yml` 没有挂载 provisioning 目录，因此在补充该挂载或在 Grafana UI 中手工创建之前，这些规则不会生效。

三条规则都使用 `execErrState: OK` 和 `noDataState: OK`：本地环境经常没有样本，缺失数据不应被当作故障。

## 错误 Dashboard 与调用链瀑布图

`dline-errors-dashboard.json` 将 Loki 错误现场和 Tempo trace 放在同一 Dashboard。

### 最短排查流程

1. 在 **Recent API Failure Logs** 找到 `api.request.failed`。
2. 展开日志详情，复制原生 trace context 中的 Trace ID，或 structured metadata 中的 `runtime_trace_id`。
3. 把该值填入 `traceFilter`，查看同一 trace 的 Task/API 时间线。
4. 把同一 32 位十六进制值填入 `traceId`，查看 **Execution Call-chain Waterfall**。

瀑布图的真实层级包括：

```text
task.turn (segment 0)
└── api.request
    └── provider/runtime spans that inherited the API context
└── task.turn (error continuation segment, same trace)
```

实际父子关系由运行时 span context 决定。图中只会出现已经创建并正确传递 parent context 的 spans，不会根据日志时间戳推测未插桩函数调用。

API 错误会先结束当前 `task.turn` segment，再在同一个真实 turn 和同一个 trace 中开始 continuation segment。新的真实 turn 会创建新的 trace，不会把两个 turn 误连为一条瀑布。

### 可查询的错误现场

`api.request.failed` 和相关 Task timeline logs 使用结构化字段，包含：

- provider、model、API format、错误 code/status/fingerprint；
- API 是否已收到首个 chunk、chunk 数、局部 token progress；
- 当前 Task phase、revision、API index、interaction/cancellation 状态；
- 最近一次成功持久化 Task snapshot 的 revision/timestamp；
- Task 累计 token/cache/cost、provider round 和 execution 数；
- 原生 trace/span identity 和单调递增的 Task timeline sequence。

Task snapshot 的 prompt、消息、工具输入、模型输出和队列内容不会进入遥测；这里只读取权威状态 owner 的安全标量摘要。

## 配置 Trace-to-logs

Dashboard 不能修改 datasource 设置。若需要从 Tempo span 一键跳转到 Loki，请在 Tempo datasource 中配置 **Trace to logs**，选择 Loki datasource，并使用 Dline 的 service identity 和时间窗口。

若 Loki UI 没有自动把 Trace ID 显示为链接，可在 Loki datasource 中配置 derived field。Dline 同时提供：

- OTLP LogRecord 的原生 trace context；
- structured metadata `runtime_trace_id` 和 `runtime_span_id`。

优先使用原生 trace context；structured metadata 用于 Dashboard 文本过滤和故障排查。

## Live collector 验证

仓库包含默认跳过的合成 API 错误测试。它只向现有本地 collector 发送 canary，不调用模型或付费 API，也不会安装 Dashboard。

```powershell
# PowerShell, repository root
$env:DLINE_LIVE_OTEL_TEST = "1"
try {
  npm run test:run -- src/core/api/observability/api-request-observation.live.test.ts --maxWorkers=1
} finally {
  Remove-Item Env:DLINE_LIVE_OTEL_TEST -ErrorAction SilentlyContinue
}
```

成功输出包含：

```text
DLINE_LIVE_OTEL_RESULT {"canaryId":"...","traceId":"...","failedTaskSegmentId":"...","continuationSegmentId":"..."}
```

使用 `canaryId` 查询 Loki，使用 `traceId` 查询 Tempo。该 live 测试验证错误 trace/log 关联；Prometheus 面板使用正在运行的 extension-host metrics 验证。生产 Dashboard 默认排除带 `canary_id` 的 canary 数据。

## 隐私和限制

- exception message、stack prose、prompt、response、command、output、credential 和用户身份由内容策略掩码。
- error fingerprint 只使用受限的错误 type/code/status/source file，不包含异常正文。
- HTTP status 只接受 `100..599` 的整数；错误 code 只保留受限标识符，credential-like 值会被拒绝。
- Timeline 是 Task 状态、snapshot durability、usage 和 API stream progress 的时间线，不是第二份 Task 状态存储。
- Dashboard 不会把 exporter admission 当成 collector delivery；collector 是否接收仍需通过 Tempo/Loki/Prometheus 查询确认。
- 旧 extension-host 可能继续发送旧 schema，排查时同时检查 `service_version` 和 `service_instance_id`。
- `dline_runtime_operation_duration_*` 的样本带有 `bucket_schema`，标识该样本使用的 bucket 布局。分位数查询必须锁定单一取值：`le="15000"` 只存在于 `v2`，混合聚合会使它的计数低于 `le="10000"`，Prometheus 的单调性修正随后把估计值推向最高有限边界。计数与求和不依赖 bucket 边界，因此比值查询刻意不锁定该标签，以覆盖所有版本的宿主。

更多 consent、Journal、OTLP 字段和 exporter 排查说明见 [`../../docs/troubleshooting/telemetry.mdx`](../../docs/troubleshooting/telemetry.mdx)。
