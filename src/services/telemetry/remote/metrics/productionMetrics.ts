import type { JournalTelemetrySignal } from "../../providers/capabilities"
import {
    GEN_AI_OPERATION_DURATION_BOUNDS,
    histogramBucketIndex,
    type OtlpAttributes,
    type OtlpHistogramValue,
    type OtlpMetricPoint,
    type OtlpSpanInput,
} from "../contracts/otlpProduction"

/** The channels whose local drops `dline.telemetry.dropped.records` counts (TADR §7.2). */
export type DroppedChannel = "logs" | "metrics" | "traces"

/** One frozen delta window: what the metrics outbox queues and what one request carries (TADR §7.2). */
export interface MetricsWindow {
    readonly startMs: number
    readonly endMs: number
    readonly points: readonly OtlpMetricPoint[]
}

/** The runtime gauges the sampler publishes, by pipeline name. */
const RUNTIME_GAUGES = {
    eventLoopDelayMs: "runtime.event_loop_delay_ms",
    cpuUtilizationRatio: "runtime.cpu_utilization_ratio",
    heapGrowthBytes: "runtime.heap_growth_bytes",
} as const

interface MutableHistogram {
    readonly attributes: OtlpAttributes
    count: number
    sum: number
    min: number
    max: number
    readonly bucketCounts: number[]
}

/**
 * The production instruments of one export window (TADR §7.2), aggregated in
 * memory as deltas. An instrument with no data in the window is omitted, never
 * sent as zero, so a window without any data freezes to nothing.
 */
export class ProductionMetricsWindow {
    private sessionsStarted = 0
    private eventLoopDelayMs: number | undefined
    private cpuUtilizationRatio: number | undefined
    private heapGrowthBytes: number | undefined
    private readonly dropped = new Map<DroppedChannel, number>()
    private readonly operations = new Map<string, MutableHistogram>()

    constructor(private startMs: number) {}

    recordSessionStarted(): void {
        this.sessionsStarted++
    }

    /** Take the runtime sampler's gauges: the largest delay and CPU use of the window, the last heap growth. */
    observe(signal: JournalTelemetrySignal): void {
        if (signal.kind !== "metric" || signal.instrument !== "gauge" || !isNonNegative(signal.value)) return
        switch (signal.name) {
            case RUNTIME_GAUGES.eventLoopDelayMs:
                this.eventLoopDelayMs = Math.max(this.eventLoopDelayMs ?? 0, signal.value)
                return
            case RUNTIME_GAUGES.cpuUtilizationRatio:
                this.cpuUtilizationRatio = Math.max(this.cpuUtilizationRatio ?? 0, signal.value)
                return
            case RUNTIME_GAUGES.heapGrowthBytes:
                this.heapGrowthBytes = signal.value
                return
        }
    }

    recordDropped(channel: DroppedChannel, count: number): void {
        if (!Number.isSafeInteger(count) || count <= 0) return
        this.dropped.set(channel, (this.dropped.get(channel) ?? 0) + count)
    }

    /** One finished Provider send becomes one `gen_ai.client.operation.duration` observation. */
    recordOperation(span: OtlpSpanInput): void {
        if (span.name !== "gen_ai.client.operation") return
        const attributes = operationAttributes(span)
        const key = JSON.stringify(Object.entries(attributes).sort(([left], [right]) => left.localeCompare(right)))
        const seconds = Math.max(0, span.endMs - span.startMs) / 1_000
        const histogram = this.operations.get(key) ?? {
            attributes,
            count: 0,
            sum: 0,
            min: seconds,
            max: seconds,
            bucketCounts: new Array<number>(GEN_AI_OPERATION_DURATION_BOUNDS.length + 1).fill(0),
        }
        histogram.count++
        histogram.sum += seconds
        histogram.min = Math.min(histogram.min, seconds)
        histogram.max = Math.max(histogram.max, seconds)
        histogram.bucketCounts[histogramBucketIndex(GEN_AI_OPERATION_DURATION_BOUNDS, seconds)]++
        this.operations.set(key, histogram)
    }

    /** End the window at `endMs` and start the next one there; undefined when the window held nothing. */
    freeze(endMs: number): MetricsWindow | undefined {
        const points = this.points()
        const window = { startMs: this.startMs, endMs: Math.max(this.startMs, endMs), points }
        this.reset(window.endMs)
        return points.length > 0 ? window : undefined
    }

    private points(): OtlpMetricPoint[] {
        const points: OtlpMetricPoint[] = []
        if (this.sessionsStarted > 0) points.push({ name: "dline.session.started", attributes: {}, value: this.sessionsStarted })
        if (this.eventLoopDelayMs !== undefined)
            points.push({ name: "dline.runtime.event_loop.delay", attributes: {}, value: this.eventLoopDelayMs / 1_000 })
        if (this.cpuUtilizationRatio !== undefined)
            points.push({ name: "dline.runtime.cpu.utilization", attributes: {}, value: this.cpuUtilizationRatio })
        if (this.heapGrowthBytes !== undefined)
            points.push({ name: "dline.runtime.heap.growth", attributes: {}, value: this.heapGrowthBytes })
        for (const [channel, count] of this.dropped)
            points.push({ name: "dline.telemetry.dropped.records", attributes: { "dline.channel": channel }, value: count })
        for (const histogram of this.operations.values()) {
            const value: OtlpHistogramValue = {
                count: histogram.count,
                sum: histogram.sum,
                min: histogram.min,
                max: histogram.max,
                bucketCounts: [...histogram.bucketCounts],
            }
            points.push({ name: "gen_ai.client.operation.duration", attributes: histogram.attributes, histogram: value })
        }
        return points
    }

    private reset(startMs: number): void {
        this.startMs = startMs
        this.sessionsStarted = 0
        this.eventLoopDelayMs = undefined
        this.cpuUtilizationRatio = undefined
        this.heapGrowthBytes = undefined
        this.dropped.clear()
        this.operations.clear()
    }
}

/** The histogram attributes of a send; `error.type` only on a failure (TADR §7.2). */
function operationAttributes(span: OtlpSpanInput): OtlpAttributes {
    const { attributes } = span
    const errorType = attributes["error.type"]
    return {
        "gen_ai.operation.name": "chat",
        ...pickString(attributes, "gen_ai.provider.name"),
        ...pickString(attributes, "gen_ai.request.model"),
        ...pickString(attributes, "dline.role"),
        "dline.outcome": span.outcome,
        ...(span.outcome === "failure" && typeof errorType === "string" ? { "error.type": errorType } : {}),
    }
}

function pickString(attributes: OtlpAttributes, key: string): OtlpAttributes {
    const value = attributes[key]
    return typeof value === "string" ? { [key]: value } : {}
}

/** Validates a stored window, so a damaged outbox document is read as unusable rather than sent. */
export function isMetricsWindow(value: unknown): value is MetricsWindow {
    return (
        isRecord(value) &&
        isCount(value.startMs) &&
        isCount(value.endMs) &&
        Array.isArray(value.points) &&
        value.points.every(isMetricPoint)
    )
}

function isMetricPoint(value: unknown): boolean {
    if (!isRecord(value) || typeof value.name !== "string" || !isRecord(value.attributes)) return false
    if (typeof value.value === "number") return Number.isFinite(value.value)
    const histogram = value.histogram
    return (
        isRecord(histogram) &&
        isCount(histogram.count) &&
        typeof histogram.sum === "number" &&
        typeof histogram.min === "number" &&
        typeof histogram.max === "number" &&
        Array.isArray(histogram.bucketCounts) &&
        histogram.bucketCounts.every(isCount)
    )
}

function isNonNegative(value: number | null): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function isCount(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
