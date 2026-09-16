# Dline OpenTelemetry Dashboards

This directory provides a local OpenTelemetry LGTM environment and importable Grafana dashboards for Dline.

## Files

| File | Purpose |
| --- | --- |
| `docker-compose.yml` | Starts local Grafana, Prometheus, Loki, Tempo, Pyroscope, and a read-only Grafana MCP server |
| `dline-usage-dashboard.json` | Existing usage, token, cache, and cost views |
| `dline-performance-dashboard.json` | Runtime health, API latency, outcomes, and provider/model performance |
| `dline-errors-dashboard.json` | API errors, Task state/snapshot/usage timelines, and a Tempo call-chain waterfall |
| `dline-alert-rules.yaml` | Grafana unified alert rules for slow storage commits, rewrite fallback, and state-publication duration |

The dashboards and alert rules are configuration files. They do not install themselves, change datasources, or write to Grafana.

## Prerequisites

1. Dline OTLP logs, metrics, and traces must reach a collector. The default loopback endpoint is:

   ```text
   http://127.0.0.1:4318
   ```

2. Enable **Allow error reporting** under **Dline Settings → About**. This consent owns runtime/error logs, operation spans, and runtime metrics. Signals are not backfilled while consent is `unset` or `disabled`.
3. IDE telemetry must not be disabled by the host.
4. Grafana needs working Prometheus, Loki, and Tempo datasources. The performance dashboard only needs Prometheus; the error dashboard needs all three.

To start the repository's local containers, the following command creates and starts local Docker resources:

```powershell
# PowerShell, repository root
docker compose -f scripts/otel/docker-compose.yml up -d
```

Local Grafana listens on:

```text
http://127.0.0.1:3000
```

## Import a dashboard

1. Open **Dashboards → New → Import** in Grafana.
2. Upload one JSON file or paste its complete JSON.
3. Assign the actual datasources to the import inputs:
   - `DS_PROMETHEUS` → Prometheus;
   - `DS_LOKI` → Loki;
   - `DS_TEMPO` → Tempo.
4. In the error dashboard, select a `Log Service Instance` first to isolate one extension host in Loki. The current local Prometheus setup does not promote resource `service.instance.id` to a metric label, so performance metrics remain aggregated across instances.

The three dashboards have distinct fixed UIDs and can be imported together.

## Performance dashboard

`dline-performance-dashboard.json` uses these runtime metrics:

```text
runtime_event_loop_delay_ms
runtime_cpu_utilization_ratio
runtime_rss_bytes
runtime_heap_growth_bytes
dline_runtime_operation_duration_bucket|sum|count
```

All API panels use this common boundary:

```promql
dline_runtime_operation_duration_count{operation="api.request"}
```

This keeps volume, latency, and failure ratios on the same observation boundary.

### Metric semantics

- One `api.request` sample represents one API adapter invocation, not each physical HTTP attempt performed inside a provider SDK.
- API duration includes stream-consumer waiting time and retry/fallback work performed inside the adapter.
- Failure ratio is `failed / (completed + failed)`. `cancelled` remains visible as a separate outcome and is not counted as a failure.
- Missing runtime gauge samples remain no-data. The dashboard does not use `or vector(0)` to present missing data as a healthy zero.
- Production PromQL uses `canary_id!~".+"` by default to exclude explicit live-canary series.
- `provider`, `model`, `api_format`, `operation`, and `outcome` are query dimensions. Task IDs are not metric labels.

### Buffered store commits

Every instrumented phase reports into the shared `dline_runtime_operation_duration_*` histogram and is distinguished by the `operation` label, so a new observation point needs no new instrument. Storage commits are:

```promql
dline_runtime_operation_duration_bucket{operation="buffered_store.flush_commit"}
```

The `commit` label carries the shape of that commit:

| Value | Meaning |
| --- | --- |
| `buffered_append` | The buffer was clean, so the new tail was appended directly |
| `append` | The locked transaction found a pure tail growth and committed by appending |
| `rewrite` | Fell back to rewriting the whole collection |

Watch the distribution of shapes rather than one duration: the cost of `rewrite` grows with the collection, so a long conversation rewriting on every flush rewrites tens of megabytes to add one entry. Non-tail edits and truncations legitimately rewrite, so brief spikes are expected; a sustained shift is the signal.

A slow commit is also written to the extension warn log with its duration, shape, and item count:

```text
[BufferedUnifyStore] slow commit: durationMs=..., commit=..., items=...
```

### Tool duration

Tool execution reports both a span and a histogram. The span goes to Tempo for the call chain of one invocation; the histogram is what can be queried and alerted on:

```promql
dline_runtime_operation_duration_bucket{operation="tool.execution"}
```

Its dimensions are `tool`, `outcome`, and `is_native`.

The reported value is the work the tool itself performed, with two kinds of waiting removed:

| Excluded | Reason |
| --- | --- |
| Approval wait | Governed by the user; counting it would measure how fast a reviewer clicks |
| Command execution | Governed by the workspace; one long build does not make the tool slow |

Both are reported separately as the `approvalWaitMs` and `commandWaitMs` dimensions, so "the tool was fast but the approval took minutes" stays distinguishable from "the tool is slow". The exclusion is installed once where the tool config is assembled, so every handler gets it, and overlapping waits — a command that prompts mid-run — are not subtracted twice.

Streamed partial blocks are not measured; they are fragments of one call and would otherwise flood the histogram.

### Alert rules

`dline-alert-rules.yaml` provides four rules: slow storage commits, rewrite-fallback ratio, slow tool execution, and settings-driven state publication duration.

Alert rules are not imported the way dashboards are. A dashboard export carries `${DS_PROMETHEUS}` placeholders that the import page maps, while an alert rule needs the real datasource UID of the target instance:

1. Copy the UID from **Connections → Data sources → Prometheus**.
2. Replace every `REPLACE_WITH_PROMETHEUS_UID` in the file.
3. Mount the file into Grafana at `/etc/grafana/provisioning/alerting/` and restart.

The current `docker-compose.yml` does not mount a provisioning directory, so these rules take effect only after that mount is added or the rules are recreated through the Grafana UI.

All three rules use `execErrState: OK` and `noDataState: OK`: a local environment often has no samples at all, and missing data must not be reported as a fault.

## Error dashboard and call-chain waterfall

`dline-errors-dashboard.json` places the Loki error scene and the Tempo trace in the same dashboard.

### Shortest investigation workflow

1. Find an `api.request.failed` entry in **Recent API Failure Logs**.
2. Expand the log details and copy the Trace ID from the native trace context, or copy `runtime_trace_id` from structured metadata.
3. Put the value in `traceFilter` to isolate the Task/API timeline for the same trace.
4. Put the same exact 32-character hexadecimal value in `traceId` to render **Execution Call-chain Waterfall**.

The real hierarchy can include:

```text
task.turn (segment 0)
└── api.request
    └── provider/runtime spans that inherited the API context
└── task.turn (error continuation segment, same trace)
```

The runtime span context determines the actual parent-child relationships. The waterfall only displays spans that were created and received the correct parent context. It does not infer uninstrumented function calls from log timestamps.

An API error ends the current `task.turn` segment before starting a continuation segment in the same real turn and trace. A new real turn starts a new trace, so separate turns are not combined into one waterfall.

### Queryable error scene

`api.request.failed` and the related Task timeline logs provide structured fields for:

- provider, model, API format, error code/status/fingerprint;
- whether the first API chunk arrived, chunk count, and request-local token progress;
- current Task phase, revision, API index, interaction, and cancellation state;
- revision/timestamp of the latest successfully persisted Task snapshot;
- cumulative Task token/cache/cost values, provider rounds, and execution count;
- native trace/span identity and a monotonically increasing Task timeline sequence.

Task snapshot prompts, messages, tool inputs, model output, and queue content are not exported. Telemetry reads only safe scalar summaries from the authoritative state owners.

## Configure Trace to logs

A dashboard cannot modify datasource settings. To navigate from a Tempo span to Loki in one click, configure **Trace to logs** on the Tempo datasource, select the Loki datasource, and set a suitable Dline service identity and time window.

If the Loki UI does not automatically present the Trace ID as a link, configure a derived field on the Loki datasource. Dline provides both:

- the native OTLP LogRecord trace context;
- structured metadata fields `runtime_trace_id` and `runtime_span_id`.

Prefer the native trace context for correlation. The structured metadata fields support dashboard text filtering and troubleshooting.

## Live collector verification

The repository includes a synthetic API-error test that is skipped by default. It only sends a canary to an existing local collector. It does not call a model or paid API, and it does not install a dashboard.

```powershell
# PowerShell, repository root
$env:DLINE_LIVE_OTEL_TEST = "1"
try {
  npm run test:run -- src/core/api/observability/api-request-observation.live.test.ts --maxWorkers=1
} finally {
  Remove-Item Env:DLINE_LIVE_OTEL_TEST -ErrorAction SilentlyContinue
}
```

Successful output includes:

```text
DLINE_LIVE_OTEL_RESULT {"canaryId":"...","traceId":"...","failedTaskSegmentId":"...","continuationSegmentId":"..."}
```

Use `canaryId` for Loki and `traceId` for Tempo. This live test verifies error trace/log correlation; Prometheus panels are validated against metrics from a running extension host. Production dashboard queries exclude records and series carrying `canary_id` by default.

## Privacy and limits

- The content policy masks exception prose, prompts, responses, commands, output, credentials, and user identities.
- Error fingerprints use only bounded error type/code/status/source-file data and never include exception prose.
- HTTP status is accepted only as an integer from `100..599`. Error codes must be bounded identifiers; credential-like values are rejected.
- The timeline describes Task state, snapshot durability, usage, and API stream progress. It is not a second Task state store.
- Dashboard data does not turn exporter admission into proof of collector delivery. Confirm collector acceptance with Tempo, Loki, and Prometheus queries.
- Older extension hosts may continue exporting older schemas. Check both `service_version` and `service_instance_id` during investigation.
- `dline_runtime_operation_duration_*` samples carry `bucket_schema`, identifying the bucket layout they were recorded against. Quantile queries must pin one value: `le="15000"` exists only in `v2`, so summing layouts counts fewer samples there than at `le="10000"` and the monotonicity repair pushes the estimate toward the highest finite bound. Counts and sums do not depend on bucket bounds, so ratio queries deliberately omit the label and keep covering hosts on every build.

For consent, Journal, OTLP field placement, and exporter troubleshooting, see [`../../docs/troubleshooting/telemetry.mdx`](../../docs/troubleshooting/telemetry.mdx).
