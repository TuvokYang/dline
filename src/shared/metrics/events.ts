/**
 * The neutral facts a Task emits.
 *
 * An event is a value: no message bodies, tool arguments, command output, file
 * contents or secrets ever travel through it. It describes one already-settled
 * observation, so the receiver never has to read the current Profile to decide who a
 * historical number belonged to — identity is frozen where the fact happened.
 */

import type { PerformanceQuality, UsageQuality } from "./types"

/** Quality of an emitted usage fact. `mixed` only exists after aggregation. */
export type EmittedUsageQuality = Exclude<UsageQuality, "mixed" | "legacy">

/**
 * Identity frozen at the moment the request started or the real send happened.
 *
 * `sequence` orders events inside one opening for diagnostics only. It is not a
 * persisted high-water mark, so a restarted Task does not claim to have seen a gap
 * it never had.
 */
export interface MetricsIdentity {
    readonly eventId: string
    readonly observedAtMs: number
    readonly sequence: number
    readonly workspaceId: string
    readonly taskId: string
    readonly profileId: string
    readonly providerId: string
    readonly modelId: string
    readonly keyFingerprint: string
    readonly logicalRequestId: string
    readonly roundId: string
}

/**
 * One real attempt's final usage snapshot.
 *
 * `inputTokens` is fresh and does not overlap the cache segments. `outputTokens`
 * already includes `thoughtsTokens`, so a consumer must never add them together.
 * `cost` is only present together with a known `currency` and `costComplete`, which
 * is why completeness is a separate flag instead of `cost === undefined`.
 */
export interface UsageEvent extends MetricsIdentity {
    readonly kind: "usage"
    readonly inputTokens: number
    readonly outputTokens: number
    readonly thoughtsTokens?: number
    readonly cacheWriteTokens?: number
    readonly cacheReadTokens?: number
    /** False when the Provider reported no usage; absence is not zero. */
    readonly usageReported: boolean
    readonly cost?: number
    readonly currency?: string
    /** True only when `cost` is a complete total for this attempt. */
    readonly costComplete: boolean
    /** True when the source already confirmed a currency conflict. */
    readonly currencyMixed: boolean
    readonly usageQuality: EmittedUsageQuality
}

/**
 * One settled performance fact.
 *
 * `provider` facts come from one attempt's terminal state; `execution` facts come
 * from one logical execution. They stay separate because a logical execution can
 * settle without any tool call and its duration is the RPM denominator.
 */
export interface PerformanceEvent extends MetricsIdentity {
    readonly kind: "performance"
    readonly factKind: "provider" | "execution"
    /** Present on `execution` facts, absent on `provider` facts. */
    readonly executionId?: string
    readonly providerDurationMs?: number
    readonly executionDurationMs?: number
    readonly generationDurationMs?: number
    readonly ttftMs?: number
    readonly status: "completed" | "failed" | "cancelled" | "aborted"
    readonly perfQuality: PerformanceQuality
}

export type MetricsEvent = UsageEvent | PerformanceEvent

/** Narrow a neutral event to its usage arm. */
export function isUsageEvent(event: MetricsEvent): event is UsageEvent {
    return event.kind === "usage"
}

/** Narrow a neutral event to its performance arm. */
export function isPerformanceEvent(event: MetricsEvent): event is PerformanceEvent {
    return event.kind === "performance"
}

/** Emitted accuracy label mapped onto the stored column value. */
export function storedQualityOf(quality: EmittedUsageQuality): "none" | "estimated" | "exact" {
    return quality
}
