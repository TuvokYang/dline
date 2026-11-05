/**
 * Stored shapes of the unified metrics tables.
 *
 * These are the accumulation targets, not the emitted facts: an `UsageEvent` is one
 * attempt's final snapshot, while a `UsageRow` is a bucket of many attempts. Keeping
 * them apart is what lets the ledger add a delta without re-deriving the source fact.
 */

/** Physical bucket granularity. It is part of a row's identity, so a rolled-up hour
 * can never be summed together with the minute rows it replaced. */
export type MetricsResolution = "minute" | "hour" | "day"

/**
 * How trustworthy the numbers in a row are.
 *
 * `none` means the Provider reported no usage at all; it is not zero. `mixed` is a
 * full bucket whose contributors disagree, which must stay visible instead of being
 * flattened to `estimated`.
 */
export type MetricsQuality = "none" | "estimated" | "exact" | "mixed"

/** A usage row's own quality plus the legacy case, where an inclusive daily total
 * cannot be split into fresh/cache components. */
export type UsageQuality = MetricsQuality | "legacy"

/** `provider` counts one Provider round; `execution` counts one logical execution.
 * They never share a counter, because the execution RPM denominator is not a round. */
export type PerformanceFactKind = "provider" | "execution"

/** Terminal status shared by both fact kinds. */
export type MetricsStatus = "completed" | "failed" | "cancelled" | "aborted"

export type PerformanceQuality = "exact" | "estimated" | "unknown" | "mixed"

/**
 * The identity columns shared by both tables.
 *
 * `modelId` is `"*"` only on a query-time rollup row; persisted rows carry the real id.
 */
export interface MetricsRowIdentity {
    readonly scopeId: string
    readonly resolution: MetricsResolution
    readonly bucketStartMs: number
    readonly modelId: string
    readonly taskId: string
    readonly profileId: string
    readonly keyFingerprint: string
}

/**
 * One accumulated usage bucket.
 *
 * `inputTokens` holds fresh (non-overlapping) input only: the cache denominator is
 * `inputTokens + cacheWriteTokens + cacheReadTokens`, so storing inclusive input
 * would count the same context twice.
 */
export interface UsageRow extends MetricsRowIdentity {
    readonly providerId: string
    readonly inputTokens: number
    readonly outputTokens: number
    readonly thoughtsTokens: number
    readonly cacheWriteTokens: number
    readonly cacheReadTokens: number
    /** Cache-hit accumulator numerator; the rate is derived, never stored. */
    readonly cacheNumerator: number
    /** Cache-hit accumulator denominator; zero means "unknown", not `0%`. */
    readonly cacheDenominator: number
    /** False when the Provider never reported usage; absence is not zero. */
    readonly usageAvailable: boolean
    /** False when the Provider never reported cache segments. */
    readonly cacheUsageAvailable: boolean
    /** Complete same-currency total only. `undefined` means unknown or incomplete. */
    readonly cost?: number
    readonly currency?: string
    /** True when the bucket received more than one currency. */
    readonly currencyMixed: boolean
    /** True only when `cost` is a complete total for the bucket. */
    readonly costAvailable: boolean
    readonly usageQuality: UsageQuality
    /** Number of responses that carried usage. */
    readonly respondingRequests: number
    readonly aggregatedAt: string
}

/**
 * One accumulated performance bucket.
 *
 * Durations are accumulators, not means; `durationCoverage` is the divisor. Storing a
 * pre-averaged value would make cross-bucket averaging wrong.
 */
export interface PerformanceRow extends MetricsRowIdentity {
    readonly providerId: string
    readonly factKind: PerformanceFactKind
    readonly providerDurationMs: number
    readonly executionDurationMs: number
    readonly generationDurationMs: number
    readonly ttftMs: number
    readonly requestCount: number
    readonly completedCount: number
    readonly failedCount: number
    readonly cancelledCount: number
    readonly abortedCount: number
    /** Increased only by `provider` facts. */
    readonly providerRoundCount: number
    /** Increased only by `execution` facts. */
    readonly executionCount: number
    readonly perfQuality: PerformanceQuality
    /**
     * Provider attempts that contributed a duration; the provider average's divisor.
     *
     * A row carries exactly one `factKind`, but a totals accumulator sums rows of both
     * kinds. One shared counter would divide the provider total by provider *and*
     * execution samples, so each average needs its own divisor.
     */
    readonly durationCoverage: number
    /** Logical executions that contributed a duration; the execution average's divisor. */
    readonly executionDurationCoverage: number
    /**
     * Requests that contributed a time-to-first-token.
     *
     * Separate from `durationCoverage` because a provider can report a duration without
     * reporting TTFT: dividing TTFT by the duration divisor would turn "no sample" into
     * a confident `0 ms`.
     */
    readonly ttftCoverage: number
    readonly aggregatedAt: string
}

/**
 * A summed usage view over one or more buckets.
 *
 * The cache rate is derived from the denominator so that `90%/1k` and `10%/99k`
 * combine to `10.8%` instead of the arithmetic mean of the two percentages.
 */
export interface UsageTotals {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly thoughtsTokens: number
    readonly cacheWriteTokens: number
    readonly cacheReadTokens: number
    /** `undefined` when nothing reported cache usage or the denominator is zero. */
    readonly cacheHitRate?: number
    /** Complete same-currency total only; a partial sum stays `undefined`. */
    readonly cost?: number
    readonly currency?: string
    readonly currencyMixed: boolean
    readonly costAvailable: boolean
    readonly usageQuality: UsageQuality
    readonly respondingRequests: number
}

/**
 * A summed performance view.
 *
 * Means stay absent unless a coverage divisor exists; the RPM projection uses
 * `executionCount` / `executionDurationMs`, never the provider round count.
 */
export interface PerformanceTotals {
    readonly providerDurationMs: number
    readonly executionDurationMs: number
    readonly generationDurationMs: number
    readonly ttftMs: number
    readonly requestCount: number
    readonly completedCount: number
    readonly failedCount: number
    readonly cancelledCount: number
    readonly abortedCount: number
    readonly providerRoundCount: number
    readonly executionCount: number
    readonly perfQuality: PerformanceQuality
    /** Provider attempts that contributed a duration; the provider average's divisor. */
    readonly durationCoverage: number
    /** Logical executions that contributed a duration; the execution average's divisor. */
    readonly executionDurationCoverage: number
    /**
     * Requests that contributed a time-to-first-token; the TTFT average's own divisor.
     *
     * Kept apart from `durationCoverage` so a provider that reports a duration but no
     * TTFT yields "unknown" instead of a fabricated `0 ms` average.
     */
    readonly ttftCoverage: number
    /** `undefined` when no request contributed a duration. */
    readonly avgProviderDurationMs?: number
    /** `undefined` when no request contributed a duration. */
    readonly avgExecutionDurationMs?: number
    /** `undefined` when no request contributed a time-to-first-token. */
    readonly avgTtftMs?: number
}

/** One point of a time series, tagged with the granularity it was read at so a
 * caller cannot silently compare a minute point with an hour point. */
export interface UsageSeriesPoint extends UsageTotals {
    readonly resolution: MetricsResolution
    readonly bucketStartMs: number
}

/** Query result carrying the completeness facts a UI must be able to show. */
export interface UsageQueryResult {
    readonly totals: UsageTotals
    readonly series: readonly UsageSeriesPoint[]
    /** True when the store is degraded and the answer may be incomplete. */
    readonly degraded: boolean
    /** True when the result was truncated to `maxPoints`. */
    readonly truncated: boolean
    /** Earliest bucket still accepted; earlier history is genuinely absent. */
    readonly retentionStartMs?: number
    /**
     * True when a bucket overlapping the window edge was left out because it reaches
     * outside the window.
     *
     * Its numbers describe the whole bucket, so counting them would attribute usage to
     * time the caller did not ask about. Reporting it lets a surface widen the window
     * instead of publishing a total that silently omits it.
     */
    readonly partialEdge?: boolean
    /** ISO time of the read, so a surface can state the age of the numbers. */
    readonly retrievedAt: string
}
