import {
    USAGE_PURPOSES,
    type UsagePurpose,
    type UsageServedModel,
    type UsageSettlement,
} from "@/core/task/telemetry/UsageSettlement"
import { USAGE_MAX_METRIC_NAME_LENGTH, USAGE_MAX_METRIC_NAMES, type UsageMeasurementWire } from "../contracts/wire"

/**
 * The remote usage catalog (WS-098 spec §10).
 *
 * Fixed names split by purpose and outcome. A second, open family counts the
 * same requests by the provider and model that served them, for ranking; the
 * service reads that family as `dline.usage.model.<provider>.<metric>.<model>`.
 */
export interface UsageObservation {
    readonly counters: Readonly<Record<string, number>>
    readonly measurements: Readonly<Record<string, UsageMeasurementWire>>
}

export function usageMetricNames(purpose: UsagePurpose) {
    return {
        input: `dline.usage.tokens.input.${purpose}`,
        output: `dline.usage.tokens.output.${purpose}`,
        cacheRead: `dline.usage.tokens.cache_read.${purpose}`,
        cacheWrite: `dline.usage.tokens.cache_write.${purpose}`,
        cost: `dline.usage.cost_micro_usd.${purpose}`,
        duration: `dline.usage.request_duration_ms.${purpose}`,
    } as const
}

export function requestCounterName(purpose: UsagePurpose, outcome: UsageSettlement["outcome"]): string {
    return `dline.usage.requests.${purpose}.${outcome}`
}

const MODEL_METRIC_PREFIX = "dline.usage.model."
const MODEL_METRICS = ["requests", "tokens_input", "tokens_output"] as const
type ModelMetric = (typeof MODEL_METRICS)[number]
const LONGEST_MODEL_METRIC = Math.max(...MODEL_METRICS.map((metric) => metric.length))
const MAX_PROVIDER_SEGMENT = 32
/** Stands in for every model folded away when a batch would exceed the name limit. */
const OVERFLOW_SEGMENT = "_other"

/** A provider and model reduced to the characters a metric name allows. */
interface ModelKey {
    readonly provider: string
    readonly model: string
}

/**
 * The model comes last so it may keep its dots: the service reads the provider
 * and metric from fixed positions and the model from the rest. Every metric of
 * one model is cut to the same length, so the key never differs between them.
 */
function modelKeyOf(servedBy: UsageServedModel): ModelKey {
    const provider = nameSegment(servedBy.provider, /[^a-z0-9_-]+/g, MAX_PROVIDER_SEGMENT)
    const room = USAGE_MAX_METRIC_NAME_LENGTH - MODEL_METRIC_PREFIX.length - provider.length - LONGEST_MODEL_METRIC - 2
    return { provider, model: nameSegment(servedBy.model, /[^a-z0-9_.-]+/g, room) }
}

function nameSegment(value: string, disallowed: RegExp, maxLength: number): string {
    const segment = value.trim().toLowerCase().replace(disallowed, "_").slice(0, maxLength)
    return segment.length > 0 ? segment : "unknown"
}

function modelMetricName(key: ModelKey, metric: ModelMetric): string {
    return `${MODEL_METRIC_PREFIX}${key.provider}.${metric}.${key.model}`
}

function parseModelMetricName(name: string): { readonly key: ModelKey; readonly metric: ModelMetric } | undefined {
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
    const counters: Record<string, number> = { [requestCounterName(purpose, settlement.outcome)]: 1 }
    addCount(counters, names.input, settlement.inputTokens)
    addCount(counters, names.output, settlement.outputTokens)
    addCount(counters, names.cacheRead, settlement.cacheReadTokens)
    addCount(counters, names.cacheWrite, settlement.cacheWriteTokens)
    if (settlement.costMicroUsd !== undefined) addCount(counters, names.cost, settlement.costMicroUsd)
    if (settlement.servedBy) {
        const key = modelKeyOf(settlement.servedBy)
        counters[modelMetricName(key, "requests")] = 1
        addCount(counters, modelMetricName(key, "tokens_input"), settlement.inputTokens)
        addCount(counters, modelMetricName(key, "tokens_output"), settlement.outputTokens)
    }
    const duration = Math.max(0, Math.round(settlement.durationMs))
    return { counters, measurements: { [names.duration]: { count: 1, sum: duration, min: duration, max: duration } } }
}

/**
 * Keep a batch within the server's name limit.
 *
 * Only the per-model family can grow without bound. When it would push the
 * batch over the limit, the most requested models keep their names and the rest
 * are summed into one overflow model, so every count still arrives.
 */
export function fitMetricNameLimit(observation: UsageObservation, limit = USAGE_MAX_METRIC_NAMES): UsageObservation {
    const nameCount = Object.keys(observation.counters).length + Object.keys(observation.measurements).length
    if (nameCount <= limit) return observation
    const counters: Record<string, number> = {}
    const models = new Map<string, { key: ModelKey; values: Partial<Record<ModelMetric, number>> }>()
    for (const [name, value] of Object.entries(observation.counters)) {
        const parsed = parseModelMetricName(name)
        if (!parsed) {
            counters[name] = value
            continue
        }
        const id = `${parsed.key.provider}.${parsed.key.model}`
        const entry = models.get(id) ?? { key: parsed.key, values: {} }
        entry.values[parsed.metric] = value
        models.set(id, entry)
    }
    const room = limit - Object.keys(counters).length - Object.keys(observation.measurements).length - MODEL_METRICS.length
    const ranked = [...models.entries()].sort(
        ([leftId, left], [rightId, right]) =>
            (right.values.requests ?? 0) - (left.values.requests ?? 0) || leftId.localeCompare(rightId),
    )
    const overflow: ModelKey = { provider: OVERFLOW_SEGMENT, model: OVERFLOW_SEGMENT }
    let used = 0
    for (const [, { key, values }] of ranked) {
        const size = Object.keys(values).length
        const target = used + size <= room ? key : overflow
        if (target === key) used += size
        for (const [metric, value] of Object.entries(values) as [ModelMetric, number][]) {
            const name = modelMetricName(target, metric)
            counters[name] = Math.min(Number.MAX_SAFE_INTEGER, (counters[name] ?? 0) + value)
        }
    }
    return { counters, measurements: observation.measurements }
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
 * Read the counters and summaries of a persisted observation or window. Any
 * value the server would refuse makes the whole record unreadable, so a
 * damaged record is skipped instead of poisoning the batch it would join.
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
    return { counters: counters as Record<string, number>, measurements }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
