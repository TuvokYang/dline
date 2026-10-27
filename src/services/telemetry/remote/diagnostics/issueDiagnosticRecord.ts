import { randomBytes } from "node:crypto"
import type { JournalTelemetrySignal, TelemetrySpanHandle, TelemetrySpanStartOptions } from "../../providers/capabilities"
import { nanos, OTLP_SCHEMA_URL, OTLP_SCOPE_VERSION } from "../contracts/otlpProduction"
import type { DiagnosticResource } from "./diagnosticRecord"
import { diagnosticOtlpResource, toDiagnosticRecord } from "./diagnosticRecord"

export type IssueDiagnosticStream = "logs" | "metrics" | "traces"
export type IssueDiagnosticAttributeValue = string | number | boolean

export type IssueDiagnosticItem =
    | {
          readonly stream: "logs"
          readonly name: string
          readonly severity: "debug" | "info"
          readonly observedAt: number
          readonly attributes: Readonly<Record<string, IssueDiagnosticAttributeValue>>
      }
    | {
          readonly stream: "metrics"
          readonly instrument: "counter" | "histogram" | "gauge"
          readonly name: string
          readonly value: number | null
          readonly observedAt: number
          readonly attributes: Readonly<Record<string, IssueDiagnosticAttributeValue>>
          readonly description?: string
      }
    | {
          readonly stream: "traces"
          readonly name: string
          readonly traceId: string
          readonly spanId: string
          readonly parentSpanId?: string
          readonly startAt: number
          readonly endAt: number
          readonly outcome: "success" | "failure" | "cancelled"
          readonly attributes: Readonly<Record<string, IssueDiagnosticAttributeValue>>
          readonly events: readonly {
              readonly name: string
              readonly observedAt: number
              readonly attributes: Readonly<Record<string, IssueDiagnosticAttributeValue>>
          }[]
      }

const NAME = /^[A-Za-z0-9_.:/-]{1,160}$/
const ATTRIBUTE_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,95}$/
const TOKEN = /^[A-Za-z0-9_.:+-]{1,96}$/
const MAX_ATTRIBUTES = 32
const MAX_EVENTS = 32
const TRACE_ID = /^[0-9a-f]{32}$/
const SPAN_ID = /^[0-9a-f]{16}$/
const SEVERITY_NUMBER = { debug: 5, info: 9 } as const
/** The issue overlay's own scope; ids, times, status and the Resource follow the production encoding (TADR §2.4). */
const ISSUE_SCOPE = { name: "dline.issue-overlay", version: OTLP_SCOPE_VERSION }

/**
 * Build one issue-only item from the canonical journal.
 *
 * Production remote diagnostics win first: any signal they already export is
 * deliberately excluded so an approved overlay adds detail without duplicating
 * the normal error/runtime channel. Usage and account channels never enter.
 */
export function toIssueDiagnosticItem(signal: JournalTelemetrySignal, now: number): IssueDiagnosticItem | undefined {
    if (signal.channel !== "error" && signal.channel !== "runtime") return undefined
    if (signal.kind === "event") {
        if (toDiagnosticRecord(signal, now)) return undefined
        if ((signal.severity !== "debug" && signal.severity !== "info") || !NAME.test(signal.name)) return undefined
        return {
            stream: "logs",
            name: signal.name,
            severity: signal.severity,
            observedAt: now,
            attributes: safeAttributes(signal.properties),
        }
    }
    if (!NAME.test(signal.name) || signal.value === null) return undefined
    if (!Number.isFinite(signal.value) || !Number.isSafeInteger(Math.trunc(signal.value * 1_000_000))) {
        return undefined
    }
    return {
        stream: "metrics",
        instrument: signal.instrument,
        name: signal.name,
        value: signal.value,
        observedAt: now,
        attributes: safeAttributes(signal.attributes),
        ...(signal.description && TOKEN.test(signal.description.replaceAll(" ", "_")) ? { description: signal.description } : {}),
    }
}

/** A bounded in-memory span whose terminal snapshot is queued by the overlay. */
export function createIssueDiagnosticSpan(
    options: TelemetrySpanStartOptions,
    enabled: () => boolean,
    publish: (item: IssueDiagnosticItem) => void,
    clock: () => number = Date.now,
): TelemetrySpanHandle {
    if (!enabled() || !NAME.test(options.name)) return INERT_SPAN
    const inheritedTraceId = options.spanContext?.traceId ?? spanContextOf(options.parent)?.traceId
    const traceId = inheritedTraceId && TRACE_ID.test(inheritedTraceId) ? inheritedTraceId : randomBytes(16).toString("hex")
    const requestedSpanId = options.spanContext?.spanId
    const spanId = requestedSpanId && SPAN_ID.test(requestedSpanId) ? requestedSpanId : randomBytes(8).toString("hex")
    const context = { traceId, spanId, traceFlags: options.spanContext?.traceFlags ?? 1 }
    const attributes: Record<string, IssueDiagnosticAttributeValue> = { ...safeAttributes(options.attributes) }
    const events: Array<{
        name: string
        observedAt: number
        attributes: Readonly<Record<string, IssueDiagnosticAttributeValue>>
    }> = []
    const startAt = options.startTime ?? clock()
    let ended = false
    return {
        active: true,
        spanContext: context,
        setAttribute(name, value) {
            if (!ended && ATTRIBUTE_KEY.test(name) && Object.keys(attributes).length < MAX_ATTRIBUTES) {
                const accepted = safeValue(value)
                if (accepted !== undefined) attributes[name] = accepted
            }
        },
        recordException(error) {
            if (ended) return
            const type = error instanceof Error ? error.name : typeof error
            if (TOKEN.test(type)) attributes["error.type"] = type
        },
        addEvent(name, values, timestamp) {
            if (ended || events.length >= MAX_EVENTS || !NAME.test(name)) return
            events.push({ name, observedAt: timestamp ?? clock(), attributes: safeAttributes(values) })
        },
        end(outcome = "success", endTime) {
            if (ended) return
            ended = true
            if (!enabled()) return
            const endAt = Math.max(startAt, endTime ?? clock())
            publish({
                stream: "traces",
                name: options.name,
                traceId,
                spanId,
                ...(options.parent?.spanContext?.spanId ? { parentSpanId: options.parent.spanContext.spanId } : {}),
                startAt,
                endAt,
                outcome,
                attributes,
                events,
            })
        },
    }
}

export function encodeIssueDiagnosticBatch(items: readonly IssueDiagnosticItem[], resource: DiagnosticResource): string {
    if (items.length === 0) throw new Error("Cannot encode an empty issue diagnostic batch")
    const stream = items[0].stream
    if (items.some((item) => item.stream !== stream)) throw new Error("Issue diagnostic batch mixes OTLP streams")
    const resourceValue = {
        attributes: [
            ...diagnosticOtlpResource(resource, 0).attributes.filter((attribute) => attribute.key !== "dline.dropped_records"),
            stringAttribute("dline.capture_scope", "issue"),
        ],
    }
    if (stream === "logs") {
        const logs = items as Extract<IssueDiagnosticItem, { stream: "logs" }>[]
        return JSON.stringify({
            resourceLogs: [
                {
                    resource: resourceValue,
                    scopeLogs: [
                        {
                            scope: ISSUE_SCOPE,
                            logRecords: logs.map((item) => ({
                                timeUnixNano: nanos(item.observedAt),
                                severityNumber: SEVERITY_NUMBER[item.severity],
                                eventName: item.name,
                                body: { stringValue: item.name },
                                attributes: Object.entries(item.attributes).map(([key, value]) => anyAttribute(key, value)),
                            })),
                            schemaUrl: OTLP_SCHEMA_URL,
                        },
                    ],
                    schemaUrl: OTLP_SCHEMA_URL,
                },
            ],
        })
    }
    if (stream === "metrics") {
        const metrics = items as Extract<IssueDiagnosticItem, { stream: "metrics" }>[]
        return JSON.stringify({
            resourceMetrics: [
                {
                    resource: resourceValue,
                    scopeMetrics: [
                        {
                            scope: ISSUE_SCOPE,
                            metrics: metrics.map((item) => metricOf(item)),
                            schemaUrl: OTLP_SCHEMA_URL,
                        },
                    ],
                    schemaUrl: OTLP_SCHEMA_URL,
                },
            ],
        })
    }
    const traces = items as Extract<IssueDiagnosticItem, { stream: "traces" }>[]
    return JSON.stringify({
        resourceSpans: [
            {
                resource: resourceValue,
                scopeSpans: [
                    {
                        scope: ISSUE_SCOPE,
                        // OTLP/JSON carries trace and span ids as lowercase hex, as the production traces do.
                        spans: traces.map((item) => ({
                            traceId: item.traceId,
                            spanId: item.spanId,
                            ...(item.parentSpanId && SPAN_ID.test(item.parentSpanId) ? { parentSpanId: item.parentSpanId } : {}),
                            name: item.name,
                            kind: 1,
                            startTimeUnixNano: nanos(item.startAt),
                            endTimeUnixNano: nanos(item.endAt),
                            attributes: Object.entries(item.attributes).map(([key, value]) => anyAttribute(key, value)),
                            events: item.events.map((event) => ({
                                timeUnixNano: nanos(event.observedAt),
                                name: event.name,
                                attributes: Object.entries(event.attributes).map(([key, value]) => anyAttribute(key, value)),
                            })),
                            // Success and cancellation stay UNSET; only a failure is ERROR (TADR §5.2).
                            status: { code: item.outcome === "failure" ? 2 : 0 },
                        })),
                        schemaUrl: OTLP_SCHEMA_URL,
                    },
                ],
                schemaUrl: OTLP_SCHEMA_URL,
            },
        ],
    })
}

function metricOf(item: Extract<IssueDiagnosticItem, { stream: "metrics" }>) {
    const point = {
        timeUnixNano: nanos(item.observedAt),
        attributes: Object.entries(item.attributes).map(([key, value]) => anyAttribute(key, value)),
        ...(item.value === null ? {} : { asDouble: item.value }),
    }
    const data =
        item.instrument === "gauge"
            ? { gauge: { dataPoints: [point] } }
            : item.instrument === "counter"
              ? { sum: { aggregationTemporality: 1, isMonotonic: false, dataPoints: [point] } }
              : {
                    histogram: {
                        aggregationTemporality: 1,
                        dataPoints: [{ ...point, count: "1", sum: item.value ?? 0, bucketCounts: ["1"] }],
                    },
                }
    return { name: item.name, ...(item.description ? { description: item.description } : {}), ...data }
}

function safeAttributes(values: Readonly<Record<string, unknown>> | undefined): Record<string, IssueDiagnosticAttributeValue> {
    const result: Record<string, IssueDiagnosticAttributeValue> = {}
    if (!values) return result
    for (const [key, value] of Object.entries(values)) {
        if (Object.keys(result).length >= MAX_ATTRIBUTES || !ATTRIBUTE_KEY.test(key) || isIdentityKey(key)) continue
        const accepted = safeValue(value)
        if (accepted !== undefined) result[key] = accepted
    }
    return result
}

function safeValue(value: unknown): IssueDiagnosticAttributeValue | undefined {
    if (typeof value === "boolean") return value
    if (typeof value === "number")
        return Number.isFinite(value) && Number.isSafeInteger(Math.trunc(value)) ? Math.trunc(value) : undefined
    return typeof value === "string" && TOKEN.test(value) ? value : undefined
}

function isIdentityKey(key: string): boolean {
    return /(^|[._-])(task|session|workspace|controller|account|user|email|path|url|token|secret|credential|prompt|content)([._-]|$)/i.test(
        key,
    )
}

function spanContextOf(handle: TelemetrySpanHandle | undefined) {
    return handle?.spanContext
}

function stringAttribute(key: string, value: string) {
    return { key, value: { stringValue: value } }
}

function intAttribute(key: string, value: number) {
    return { key, value: { intValue: String(Math.trunc(value)) } }
}

function anyAttribute(key: string, value: IssueDiagnosticAttributeValue) {
    if (typeof value === "boolean") return { key, value: { boolValue: value } }
    if (typeof value === "number") return intAttribute(key, value)
    return stringAttribute(key, value)
}

const INERT_SPAN: TelemetrySpanHandle = {
    active: false,
    setAttribute: () => undefined,
    recordException: () => undefined,
    addEvent: () => undefined,
    end: () => undefined,
}
