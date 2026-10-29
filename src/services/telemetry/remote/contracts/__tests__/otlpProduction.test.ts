import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { DeliveryOutcome } from "../classification"
import {
    buildOtlpResource,
    classifyOtlpResponse,
    DLINE_CONTRACT,
    encodeOtlpLogs,
    encodeOtlpMetrics,
    encodeOtlpTraces,
    histogramBucketIndex,
    OTLP_ADMISSION,
    OTLP_LIMITS,
    OTLP_METRIC_CATALOG,
    OTLP_SCHEMA_URL,
    OTLP_SCOPE_VERSION,
    OTLP_SPAN_CATALOG,
    type OtlpSpanInput,
} from "../otlpProduction"

const FIXTURE = JSON.parse(
    readFileSync(path.join(__dirname, "fixtures", "otlp-production-reference.json"), "utf8").replace(/\r\n/g, "\n"),
)

/** The fixture declares attribute order insignificant; sort every attribute list before comparing. */
function normalized(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(normalized)
    if (typeof value !== "object" || value === null) return value
    const entries = Object.entries(value).map(([key, inner]) => {
        if (key === "attributes" && Array.isArray(inner)) {
            const sorted = [...inner].sort((a, b) => String(a.key).localeCompare(String(b.key)))
            return [key, sorted.map(normalized)]
        }
        return [key, normalized(inner)]
    })
    return Object.fromEntries(entries)
}

function fixtureResource() {
    const input = FIXTURE.resource.input
    return buildOtlpResource({
        clientVersion: input.client_version,
        platform: input.platform,
        arch: input.arch,
        environment: input.environment,
        releaseChannel: input.release_channel,
        hostEditor: input.host_editor,
        isDev: input.is_dev,
        droppedRecords: input.dropped_records,
    })
}

/** Contract action names (fixture) against the client's delivery outcome kinds. */
const ACTION_KIND: Record<string, DeliveryOutcome["kind"]> = {
    acknowledge: "acknowledged",
    replay: "replay",
    refresh_and_replay: "refresh_token",
    stop: "stop",
    dead_letter: "discard",
    split: "too_large",
    wait: "wait",
}

describe("production OTLP contract constants", () => {
    it("matches the fixture's header, schema, scope version, limits and admission", () => {
        expect(DLINE_CONTRACT).toBe(FIXTURE.x_dline_contract)
        expect(OTLP_SCHEMA_URL).toBe(FIXTURE.schema_url)
        expect(OTLP_SCOPE_VERSION).toBe(FIXTURE.scope_version)
        expect(OTLP_LIMITS).toEqual({
            maxBodyBytes: FIXTURE.limits.max_body_bytes,
            maxLogRecords: FIXTURE.limits.max_log_records,
            maxMetricPoints: FIXTURE.limits.max_metric_points,
            maxSpans: FIXTURE.limits.max_spans,
            maxReplays: FIXTURE.limits.max_replays,
            replayHorizonMs: FIXTURE.limits.replay_horizon_ms,
        })
        expect(OTLP_ADMISSION).toEqual({
            logsPerHour: FIXTURE.admission.logs_per_hour,
            logsPerDay: FIXTURE.admission.logs_per_day,
            metricsIntervalMs: FIXTURE.admission.metrics_interval_ms,
            spansPerHour: FIXTURE.admission.spans_per_hour,
            spansPerDay: FIXTURE.admission.spans_per_day,
        })
    })

    it("declares exactly the fixture's instrument and span catalogs", () => {
        expect(
            OTLP_METRIC_CATALOG.map((descriptor) => ({
                name: descriptor.name,
                scope: descriptor.scope,
                type: descriptor.type,
                ...(descriptor.type === "sum" ? { monotonic: true } : {}),
                unit: descriptor.unit,
                description: descriptor.description,
                ...(descriptor.type === "histogram" ? { explicit_bounds: [...descriptor.explicitBounds] } : {}),
                attributes: [...descriptor.attributes],
            })),
        ).toEqual(FIXTURE.metrics.catalog)
        expect(
            OTLP_SPAN_CATALOG.map(({ name, scope, kind, attributes }) => ({ name, scope, kind, attributes: [...attributes] })),
        ).toEqual(FIXTURE.traces.catalog)
    })
})

describe("production OTLP encoders", () => {
    it("builds the allowlisted Resource from client identity", () => {
        expect(normalized(fixtureResource())).toEqual(normalized(FIXTURE.resource.expected))
    })

    it("omits os and arch values outside the semconv vocabulary instead of guessing", () => {
        const keys = buildOtlpResource({
            clientVersion: "0.12.0",
            platform: "aix",
            arch: "s390x",
            environment: "production",
            isDev: false,
            droppedRecords: 0,
        }).attributes.map((attribute) => attribute.key)
        expect(keys).not.toContain("os.type")
        expect(keys).not.toContain("host.arch")
        for (const key of keys) expect(FIXTURE.resource.allowed_keys).toContain(key)
    })

    it("encodes the logs example with eventName, severity text and trace context", () => {
        const { input, exported_at_ms: exportedAt } = FIXTURE.logs.example
        const body = encodeOtlpLogs(
            fixtureResource(),
            [
                {
                    eventName: input.event_name,
                    severity: input.severity,
                    channel: input.channel,
                    occurrences: input.occurrences,
                    firstSeenMs: input.first_seen_ms,
                    lastSeenMs: input.last_seen_ms,
                    traceId: input.trace_id,
                    spanId: input.span_id,
                    attributes: input.attributes,
                },
            ],
            exportedAt,
        )
        expect(normalized(body)).toEqual(normalized(FIXTURE.logs.example.expected_body))
    })

    it("drops an invalid trace context rather than sending a zero or malformed id", () => {
        const body = encodeOtlpLogs(
            fixtureResource(),
            [
                {
                    eventName: "session.health",
                    severity: "warn",
                    channel: "runtime",
                    occurrences: 1,
                    firstSeenMs: 1,
                    lastSeenMs: 1,
                    traceId: "0".repeat(32),
                    spanId: "b7ad6b7169203331",
                    attributes: {},
                },
            ],
            2,
        ) as { resourceLogs: { scopeLogs: { logRecords: Record<string, unknown>[] }[] }[] }
        const record = body.resourceLogs[0].scopeLogs[0].logRecords[0]
        expect(record.traceId).toBeUndefined()
        expect(record.flags).toBeUndefined()
    })

    it("encodes the metrics example as one delta window in catalog order", () => {
        const { window_start_ms: startMs, window_end_ms: endMs, input } = FIXTURE.metrics.example
        const bounds = FIXTURE.metrics.catalog.find(
            (entry: { name: string }) => entry.name === "gen_ai.client.operation.duration",
        ).explicit_bounds as number[]
        const seconds = input.operations.map((operation: { duration_ms: number }) => operation.duration_ms / 1_000)
        const bucketCounts = Array.from(
            { length: bounds.length + 1 },
            (_, index) =>
                seconds.filter(
                    (value: number) =>
                        value > (bounds[index - 1] ?? Number.NEGATIVE_INFINITY) &&
                        value <= (bounds[index] ?? Number.POSITIVE_INFINITY),
                ).length,
        )
        const first = input.operations[0]
        const body = encodeOtlpMetrics(fixtureResource(), { startMs, endMs }, [
            { name: "dline.session.started", attributes: {}, value: input.sessions_started },
            { name: "dline.runtime.event_loop.delay", attributes: {}, value: Math.max(...input.event_loop_delay_ms) / 1_000 },
            {
                name: "gen_ai.client.operation.duration",
                attributes: {
                    "gen_ai.operation.name": "chat",
                    "gen_ai.provider.name": first.provider,
                    "gen_ai.request.model": first.model,
                    "dline.role": first.role,
                    "dline.outcome": first.outcome,
                },
                histogram: {
                    count: seconds.length,
                    sum: seconds.reduce((total: number, value: number) => total + value, 0),
                    min: Math.min(...seconds),
                    max: Math.max(...seconds),
                    bucketCounts,
                },
            },
        ])
        expect(normalized(body)).toEqual(normalized(FIXTURE.metrics.example.expected_body))
    })

    it("sends no scope for a window without points", () => {
        const body = encodeOtlpMetrics(fixtureResource(), { startMs: 0, endMs: 60_000 }, []) as {
            resourceMetrics: { scopeMetrics: unknown[] }[]
        }
        expect(body.resourceMetrics[0].scopeMetrics).toEqual([])
    })

    it("places a value on a bound into that bound's bucket and above the last bound into the overflow bucket", () => {
        const bounds = FIXTURE.metrics.catalog.at(-1).explicit_bounds as number[]
        expect(histogramBucketIndex(bounds, 0.32)).toBe(5)
        expect(histogramBucketIndex(bounds, 0.320001)).toBe(6)
        expect(histogramBucketIndex(bounds, 0)).toBe(0)
        expect(histogramBucketIndex(bounds, 1_000)).toBe(bounds.length)
    })

    it("encodes the traces example with catalog kinds, scopes and UNSET/ERROR status", () => {
        const spans: OtlpSpanInput[] = FIXTURE.traces.example.input.map(
            (span: {
                name: OtlpSpanInput["name"]
                trace_id: string
                span_id: string
                parent_span_id?: string
                start_ms: number
                end_ms: number
                outcome: OtlpSpanInput["outcome"]
                attributes: Record<string, string | number>
            }) => ({
                name: span.name,
                traceId: span.trace_id,
                spanId: span.span_id,
                ...(span.parent_span_id ? { parentSpanId: span.parent_span_id } : {}),
                startMs: span.start_ms,
                endMs: span.end_ms,
                outcome: span.outcome,
                attributes: span.attributes,
            }),
        )
        expect(normalized(encodeOtlpTraces(fixtureResource(), spans))).toEqual(normalized(FIXTURE.traces.example.expected_body))
    })

    it("keeps a cancelled span UNSET and strips attributes outside the span's allowlist", () => {
        const body = encodeOtlpTraces(fixtureResource(), [
            {
                name: "dline.tool.execute",
                traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
                spanId: "1b5e0a1c2d3e4f50",
                startMs: 1,
                endMs: 2,
                outcome: "cancelled",
                attributes: { "tool.name": "read_file", "gen_ai.request.model": "catalog:x", path: "/home/user" },
            },
        ]) as { resourceSpans: { scopeSpans: { spans: { attributes: { key: string }[]; status: unknown }[] }[] }[] }
        const span = body.resourceSpans[0].scopeSpans[0].spans[0]
        expect(span.status).toEqual(FIXTURE.traces.status.cancelled)
        expect(span.attributes.map((attribute) => attribute.key).sort()).toEqual(["dline.outcome", "tool.name"])
    })
})

describe("production OTLP response classification", () => {
    const NOW = 1_792_800_000_000

    it.each(
        FIXTURE.responses as { name: string; status: number; body: unknown; retry_after?: string; client_action: any }[],
    )("$name", (response) => {
        const outcome = classifyOtlpResponse(
            { status: response.status, json: response.body ?? undefined, retryAfter: response.retry_after ?? null },
            NOW,
        )
        const action = response.client_action
        expect(outcome.kind).toBe(ACTION_KIND[action.kind])
        if (outcome.kind === "acknowledged") expect(outcome.nextEligibleAt).toBe(action.next_eligible_at)
        if (outcome.kind === "stop") expect(outcome.code).toBe(action.code)
        if (outcome.kind === "wait") {
            const expected = action.retry_after_ms ?? action.next_eligible_at - NOW
            expect(outcome.retryAfterMs).toBe(expected)
        }
    })
})
