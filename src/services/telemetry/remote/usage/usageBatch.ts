import {
    USAGE_MAX_MODELS,
    USAGE_MAX_PROVIDERS,
    USAGE_MAX_SPAN_MS,
    USAGE_MINUTE_MS,
    USAGE_OVERFLOW_ID,
    USAGE_SCHEMA_VERSION,
    type UsageBodyWire,
    type UsageClientWire,
    type UsageModelWire,
    type UsageProviderWire,
} from "../contracts/usageBody"
import {
    EMPTY_USAGE_TALLY,
    hasUsageActivity,
    mergeModel,
    mergeProvider,
    mergeUsageTallies,
    modelId,
    type UsageModelTally,
    type UsageTally,
} from "./usageTally"

/** One UTC minute of usage, merged across every process shard. */
export interface UsageMinute {
    /** Start of the UTC minute, epoch milliseconds. */
    readonly startedAt: number
    readonly tally: UsageTally
}

export function minuteStartOf(epochMs: number): number {
    return Math.floor(epochMs / USAGE_MINUTE_MS) * USAGE_MINUTE_MS
}

/** Combine two lists of minutes; the same minute in both is added up. */
export function mergeMinutes(left: readonly UsageMinute[], right: readonly UsageMinute[]): UsageMinute[] {
    const byMinute = new Map(left.map((minute) => [minute.startedAt, minute]))
    for (const minute of right) {
        const existing = byMinute.get(minute.startedAt)
        byMinute.set(minute.startedAt, {
            startedAt: minute.startedAt,
            tally: existing ? mergeUsageTallies(existing.tally, minute.tally) : minute.tally,
        })
    }
    return [...byMinute.values()].sort((left, right) => left.startedAt - right.startedAt)
}

/**
 * The minutes the next batch carries: the oldest one and every later one that
 * ends within the 60-minute span the service accepts. The minutes need not be
 * contiguous, so a backlog from offline time drains oldest first.
 */
export function selectBatchMinutes(minutes: readonly UsageMinute[]): UsageMinute[] {
    const sorted = [...minutes].sort((left, right) => left.startedAt - right.startedAt)
    if (sorted.length === 0) return []
    const spanEnd = sorted[0].startedAt + USAGE_MAX_SPAN_MS
    return sorted.filter((minute) => minute.startedAt + USAGE_MINUTE_MS <= spanEnd)
}

/**
 * Fold minutes into one v2 body, or `undefined` when they hold no activity.
 *
 * Beyond eight models, the least requested ones are summed into `_other`;
 * beyond eight providers with failures or retries, the same. A model's peak is
 * taken from its busiest single minute after that folding, so a batch of many
 * minutes keeps the peak the service derives RPM and TPM from.
 */
export function buildUsageBody(
    minutes: readonly UsageMinute[],
    client: UsageClientWire,
    droppedMinutes: number,
): UsageBodyWire | undefined {
    const merged = mergeMinutes([], minutes)
    if (merged.length === 0) return undefined
    const total = merged.reduce((sum, minute) => mergeUsageTallies(sum, minute.tally), EMPTY_USAGE_TALLY)
    if (!hasUsageActivity(total)) return undefined
    return {
        schema_version: USAGE_SCHEMA_VERSION,
        client,
        window: {
            started_at: merged[0].startedAt,
            ended_at: (merged.at(-1) as UsageMinute).startedAt + USAGE_MINUTE_MS,
            active_minutes: merged.length,
            dropped_minutes: droppedMinutes,
        },
        sessions_started: total.sessions_started,
        purposes: total.purposes,
        models: foldModels(merged, total.models),
        providers: foldProviders(total.providers),
    }
}

const OVERFLOW_KEY = modelId({ provider: USAGE_OVERFLOW_ID, model: USAGE_OVERFLOW_ID })

/** The overflow entry stands for many models, so it names none and is never marked custom. */
function asOverflow(model: UsageModelTally): UsageModelTally {
    const { custom: _custom, ...rest } = model
    return { ...rest, provider: USAGE_OVERFLOW_ID, model: USAGE_OVERFLOW_ID }
}

function foldModels(minutes: readonly UsageMinute[], models: readonly UsageModelTally[]): UsageModelWire[] {
    const ranked = [...models].sort(
        (left, right) => right.requests.total - left.requests.total || modelId(left).localeCompare(modelId(right)),
    )
    const kept = new Set(
        (ranked.length > USAGE_MAX_MODELS ? ranked.slice(0, USAGE_MAX_MODELS - 1) : ranked).map((model) => modelId(model)),
    )
    const keyOf = (model: UsageModelTally) => (kept.has(modelId(model)) ? modelId(model) : OVERFLOW_KEY)

    const folded = new Map<string, UsageModelTally>()
    for (const model of ranked) {
        const key = keyOf(model)
        const existing = folded.get(key)
        const merged = existing ? mergeModel(existing, model) : model
        folded.set(key, key === OVERFLOW_KEY ? asOverflow(merged) : merged)
    }

    const peaks = new Map<string, { requests: number; tokens_output: number }>()
    for (const minute of minutes) {
        const perMinute = new Map<string, { requests: number; tokens_output: number }>()
        for (const model of minute.tally.models) {
            const key = keyOf(model)
            const current = perMinute.get(key) ?? { requests: 0, tokens_output: 0 }
            perMinute.set(key, {
                requests: current.requests + model.requests.total,
                tokens_output: current.tokens_output + model.tokens.output,
            })
        }
        for (const [key, value] of perMinute) {
            const peak = peaks.get(key) ?? { requests: 0, tokens_output: 0 }
            peaks.set(key, {
                requests: Math.max(peak.requests, value.requests),
                tokens_output: Math.max(peak.tokens_output, value.tokens_output),
            })
        }
    }
    return [...folded.entries()].map(([key, model]) => ({
        ...model,
        peak_minute: peaks.get(key) ?? { requests: 0, tokens_output: 0 },
    }))
}

/** Only providers with a failure or a retry travel; beyond eight, the quietest are summed into `_other`. */
function foldProviders(providers: readonly UsageProviderWire[]): UsageProviderWire[] {
    const weight = (provider: UsageProviderWire) =>
        Object.values(provider.errors).reduce((sum: number, count) => sum + (count ?? 0), 0) + provider.retries
    const active = providers
        .filter((provider) => weight(provider) > 0)
        .sort((left, right) => weight(right) - weight(left) || left.provider.localeCompare(right.provider))
    if (active.length <= USAGE_MAX_PROVIDERS) return active
    const kept = active.slice(0, USAGE_MAX_PROVIDERS - 1)
    const overflow = active
        .slice(USAGE_MAX_PROVIDERS - 1)
        .reduce<UsageProviderWire>((sum, provider) => mergeProvider(sum, provider), {
            provider: USAGE_OVERFLOW_ID,
            errors: {},
            retries: 0,
        })
    return [...kept, overflow]
}
