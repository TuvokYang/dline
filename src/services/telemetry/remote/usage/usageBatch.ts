import {
    USAGE_MAX_FACTS,
    USAGE_MAX_SPAN_MS,
    USAGE_SCHEMA_VERSION,
    USAGE_SECOND_MS,
    type UsageBodyWire,
    type UsageClientWire,
    type UsageFactWire,
} from "../contracts/usageBody"
import { usageModelIdentityKey } from "../contracts/usageIdentity"
import { EMPTY_USAGE_TALLY, hasUsageActivity, mergeUsageTallies, type UsageFactTally, type UsageTally } from "./usageTally"

/**
 * One distinct second of activity, merged across every process shard.
 *
 * The bucket is a second rather than a minute because the window reports
 * `active_seconds`: computing that from minute buckets would multiply every
 * claim by 60 and describe an intensity nobody measured.
 */
export interface UsageSecond {
    /** Start of the UTC second, epoch milliseconds. */
    readonly startedAt: number
    readonly tally: UsageTally
}

export function secondStartOf(epochMs: number): number {
    return Math.floor(epochMs / USAGE_SECOND_MS) * USAGE_SECOND_MS
}

/** Combine two lists of seconds; the same second in both is added up. */
export function mergeSeconds(left: readonly UsageSecond[], right: readonly UsageSecond[]): UsageSecond[] {
    const bySecond = new Map(left.map((second) => [second.startedAt, second]))
    for (const second of right) {
        const existing = bySecond.get(second.startedAt)
        bySecond.set(second.startedAt, {
            startedAt: second.startedAt,
            tally: existing ? mergeUsageTallies(existing.tally, second.tally) : second.tally,
        })
    }
    return [...bySecond.values()].sort((a, b) => a.startedAt - b.startedAt)
}

/**
 * The seconds the next batch carries: the oldest one and every later one that
 * ends within the contract's 60-minute span. The seconds need not be contiguous,
 * so a backlog from offline time drains oldest first.
 */
export function selectBatchSeconds(seconds: readonly UsageSecond[]): UsageSecond[] {
    const sorted = [...seconds].sort((a, b) => a.startedAt - b.startedAt)
    if (sorted.length === 0) return []
    const spanEnd = sorted[0].startedAt + USAGE_MAX_SPAN_MS
    return sorted.filter((second) => second.startedAt + USAGE_SECOND_MS <= spanEnd)
}

/**
 * Fold seconds into one body, or `undefined` when they hold no activity.
 *
 * The facts are the batch's only numerical source of truth. Two bounds apply:
 * one fact per `(role, provider, model, custom)` identity, and at most
 * {@link USAGE_MAX_FACTS} identities. A batch that would exceed the fact bound is
 * refused instead of folding a real identity into a placeholder, because a folded
 * fact cannot be deleted on its own later.
 */
export function buildUsageBody(
    seconds: readonly UsageSecond[],
    client: UsageClientWire,
    droppedSeconds: number,
): UsageBodyWire | undefined {
    const merged = mergeSeconds([], seconds)
    if (merged.length === 0) return undefined
    const total = merged.reduce((sum, second) => mergeUsageTallies(sum, second.tally), EMPTY_USAGE_TALLY)
    if (!hasUsageActivity(total)) return undefined
    return {
        schema_version: USAGE_SCHEMA_VERSION,
        client,
        window: {
            started_at: (merged[0] as UsageSecond).startedAt,
            ended_at: (merged.at(-1) as UsageSecond).startedAt + USAGE_SECOND_MS,
            active_seconds: merged.length,
            dropped_seconds: droppedSeconds,
        },
        sessions_started: total.sessions_started,
        facts: total.facts.map(toFactWire),
    }
}

function toFactWire(fact: UsageFactTally): UsageFactWire {
    return {
        role: fact.role,
        provider: fact.provider,
        model: fact.model,
        custom: fact.custom,
        requests: fact.requests,
        tokens: fact.tokens,
        duration_ms: fact.duration_ms,
        errors: fact.errors,
        retries: fact.retries,
        ...(fact.turns ? { turns: fact.turns } : {}),
        ...(fact.turn_duration_ms ? { turn_duration_ms: fact.turn_duration_ms } : {}),
        ...(fact.tools ? { tools: fact.tools } : {}),
        ...(fact.ttft_ms ? { ttft_ms: fact.ttft_ms } : {}),
        ...(fact.generation_ms ? { generation_ms: fact.generation_ms } : {}),
        ...(fact.retry_wait_ms ? { retry_wait_ms: fact.retry_wait_ms } : {}),
        ...(fact.todos ? { todos: fact.todos } : {}),
        ...(fact.task_attempts ? { task_attempts: fact.task_attempts } : {}),
    }
}

/**
 * How many distinct fact identities a batch would carry.
 *
 * The caller uses it to seal before the body bound, so a batch never has to
 * choose between losing a fact and merging two of them.
 */
export function countFactIdentities(seconds: readonly UsageSecond[]): number {
    const identities = new Set<string>()
    for (const second of seconds) {
        for (const fact of second.tally.facts) identities.add(usageModelIdentityKey(fact))
    }
    return identities.size
}
