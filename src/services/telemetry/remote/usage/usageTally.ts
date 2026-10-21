import {
    USAGE_ERROR_CLASSES,
    USAGE_PURPOSES,
    type UsageErrorClass,
    type UsagePurpose,
    type UsageServedModel,
    type UsageSettlement,
} from "@/core/task/telemetry/UsageSettlement"
import {
    isValidModelEntry,
    isValidProviderEntry,
    isValidPurpose,
    USAGE_HISTOGRAM_BOUNDS_MS,
    USAGE_HISTOGRAM_BUCKETS,
    type UsageHistogramWire,
    type UsageModelTokensWire,
    type UsageModelWire,
    type UsageProviderWire,
    type UsagePurposeWire,
    type UsageSummaryWire,
} from "../contracts/usageBody"

/** A model's usage without its peak, which only exists once minutes are combined into a batch. */
export type UsageModelTally = Omit<UsageModelWire, "peak_minute">

/**
 * Usage of one request, one minute, or any set of them, in the sections of the
 * v2 body (otel contract v2 §2.2). Tallies add up exactly, so a minute is the
 * sum of its requests and a batch the sum of its minutes.
 */
export interface UsageTally {
    readonly sessions_started: number
    readonly purposes: Readonly<Partial<Record<UsagePurpose, UsagePurposeWire>>>
    readonly models: readonly UsageModelTally[]
    readonly providers: readonly UsageProviderWire[]
}

export const EMPTY_USAGE_TALLY: UsageTally = { sessions_started: 0, purposes: {}, models: [], providers: [] }

const UNKNOWN_ID = "unknown"
const MAX_PROVIDER_LENGTH = 32
const MAX_MODEL_LENGTH = 64

/** A provider and model reduced to the service's vocabulary. */
export interface UsageModelKey {
    readonly provider: string
    readonly model: string
    /** Present only for a custom model; the provider and model alone identify the entry. */
    readonly custom?: boolean
}

/**
 * The provider and model a request is reported under. Diagnostics use the same
 * key so an error names its model exactly as usage does. A custom model keeps
 * its own normalized ID and is marked `custom` beside it.
 */
export function usageModelKey(servedBy: UsageServedModel): UsageModelKey {
    const provider = usageProviderId(servedBy.provider)
    const model = normalizeId(servedBy.model, /[^a-z0-9_.-]+/g, MAX_MODEL_LENGTH)
    return servedBy.custom ? { provider, model, custom: true } : { provider, model }
}

export function usageProviderId(provider: string): string {
    return normalizeId(provider, /[^a-z0-9_-]+/g, MAX_PROVIDER_LENGTH)
}

function normalizeId(value: string, disallowed: RegExp, maxLength: number): string {
    const id = value.trim().toLowerCase().replace(disallowed, "_").slice(0, maxLength)
    return id.length > 0 ? id : UNKNOWN_ID
}

/** Whether a tally holds anything worth a batch: a request or an activation. */
export function hasUsageActivity(tally: UsageTally): boolean {
    return tally.sessions_started > 0 || Object.keys(tally.purposes).length > 0 || tally.models.length > 0
}

/** The tally one extension activation contributes. */
export function sessionStartedTally(): UsageTally {
    return { ...EMPTY_USAGE_TALLY, sessions_started: 1 }
}

/** Project one settled request; a purpose this build does not know is reported as `other`. */
export function projectUsageSettlement(settlement: UsageSettlement): UsageTally {
    const purpose = (USAGE_PURPOSES as readonly string[]).includes(settlement.purpose) ? settlement.purpose : "other"
    const duration = milliseconds(settlement.durationMs)
    const tokens = {
        input: count(settlement.inputTokens),
        output: count(settlement.outputTokens),
        cache_read: count(settlement.cacheReadTokens),
        cache_write: count(settlement.cacheWriteTokens),
    }
    const purposes = {
        [purpose]: {
            requests: {
                completed: settlement.outcome === "completed" ? 1 : 0,
                cancelled: settlement.outcome === "cancelled" ? 1 : 0,
                failed: settlement.outcome === "failed" ? 1 : 0,
            },
            tokens,
            duration_ms: summaryOf([duration]),
        },
    }
    const models = settlement.servedBy ? [projectServedModel(settlement, settlement.servedBy, tokens, duration)] : []
    const reliability = projectProviderReliability(settlement)
    return { sessions_started: 0, purposes, models, providers: reliability ? [reliability] : [] }
}

function projectServedModel(
    settlement: UsageSettlement,
    servedBy: UsageServedModel,
    tokens: Omit<UsageModelTokensWire, "reasoning">,
    duration: number,
): UsageModelTally {
    const reasoning =
        settlement.reasoningTokens === undefined ? undefined : Math.min(count(settlement.reasoningTokens), tokens.output)
    return {
        ...usageModelKey(servedBy),
        requests: {
            total: 1,
            failed: settlement.outcome === "failed" ? 1 : 0,
            cancelled: settlement.outcome === "cancelled" ? 1 : 0,
        },
        tokens: { ...tokens, ...(reasoning === undefined ? {} : { reasoning }) },
        duration_ms: histogramOf(duration),
        ...(settlement.streamTiming
            ? {
                  ttft_ms: histogramOf(milliseconds(settlement.streamTiming.ttftMs)),
                  generation_ms: histogramOf(milliseconds(settlement.streamTiming.generationMs)),
              }
            : {}),
    }
}

/** Failures count once per failed request; retries count every attempt that was followed by another. */
function projectProviderReliability(settlement: UsageSettlement): UsageProviderWire | undefined {
    const failed = settlement.outcome === "failed"
    const waits = (settlement.retries?.waitsMs ?? []).map(milliseconds)
    if (!failed && waits.length === 0) return undefined
    const errorClass: UsageErrorClass =
        settlement.failureClass && (USAGE_ERROR_CLASSES as readonly string[]).includes(settlement.failureClass)
            ? settlement.failureClass
            : "other"
    return {
        provider: usageProviderId(settlement.servedBy?.provider ?? ""),
        errors: failed ? { [errorClass]: 1 } : {},
        retries: waits.length,
        ...(waits.length > 0 ? { retry_wait_ms: summaryOf(waits) } : {}),
    }
}

/** Add two tallies; every counter saturates at the largest safe integer instead of losing precision. */
export function mergeUsageTallies(left: UsageTally, right: UsageTally): UsageTally {
    const purposes: Partial<Record<UsagePurpose, UsagePurposeWire>> = { ...left.purposes }
    for (const [purpose, value] of Object.entries(right.purposes) as [UsagePurpose, UsagePurposeWire][]) {
        const existing = purposes[purpose]
        purposes[purpose] = existing ? mergePurpose(existing, value) : value
    }
    return {
        sessions_started: add(left.sessions_started, right.sessions_started),
        purposes,
        models: mergeKeyed(left.models, right.models, modelId, mergeModel),
        providers: mergeKeyed(left.providers, right.providers, (entry) => entry.provider, mergeProvider),
    }
}

export function modelId(model: UsageModelKey): string {
    return `${model.provider}/${model.model}`
}

function mergeKeyed<T>(left: readonly T[], right: readonly T[], keyOf: (entry: T) => string, merge: (a: T, b: T) => T): T[] {
    const merged = new Map(left.map((entry) => [keyOf(entry), entry]))
    for (const entry of right) {
        const existing = merged.get(keyOf(entry))
        merged.set(keyOf(entry), existing ? merge(existing, entry) : entry)
    }
    return [...merged.values()]
}

function mergePurpose(left: UsagePurposeWire, right: UsagePurposeWire): UsagePurposeWire {
    const duration = mergeOptional(left.duration_ms, right.duration_ms, mergeSummary)
    return {
        requests: addCounts(left.requests, right.requests),
        tokens: addCounts(left.tokens, right.tokens),
        ...(duration ? { duration_ms: duration } : {}),
    }
}

/**
 * Merge two entries of the same model, or fold one model into another such as the overflow entry.
 * The entry is custom when either side is; the batch strips the mark from the overflow entry.
 */
export function mergeModel<T extends UsageModelTally>(left: T, right: UsageModelTally): T {
    const reasoning = mergeOptional(left.tokens.reasoning, right.tokens.reasoning, add)
    const { reasoning: _left, ...leftTokens } = left.tokens
    const { reasoning: _right, ...rightTokens } = right.tokens
    const duration = mergeOptional(left.duration_ms, right.duration_ms, mergeHistogram)
    const ttft = mergeOptional(left.ttft_ms, right.ttft_ms, mergeHistogram)
    const generation = mergeOptional(left.generation_ms, right.generation_ms, mergeHistogram)
    const custom = left.custom === true || right.custom === true
    const { duration_ms: _d, ttft_ms: _t, generation_ms: _g, custom: _c, ...rest } = left
    return {
        ...rest,
        ...(custom ? { custom: true } : {}),
        requests: addCounts(left.requests, right.requests),
        tokens: { ...addCounts(leftTokens, rightTokens), ...(reasoning === undefined ? {} : { reasoning }) },
        ...(duration ? { duration_ms: duration } : {}),
        ...(ttft ? { ttft_ms: ttft } : {}),
        ...(generation ? { generation_ms: generation } : {}),
    } as T
}

/** Merge two entries of the same provider, or fold one provider into the overflow entry. */
export function mergeProvider(left: UsageProviderWire, right: UsageProviderWire): UsageProviderWire {
    const waits = mergeOptional(left.retry_wait_ms, right.retry_wait_ms, mergeSummary)
    return {
        provider: left.provider,
        errors: addCounts(left.errors, right.errors),
        retries: add(left.retries, right.retries),
        ...(waits ? { retry_wait_ms: waits } : {}),
    }
}

function mergeSummary(left: UsageSummaryWire, right: UsageSummaryWire): UsageSummaryWire {
    return {
        count: add(left.count, right.count),
        sum: add(left.sum, right.sum),
        min: Math.min(left.min, right.min),
        max: Math.max(left.max, right.max),
    }
}

function mergeHistogram(left: UsageHistogramWire, right: UsageHistogramWire): UsageHistogramWire {
    return { ...mergeSummary(left, right), buckets: left.buckets.map((bucket, index) => add(bucket, right.buckets[index] ?? 0)) }
}

function mergeOptional<T>(left: T | undefined, right: T | undefined, merge: (a: T, b: T) => T): T | undefined {
    if (left === undefined) return right
    if (right === undefined) return left
    return merge(left, right)
}

function addCounts<T extends Readonly<Partial<Record<string, number>>>>(left: T, right: T): T {
    const sum: Record<string, number> = { ...left } as Record<string, number>
    for (const [key, value] of Object.entries(right)) {
        if (value !== undefined) sum[key] = add(sum[key] ?? 0, value)
    }
    return sum as T
}

function add(left: number, right: number): number {
    return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}

function count(value: number): number {
    const rounded = Math.round(value)
    return Number.isSafeInteger(rounded) && rounded > 0 ? rounded : 0
}

function milliseconds(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

function summaryOf(values: readonly number[]): UsageSummaryWire {
    const sum = values.reduce((total, value) => total + value, 0)
    return { count: values.length, sum, min: Math.min(...values), max: Math.max(...values) }
}

/** One sample in the first bucket whose upper bound holds it; the last bucket holds what exceeds every bound. */
function histogramOf(value: number): UsageHistogramWire {
    const buckets = new Array<number>(USAGE_HISTOGRAM_BUCKETS).fill(0)
    const bucket = USAGE_HISTOGRAM_BOUNDS_MS.findIndex((bound) => value <= bound)
    buckets[bucket === -1 ? USAGE_HISTOGRAM_BOUNDS_MS.length : bucket] = 1
    return { ...summaryOf([value]), buckets }
}

/**
 * Read a persisted tally. Any section the service would refuse makes the whole
 * tally unreadable, so a damaged record is skipped instead of poisoning the
 * batch it would join.
 */
export function parseUsageTally(value: unknown): UsageTally | undefined {
    if (!isRecord(value) || !isRecord(value.purposes) || !Array.isArray(value.models) || !Array.isArray(value.providers)) {
        return undefined
    }
    const sessions = value.sessions_started
    if (typeof sessions !== "number" || !Number.isSafeInteger(sessions) || sessions < 0) return undefined
    if (!Object.entries(value.purposes).every(([key, purpose]) => isValidPurpose(key, purpose))) return undefined
    if (!value.models.every((model) => isValidModelEntry(model, false))) return undefined
    if (!value.providers.every(isValidProviderEntry)) return undefined
    return {
        sessions_started: sessions,
        purposes: value.purposes as UsageTally["purposes"],
        models: value.models as UsageModelTally[],
        providers: value.providers as UsageProviderWire[],
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
