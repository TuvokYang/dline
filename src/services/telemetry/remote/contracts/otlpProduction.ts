/**
 * Production OTLP wire contract (telemetry-analysis-and-diagnostics-requirements
 * §2.4, §3, §5.3, §6 and §7.2): request limits, the Resource, the instrument and
 * span catalogs, the OTLP/JSON 1.5.0 encoders and the response classification.
 *
 * Every OTLP body the client sends is built here, so the production channels and
 * the issue-only overlay cannot disagree on id encoding, temporality or scopes.
 * The vendored `otlp-production-reference.json` fixture cases verify this module.
 */

import { type DeliveryOutcome, EDGE_BLOCKED, EDGE_RATE_LIMITED, type WireResponse } from "./classification"
import type { UsageHostEditor, UsageReleaseChannel } from "./usageBodySchema"
import { USAGE_SCHEMA_VERSION } from "./usageBodySchema"

/** `X-Dline-Contract` of every Dline request: `/usage`, `/auth/*` and OTLP alike (§2.4, exchange flow §8). */
export const DLINE_CONTRACT = String(USAGE_SCHEMA_VERSION)
export const OTLP_SCHEMA_URL = "https://opentelemetry.io/schemas/1.37.0"
export const OTLP_SCOPE_VERSION = "1"

export type OtlpSignal = "logs" | "metrics" | "traces"

export const OTLP_LIMITS = {
    maxBodyBytes: 131_072,
    maxLogRecords: 100,
    maxMetricPoints: 500,
    maxSpans: 200,
    maxReplays: 12,
    replayHorizonMs: 86_400_000,
} as const

/** Client admission per device; whatever exceeds it is dropped locally and counted. */
export const OTLP_ADMISSION = {
    logsPerHour: 50,
    logsPerDay: 200,
    metricsIntervalMs: 60_000,
    spansPerHour: 300,
    spansPerDay: 1_200,
} as const

export const OTLP_SCOPES = {
    diagnostics: "dline.diagnostics",
    runtime: "dline.runtime",
    tasks: "dline.tasks",
    genAi: "dline.gen_ai",
    tools: "dline.tools",
} as const
type OtlpScope = (typeof OTLP_SCOPES)[keyof typeof OTLP_SCOPES]

export type OtlpAttributeValue = string | number | boolean
export type OtlpAttributes = Readonly<Record<string, OtlpAttributeValue>>

type AnyValue =
    | { readonly stringValue: string }
    | { readonly boolValue: boolean }
    | { readonly intValue: string }
    | { readonly doubleValue: number }

export interface OtlpKeyValue {
    readonly key: string
    readonly value: AnyValue
}

// ---------------------------------------------------------------------------
// Resource (§3.1)

export interface OtlpResourceIdentity {
    readonly clientVersion: string
    /** `process.platform`. */
    readonly platform: string
    /** `process.arch`. */
    readonly arch: string
    readonly environment: "production" | "development"
    readonly releaseChannel?: UsageReleaseChannel
    readonly hostEditor?: UsageHostEditor
    readonly isDev: boolean
    readonly droppedRecords: number
}

const OS_TYPES: Readonly<Record<string, string>> = { win32: "windows", darwin: "darwin", linux: "linux" }
const HOST_ARCHES: Readonly<Record<string, string>> = { x64: "amd64", arm64: "arm64", ia32: "x86" }

/** The allowlisted Resource; a platform or architecture outside the semconv vocabulary is omitted, not guessed. */
export function buildOtlpResource(identity: OtlpResourceIdentity): { readonly attributes: readonly OtlpKeyValue[] } {
    const osType = OS_TYPES[identity.platform]
    const hostArch = HOST_ARCHES[identity.arch]
    return {
        attributes: keyValues({
            "service.name": "dline",
            "service.version": identity.clientVersion,
            ...(osType ? { "os.type": osType } : {}),
            ...(hostArch ? { "host.arch": hostArch } : {}),
            "deployment.environment.name": identity.environment,
            ...(identity.releaseChannel ? { "dline.release_channel": identity.releaseChannel } : {}),
            ...(identity.hostEditor ? { "dline.host_editor": identity.hostEditor } : {}),
            "dline.is_dev": identity.isDev,
            "dline.dropped_records": Math.max(0, Math.trunc(identity.droppedRecords)),
        }),
    }
}

// ---------------------------------------------------------------------------
// Logs (§6)

export type OtlpLogSeverity = "warn" | "error" | "fatal"

export const OTLP_LOG_SEVERITY: Readonly<Record<OtlpLogSeverity, { readonly number: number; readonly text: string }>> = {
    warn: { number: 13, text: "WARN" },
    error: { number: 17, text: "ERROR" },
    fatal: { number: 21, text: "FATAL" },
}

export interface OtlpLogRecordInput {
    readonly eventName: string
    readonly severity: OtlpLogSeverity
    readonly channel: "error" | "runtime"
    readonly occurrences: number
    readonly firstSeenMs: number
    readonly lastSeenMs: number
    readonly traceId?: string
    readonly spanId?: string
    /** Catalog attributes, already filtered by the caller's §6.3 allowlist. */
    readonly attributes: OtlpAttributes
}

export function encodeOtlpLogs(
    resource: { readonly attributes: readonly OtlpKeyValue[] },
    records: readonly OtlpLogRecordInput[],
    exportedAtMs: number,
    scope: OtlpScope = OTLP_SCOPES.diagnostics,
): object {
    return {
        resourceLogs: [
            {
                resource,
                scopeLogs: [
                    {
                        scope: scopeOf(scope),
                        logRecords: records.map((record) => encodeLogRecord(record, exportedAtMs)),
                        schemaUrl: OTLP_SCHEMA_URL,
                    },
                ],
                schemaUrl: OTLP_SCHEMA_URL,
            },
        ],
    }
}

function encodeLogRecord(record: OtlpLogRecordInput, exportedAtMs: number): object {
    const severity = OTLP_LOG_SEVERITY[record.severity]
    const context = isTraceId(record.traceId) && isSpanId(record.spanId) ? record : undefined
    return {
        timeUnixNano: nanos(record.firstSeenMs),
        observedTimeUnixNano: nanos(exportedAtMs),
        severityNumber: severity.number,
        severityText: severity.text,
        eventName: record.eventName,
        body: { stringValue: record.eventName },
        attributes: keyValues({
            "dline.channel": record.channel,
            "dline.occurrences": record.occurrences,
            "dline.first_seen_ms": record.firstSeenMs,
            "dline.last_seen_ms": record.lastSeenMs,
            ...record.attributes,
        }),
        ...(context ? { flags: 1, traceId: context.traceId, spanId: context.spanId } : {}),
    }
}

// ---------------------------------------------------------------------------
// Metrics (§7.2)

export const GEN_AI_OPERATION_DURATION_BOUNDS: readonly number[] = [
    0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
]

interface MetricDescriptorBase {
    readonly name: string
    readonly scope: OtlpScope
    readonly unit: string
    readonly description: string
    readonly attributes: readonly string[]
}

export type OtlpMetricDescriptor =
    | (MetricDescriptorBase & { readonly type: "sum"; readonly monotonic: true })
    | (MetricDescriptorBase & { readonly type: "gauge" })
    | (MetricDescriptorBase & { readonly type: "histogram"; readonly explicitBounds: readonly number[] })

export const OTLP_METRIC_CATALOG: readonly OtlpMetricDescriptor[] = [
    {
        name: "dline.session.started",
        scope: OTLP_SCOPES.runtime,
        type: "sum",
        monotonic: true,
        unit: "{session}",
        description: "Extension host sessions started.",
        attributes: [],
    },
    {
        name: "dline.runtime.event_loop.delay",
        scope: OTLP_SCOPES.runtime,
        type: "gauge",
        unit: "s",
        description: "Largest event loop delay observed in the export window.",
        attributes: [],
    },
    {
        name: "dline.runtime.cpu.utilization",
        scope: OTLP_SCOPES.runtime,
        type: "gauge",
        unit: "1",
        description: "Largest process CPU utilization observed in the export window.",
        attributes: [],
    },
    {
        name: "dline.runtime.heap.growth",
        scope: OTLP_SCOPES.runtime,
        type: "gauge",
        unit: "By",
        description: "Heap growth over the trailing minute at the end of the export window.",
        attributes: [],
    },
    {
        name: "dline.telemetry.dropped.records",
        scope: OTLP_SCOPES.runtime,
        type: "sum",
        monotonic: true,
        unit: "{record}",
        description: "Diagnostic records dropped by the client before delivery.",
        attributes: ["dline.channel"],
    },
    {
        name: "gen_ai.client.operation.duration",
        scope: OTLP_SCOPES.genAi,
        type: "histogram",
        unit: "s",
        description: "Duration of one Provider send.",
        explicitBounds: GEN_AI_OPERATION_DURATION_BOUNDS,
        attributes: [
            "gen_ai.operation.name",
            "gen_ai.provider.name",
            "gen_ai.request.model",
            "dline.role",
            "dline.outcome",
            "error.type",
        ],
    },
]

export interface OtlpHistogramValue {
    readonly count: number
    readonly sum: number
    readonly min: number
    readonly max: number
    /** One count per bucket, `explicitBounds.length + 1` entries. */
    readonly bucketCounts: readonly number[]
}

export type OtlpMetricPoint =
    | { readonly name: string; readonly attributes: OtlpAttributes; readonly value: number }
    | { readonly name: string; readonly attributes: OtlpAttributes; readonly histogram: OtlpHistogramValue }

/** Bucket of `value` under OTLP explicit-bounds semantics: bucket `i` holds `(bounds[i-1], bounds[i]]`. */
export function histogramBucketIndex(bounds: readonly number[], value: number): number {
    const index = bounds.findIndex((bound) => value <= bound)
    return index === -1 ? bounds.length : index
}

/** One export window; instruments without a point are omitted rather than sent as zero. */
export function encodeOtlpMetrics(
    resource: { readonly attributes: readonly OtlpKeyValue[] },
    window: { readonly startMs: number; readonly endMs: number },
    points: readonly OtlpMetricPoint[],
): object {
    const scopeMetrics: object[] = []
    for (const scope of distinctScopes(OTLP_METRIC_CATALOG)) {
        const metrics = OTLP_METRIC_CATALOG.filter((descriptor) => descriptor.scope === scope).flatMap((descriptor) => {
            const own = points.filter((point) => point.name === descriptor.name)
            return own.length === 0 ? [] : [encodeMetric(descriptor, own, window)]
        })
        if (metrics.length > 0) scopeMetrics.push({ scope: scopeOf(scope), metrics, schemaUrl: OTLP_SCHEMA_URL })
    }
    return { resourceMetrics: [{ resource, scopeMetrics, schemaUrl: OTLP_SCHEMA_URL }] }
}

function encodeMetric(
    descriptor: OtlpMetricDescriptor,
    points: readonly OtlpMetricPoint[],
    window: { readonly startMs: number; readonly endMs: number },
): object {
    const head = { name: descriptor.name, unit: descriptor.unit, description: descriptor.description }
    const attributesOf = (point: OtlpMetricPoint) => keyValues(pick(point.attributes, descriptor.attributes))
    const interval = { startTimeUnixNano: nanos(window.startMs), timeUnixNano: nanos(window.endMs) }
    switch (descriptor.type) {
        case "sum":
            return {
                ...head,
                sum: {
                    aggregationTemporality: 1,
                    isMonotonic: true,
                    dataPoints: points.map((point) => ({
                        ...interval,
                        asInt: String(Math.trunc("value" in point ? point.value : 0)),
                        attributes: attributesOf(point),
                    })),
                },
            }
        case "gauge":
            return {
                ...head,
                gauge: {
                    dataPoints: points.map((point) => ({
                        timeUnixNano: nanos(window.endMs),
                        asDouble: "value" in point ? point.value : 0,
                        attributes: attributesOf(point),
                    })),
                },
            }
        case "histogram":
            return {
                ...head,
                histogram: {
                    aggregationTemporality: 1,
                    dataPoints: points.flatMap((point) =>
                        "histogram" in point
                            ? [
                                  {
                                      ...interval,
                                      count: String(point.histogram.count),
                                      sum: point.histogram.sum,
                                      min: point.histogram.min,
                                      max: point.histogram.max,
                                      bucketCounts: point.histogram.bucketCounts.map(String),
                                      explicitBounds: [...descriptor.explicitBounds],
                                      attributes: attributesOf(point),
                                  },
                              ]
                            : [],
                    ),
                },
            }
    }
}

// ---------------------------------------------------------------------------
// Traces (§5.3)

export type OtlpSpanOutcome = "success" | "failure" | "cancelled"
export type OtlpSpanName = "dline.task" | "gen_ai.client.operation" | "dline.tool.execute"

interface SpanDescriptor {
    readonly name: OtlpSpanName
    readonly scope: OtlpScope
    readonly kind: 1 | 3
    readonly attributes: readonly string[]
    readonly fixed?: OtlpAttributes
}

export const OTLP_SPAN_CATALOG: readonly SpanDescriptor[] = [
    { name: "dline.task", scope: OTLP_SCOPES.tasks, kind: 1, attributes: ["dline.role", "dline.outcome"] },
    {
        name: "gen_ai.client.operation",
        scope: OTLP_SCOPES.genAi,
        kind: 3,
        attributes: [
            "gen_ai.operation.name",
            "gen_ai.provider.name",
            "gen_ai.request.model",
            "dline.role",
            "dline.outcome",
            "error.type",
            "retry.attempt",
            "dline.attempt_observation_id",
            "dline.logical_request_id",
        ],
        fixed: { "gen_ai.operation.name": "chat" },
    },
    {
        name: "dline.tool.execute",
        scope: OTLP_SCOPES.tools,
        kind: 1,
        attributes: ["tool.name", "dline.outcome", "error.type", "failure.stage"],
    },
]

export interface OtlpSpanInput {
    readonly name: OtlpSpanName
    readonly traceId: string
    readonly spanId: string
    readonly parentSpanId?: string
    readonly startMs: number
    readonly endMs: number
    readonly outcome: OtlpSpanOutcome
    readonly attributes: OtlpAttributes
}

export function isOtlpSpanName(value: string): value is OtlpSpanName {
    return OTLP_SPAN_CATALOG.some((descriptor) => descriptor.name === value)
}

export function encodeOtlpTraces(
    resource: { readonly attributes: readonly OtlpKeyValue[] },
    spans: readonly OtlpSpanInput[],
): object {
    const scopeSpans: object[] = []
    for (const scope of distinctScopes(OTLP_SPAN_CATALOG)) {
        const descriptors = OTLP_SPAN_CATALOG.filter((descriptor) => descriptor.scope === scope)
        const encoded = spans.flatMap((span) => {
            const descriptor = descriptors.find((candidate) => candidate.name === span.name)
            return descriptor ? [encodeSpan(descriptor, span)] : []
        })
        if (encoded.length > 0) scopeSpans.push({ scope: scopeOf(scope), spans: encoded, schemaUrl: OTLP_SCHEMA_URL })
    }
    return { resourceSpans: [{ resource, scopeSpans, schemaUrl: OTLP_SCHEMA_URL }] }
}

function encodeSpan(descriptor: SpanDescriptor, span: OtlpSpanInput): object {
    const attributes = pick({ ...descriptor.fixed, ...span.attributes, "dline.outcome": span.outcome }, descriptor.attributes)
    return {
        traceId: span.traceId,
        spanId: span.spanId,
        ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
        name: span.name,
        kind: descriptor.kind,
        startTimeUnixNano: nanos(span.startMs),
        endTimeUnixNano: nanos(Math.max(span.startMs, span.endMs)),
        attributes: keyValues(attributes),
        // Success and cancellation stay UNSET; only a failure is ERROR (§5.2).
        status: { code: span.outcome === "failure" ? 2 : 0 },
    }
}

// ---------------------------------------------------------------------------
// Responses (§2.4)

const OTLP_DISPOSITIONS = ["accepted", "duplicate", "ignored_version"] as const

/**
 * Classify a `/v1/logs|metrics|traces` response.
 *
 * Only `ok:true` with a known disposition and `next_eligible_at` confirms the
 * batch; any other 200 is an unknown result and replays the same bytes. A wait
 * names its end in the body (`next_eligible_at`, then `retry_after_ms`), which
 * wins over `Retry-After`.
 */
export function classifyOtlpResponse(response: WireResponse, now = Date.now()): DeliveryOutcome {
    const { status } = response
    const body = isRecord(response.json) ? response.json : undefined
    if (status === 200) {
        const disposition = OTLP_DISPOSITIONS.find((value) => value === body?.disposition)
        const next = body?.next_eligible_at
        if (body?.ok !== true || !disposition || !isCount(next)) return { kind: "replay" }
        return { kind: "acknowledged", disposition, nextEligibleAt: next }
    }
    const error = isRecord(body?.error) ? body.error : undefined
    const code = typeof error?.code === "string" && error.code.length > 0 ? error.code : undefined
    const delay = waitDelay(body, error, response.retryAfter, now)
    if (status === 401) return { kind: "refresh_token" }
    if (status === 403) return { kind: "stop", scope: "profile", code: body ? (code ?? "forbidden") : EDGE_BLOCKED }
    if (status === 429) return { kind: "wait", code: code ?? EDGE_RATE_LIMITED, ...delay }
    if (status === 413) return { kind: "too_large" }
    if (status === 408 || status >= 500) return { kind: "replay", ...delay }
    if (status >= 400) return { kind: "discard", code: code ?? `http_${status}` }
    return { kind: "replay", ...delay }
}

function waitDelay(
    body: Record<string, unknown> | undefined,
    error: Record<string, unknown> | undefined,
    retryAfter: string | null,
    now: number,
): { readonly retryAfterMs?: number } {
    const next = body?.next_eligible_at
    if (isCount(next)) return { retryAfterMs: Math.max(0, next - now) }
    const bodyDelay = error?.retry_after_ms ?? body?.retry_after_ms
    if (isCount(bodyDelay)) return { retryAfterMs: bodyDelay }
    if (retryAfter && /^\d+$/u.test(retryAfter.trim())) return { retryAfterMs: Number(retryAfter.trim()) * 1_000 }
    return {}
}

// ---------------------------------------------------------------------------
// Shared encoding

/** Epoch milliseconds as the OTLP/JSON decimal string of nanoseconds. */
export function nanos(epochMs: number): string {
    return (BigInt(Math.max(0, Math.trunc(epochMs))) * 1_000_000n).toString()
}

const TRACE_ID = /^[0-9a-f]{32}$/u
const SPAN_ID = /^[0-9a-f]{16}$/u
const ZERO_TRACE_ID = "0".repeat(32)
const ZERO_SPAN_ID = "0".repeat(16)

export function isTraceId(value: unknown): value is string {
    return typeof value === "string" && TRACE_ID.test(value) && value !== ZERO_TRACE_ID
}

export function isSpanId(value: unknown): value is string {
    return typeof value === "string" && SPAN_ID.test(value) && value !== ZERO_SPAN_ID
}

export function keyValues(attributes: OtlpAttributes): OtlpKeyValue[] {
    return Object.entries(attributes).map(([key, value]) => ({ key, value: anyValue(value) }))
}

function anyValue(value: OtlpAttributeValue): AnyValue {
    if (typeof value === "string") return { stringValue: value }
    if (typeof value === "boolean") return { boolValue: value }
    return Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value }
}

function scopeOf(name: OtlpScope): { readonly name: string; readonly version: string } {
    return { name, version: OTLP_SCOPE_VERSION }
}

function distinctScopes(descriptors: readonly { readonly scope: OtlpScope }[]): OtlpScope[] {
    return [...new Set(descriptors.map((descriptor) => descriptor.scope))]
}

function pick(attributes: OtlpAttributes, allowed: readonly string[]): Record<string, OtlpAttributeValue> {
    const picked: Record<string, OtlpAttributeValue> = {}
    for (const key of allowed) {
        const value = attributes[key]
        if (value !== undefined) picked[key] = value
    }
    return picked
}

function isCount(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
