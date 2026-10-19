import {
    USAGE_ERROR_CLASSES,
    USAGE_PURPOSES,
    type UsageErrorClass,
    type UsagePurpose,
    type UsageServedModel,
    type UsageSettlement,
} from "@/core/task/telemetry/UsageSettlement"
import {
    isConsistentHistogram,
    USAGE_HISTOGRAM_BOUNDS_MS,
    USAGE_MAX_METRIC_NAME_LENGTH,
    USAGE_MAX_METRIC_NAMES,
    type UsageHistogramWire,
    type UsageMeasurementWire,
} from "../contracts/wire"

/**
 * The remote usage catalog (WS-098 spec §10, extended by the WS-108 otel contract).
 *
 * Fixed names split by purpose and outcome carry the totals. A second, open family
 * describes the same requests by the provider and model that served them
 * (`dline.usage.model.<provider>.<metric>.<model>`), and a third counts failures and
 * retries per provider.
 */
export interface UsageObservation {
    readonly counters: Readonly<Record<string, number>>
    readonly measurements: Readonly<Record<string, UsageMeasurementWire>>
    /** Absent in records written before histograms existed. */
    readonly histograms?: Readonly<Record<string, UsageHistogramWire>>
}

interface MutableObservation {
    readonly counters: Record<string, number>
    readonly measurements: Record<string, UsageMeasurementWire>
    readonly histograms: Record<string, UsageHistogramWire>
}

export function usageMetricNames(purpose: UsagePurpose) {
    return {
        input: `dline.usage.tokens.input.${purpose}`,
        output: `dline.usage.tokens.output.${purpose}`,
        cacheRead: `dline.usage.tokens.cache_read.${purpose}`,
        cacheWrite: `dline.usage.tokens.cache_write.${purpose}`,
        duration: `dline.usage.request_duration_ms.${purpose}`,
    } as const
}

export function requestCounterName(purpose: UsagePurpose, outcome: UsageSettlement["outcome"]): string {
    return `dline.usage.requests.${purpose}.${outcome}`
}

/** Counted once per extension activation, so a device that never calls a model still reports activity. */
export const SESSION_STARTED_COUNTER = "dline.usage.session.started"

const MODEL_METRIC_PREFIX = "dline.usage.model."
const MODEL_COUNTERS = [
    "requests",
    "tokens_input",
    "tokens_output",
    "tokens_cache_read",
    "tokens_cache_write",
    "tokens_reasoning",
    "requests_failed",
    "requests_cancelled",
] as const
/** Each timed metric travels as a measurement and as a histogram of the same name. */
const MODEL_TIMINGS = ["request_duration_ms", "ttft_ms", "generation_ms"] as const
type ModelCounter = (typeof MODEL_COUNTERS)[number]
type ModelTiming = (typeof MODEL_TIMINGS)[number]
type ModelMetric = ModelCounter | ModelTiming
const MODEL_METRICS: readonly ModelMetric[] = [...MODEL_COUNTERS, ...MODEL_TIMINGS]
/** The most names one model can use: every counter, plus a measurement and a histogram per timing. */
const MODEL_NAME_BUDGET = MODEL_COUNTERS.length + MODEL_TIMINGS.length * 2
const LONGEST_MODEL_METRIC = Math.max(...MODEL_METRICS.map((metric) => metric.length))
const MAX_PROVIDER_SEGMENT = 32
/** Stands in for every model folded away when a batch would exceed the name limit. */
const OVERFLOW_SEGMENT = "_other"
/** Stands in for every custom model, whose own ID never leaves the machine. */
export const CUSTOM_MODEL_SEGMENT = "_custom"

/** A provider and model reduced to the characters a metric name allows. */
export interface UsageModelSegments {
    readonly provider: string
    readonly model: string
}

/**
 * The provider and model segments every per-model name of a request uses. Diagnostics
 * reuse them so an error names its model exactly as usage does.
 *
 * The model comes last so it may keep its dots: the service reads the provider and
 * metric from fixed positions and the model from the rest. Every metric of one model is
 * cut to the same length, so the key never differs between them.
 */
export function usageModelSegments(servedBy: UsageServedModel): UsageModelSegments {
    const provider = providerSegment(servedBy.provider)
    if (servedBy.custom) return { provider, model: CUSTOM_MODEL_SEGMENT }
    const room = USAGE_MAX_METRIC_NAME_LENGTH - MODEL_METRIC_PREFIX.length - provider.length - LONGEST_MODEL_METRIC - 2
    return { provider, model: nameSegment(servedBy.model, /[^a-z0-9_.-]+/g, room) }
}

function providerSegment(provider: string): string {
    return nameSegment(provider, /[^a-z0-9_-]+/g, MAX_PROVIDER_SEGMENT)
}

function nameSegment(value: string, disallowed: RegExp, maxLength: number): string {
    const segment = value.trim().toLowerCase().replace(disallowed, "_").slice(0, maxLength)
    return segment.length > 0 ? segment : "unknown"
}

function modelMetricName(key: UsageModelSegments, metric: ModelMetric): string {
    return `${MODEL_METRIC_PREFIX}${key.provider}.${metric}.${key.model}`
}

function parseModelMetricName(name: string): { readonly key: UsageModelSegments; readonly metric: ModelMetric } | undefined {
    if (!name.startsWith(MODEL_METRIC_PREFIX)) return undefined
    const rest = name.slice(MODEL_METRIC_PREFIX.length)
    const providerEnd = rest.indexOf(".")
    const metricEnd = rest.indexOf(".", providerEnd + 1)
    if (providerEnd <= 0 || metricEnd <= providerEnd) return undefined
    const metric = rest.slice(providerEnd + 1, metricEnd) as ModelMetric
    if (!MODEL_METRICS.includes(metric)) return undefined
    return { key: { provider: rest.slice(0, providerEnd), model: rest.slice(metricEnd + 1) }, metric }
}

/** Project one settled request onto the catalog; zero counts are omitted to keep batches sparse. */
export function projectUsageSettlement(settlement: UsageSettlement): UsageObservation {
    const purpose = catalogPurpose(settlement.purpose)
    const names = usageMetricNames(purpose)
    const target: MutableObservation = {
        counters: { [requestCounterName(purpose, settlement.outcome)]: 1 },
        measurements: {},
        histograms: {},
    }
    addCount(target.counters, names.input, settlement.inputTokens)
    addCount(target.counters, names.output, settlement.outputTokens)
    addCount(target.counters, names.cacheRead, settlement.cacheReadTokens)
    addCount(target.counters, names.cacheWrite, settlement.cacheWriteTokens)
    const duration = milliseconds(settlement.durationMs)
    target.measurements[names.duration] = summarize([duration])
    if (settlement.servedBy) projectServedModel(settlement, settlement.servedBy, duration, target)
    projectProviderReliability(settlement, target)
    return target
}

/** The observation one extension activation contributes. */
export function sessionStartedObservation(): UsageObservation {
    return { counters: { [SESSION_STARTED_COUNTER]: 1 }, measurements: {}, histograms: {} }
}

function projectServedModel(
    settlement: UsageSettlement,
    servedBy: UsageServedModel,
    duration: number,
    target: MutableObservation,
): void {
    const key = usageModelSegments(servedBy)
    const name = (metric: ModelMetric) => modelMetricName(key, metric)
    target.counters[name("requests")] = 1
    addCount(target.counters, name("tokens_input"), settlement.inputTokens)
    addCount(target.counters, name("tokens_output"), settlement.outputTokens)
    addCount(target.counters, name("tokens_cache_read"), settlement.cacheReadTokens)
    addCount(target.counters, name("tokens_cache_write"), settlement.cacheWriteTokens)
    if (settlement.reasoningTokens !== undefined) addCount(target.counters, name("tokens_reasoning"), settlement.reasoningTokens)
    if (settlement.outcome === "failed") target.counters[name("requests_failed")] = 1
    if (settlement.outcome === "cancelled") target.counters[name("requests_cancelled")] = 1
    addTiming(target, name("request_duration_ms"), duration)
    if (settlement.streamTiming) {
        addTiming(target, name("ttft_ms"), milliseconds(settlement.streamTiming.ttftMs))
        addTiming(target, name("generation_ms"), milliseconds(settlement.streamTiming.generationMs))
    }
}

/** Failures are counted once per failed request; retries count every attempt that was followed by another. */
function projectProviderReliability(settlement: UsageSettlement, target: MutableObservation): void {
    const provider = providerSegment(settlement.servedBy?.provider ?? "")
    if (settlement.outcome === "failed") {
        target.counters[`dline.usage.errors.${provider}.${catalogErrorClass(settlement.failureClass)}`] = 1
    }
    const waits = settlement.retries?.waitsMs ?? []
    if (waits.length === 0) return
    target.counters[`dline.usage.retries.${provider}`] = waits.length
    target.measurements[`dline.usage.retry_wait_ms.${provider}`] = summarize(waits.map(milliseconds))
}

function catalogErrorClass(errorClass: UsageErrorClass | undefined): UsageErrorClass {
    return errorClass && (USAGE_ERROR_CLASSES as readonly string[]).includes(errorClass) ? errorClass : "other"
}

function addTiming(target: MutableObservation, name: string, value: number): void {
    target.measurements[name] = summarize([value])
    target.histograms[name] = histogramOf(value)
}

function milliseconds(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

function summarize(values: readonly number[]): UsageMeasurementWire {
    const sum = values.reduce((total, value) => total + value, 0)
    return { count: values.length, sum, min: Math.min(...values), max: Math.max(...values) }
}

/** One sample in the first bucket whose upper bound holds it; the last bucket holds what exceeds every bound. */
function histogramOf(value: number): UsageHistogramWire {
    const counts = new Array<number>(USAGE_HISTOGRAM_BOUNDS_MS.length + 1).fill(0)
    const bucket = USAGE_HISTOGRAM_BOUNDS_MS.findIndex((bound) => value <= bound)
    counts[bucket === -1 ? USAGE_HISTOGRAM_BOUNDS_MS.length : bucket] = 1
    return { bounds: USAGE_HISTOGRAM_BOUNDS_MS, counts }
}

/** Summaries merge mathematically so `min*count <= sum <= max*count` still holds for the server's check. */
export function mergeMeasurement(left: UsageMeasurementWire | undefined, right: UsageMeasurementWire): UsageMeasurementWire {
    if (!left) return right
    return {
        count: left.count + right.count,
        sum: left.sum + right.sum,
        min: Math.min(left.min, right.min),
        max: Math.max(left.max, right.max),
    }
}

export function mergeHistogram(left: UsageHistogramWire | undefined, right: UsageHistogramWire): UsageHistogramWire {
    if (!left) return right
    return { bounds: right.bounds, counts: right.counts.map((count, index) => count + (left.counts[index] ?? 0)) }
}

function addSaturating(counters: Record<string, number>, name: string, value: number): void {
    counters[name] = Math.min(Number.MAX_SAFE_INTEGER, (counters[name] ?? 0) + value)
}

interface ModelEntry {
    readonly key: UsageModelSegments
    readonly counters: Partial<Record<ModelMetric, number>>
    readonly measurements: Partial<Record<ModelMetric, UsageMeasurementWire>>
    readonly histograms: Partial<Record<ModelMetric, UsageHistogramWire>>
}

function nameCountOf(observation: UsageObservation): number {
    return (
        Object.keys(observation.counters).length +
        Object.keys(observation.measurements).length +
        Object.keys(observation.histograms ?? {}).length
    )
}

/**
 * Keep a batch within the server's name limit.
 *
 * Only the per-model family can grow without bound. When it would push the batch over
 * the limit, the most requested models keep their names and the rest are merged into
 * one overflow model — counters summed, measurements and histograms merged — so every
 * count and every sample still arrives.
 */
export function fitMetricNameLimit(observation: UsageObservation, limit = USAGE_MAX_METRIC_NAMES): UsageObservation {
    if (nameCountOf(observation) <= limit) return observation
    const fitted: MutableObservation = { counters: {}, measurements: {}, histograms: {} }
    const models = new Map<string, ModelEntry>()
    const entryFor = (key: UsageModelSegments): ModelEntry => {
        const id = `${key.provider}.${key.model}`
        const entry = models.get(id) ?? { key, counters: {}, measurements: {}, histograms: {} }
        models.set(id, entry)
        return entry
    }
    for (const [name, value] of Object.entries(observation.counters)) {
        const parsed = parseModelMetricName(name)
        if (parsed) entryFor(parsed.key).counters[parsed.metric] = value
        else fitted.counters[name] = value
    }
    for (const [name, value] of Object.entries(observation.measurements)) {
        const parsed = parseModelMetricName(name)
        if (parsed) entryFor(parsed.key).measurements[parsed.metric] = value
        else fitted.measurements[name] = value
    }
    for (const [name, value] of Object.entries(observation.histograms ?? {})) {
        const parsed = parseModelMetricName(name)
        if (parsed) entryFor(parsed.key).histograms[parsed.metric] = value
        else fitted.histograms[name] = value
    }
    const room = limit - nameCountOf(fitted) - MODEL_NAME_BUDGET
    const ranked = [...models.entries()].sort(
        ([leftId, left], [rightId, right]) =>
            (right.counters.requests ?? 0) - (left.counters.requests ?? 0) || leftId.localeCompare(rightId),
    )
    const overflow: UsageModelSegments = { provider: OVERFLOW_SEGMENT, model: OVERFLOW_SEGMENT }
    let used = 0
    for (const [, entry] of ranked) {
        const size =
            Object.keys(entry.counters).length + Object.keys(entry.measurements).length + Object.keys(entry.histograms).length
        const target = used + size <= room ? entry.key : overflow
        if (target === entry.key) used += size
        for (const [metric, value] of Object.entries(entry.counters) as [ModelMetric, number][]) {
            addSaturating(fitted.counters, modelMetricName(target, metric), value)
        }
        for (const [metric, value] of Object.entries(entry.measurements) as [ModelMetric, UsageMeasurementWire][]) {
            const name = modelMetricName(target, metric)
            fitted.measurements[name] = mergeMeasurement(fitted.measurements[name], value)
        }
        for (const [metric, value] of Object.entries(entry.histograms) as [ModelMetric, UsageHistogramWire][]) {
            const name = modelMetricName(target, metric)
            fitted.histograms[name] = mergeHistogram(fitted.histograms[name], value)
        }
    }
    return fitted
}

/** A purpose this build does not know is reported as `other` rather than inventing a name. */
function catalogPurpose(purpose: string): UsagePurpose {
    return (USAGE_PURPOSES as readonly string[]).includes(purpose) ? (purpose as UsagePurpose) : "other"
}

function addCount(counters: Record<string, number>, name: string, value: number): void {
    const count = Math.round(value)
    if (Number.isSafeInteger(count) && count > 0) counters[name] = count
}

/**
 * Read the counters, summaries and histograms of a persisted observation or window. Any
 * value the server would refuse makes the whole record unreadable, so a damaged record
 * is skipped instead of poisoning the batch it would join. Records written before
 * histograms existed have none, which is valid.
 */
export function parseUsageObservation(value: unknown): UsageObservation | undefined {
    if (!isRecord(value) || !isRecord(value.counters) || !isRecord(value.measurements)) return undefined
    const counters = value.counters
    if (!Object.values(counters).every((entry) => Number.isSafeInteger(entry) && (entry as number) >= 0)) return undefined
    const measurements: Record<string, UsageMeasurementWire> = {}
    for (const [name, entry] of Object.entries(value.measurements)) {
        if (!isRecord(entry)) return undefined
        const { count, sum, min, max } = entry
        if (!Number.isSafeInteger(count) || (count as number) < 1) return undefined
        if (![sum, min, max].every((part) => typeof part === "number" && Number.isFinite(part) && part >= 0)) return undefined
        measurements[name] = { count: count as number, sum: sum as number, min: min as number, max: max as number }
    }
    if (value.histograms === undefined) return { counters: counters as Record<string, number>, measurements }
    if (!isRecord(value.histograms)) return undefined
    const histograms: Record<string, UsageHistogramWire> = {}
    for (const [name, entry] of Object.entries(value.histograms)) {
        if (!isRecord(entry) || !isNumberArray(entry.bounds) || !isNumberArray(entry.counts)) return undefined
        const histogram = { bounds: entry.bounds, counts: entry.counts }
        if (!isConsistentHistogram(histogram, measurements[name])) return undefined
        histograms[name] = histogram
    }
    return { counters: counters as Record<string, number>, measurements, histograms }
}

function isNumberArray(value: unknown): value is number[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === "number")
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
