/**
 * The usage one folded block stands for.
 *
 * The Webview cannot import the extension's request-round records, so this is the
 * projection it receives: the same figures, with the same meanings, that
 * `ApiRequestRoundRecord` carries. Nothing here is re-derived from message
 * payloads — `api_req_started` holds tokens and cost but no timing, so the round
 * records stay the single authority the rate metrics and usage telemetry read.
 */

export type FoldUsageQuality = "none" | "estimated" | "exact" | "legacy"

export interface FoldUsage {
    /** Provider generation time summed over the block's rounds. */
    readonly durationMs: number
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheWriteTokens: number
    readonly cacheReadTokens: number
    readonly totalCost?: number
    readonly currency?: string
    /**
     * Output tokens per second of provider generation, the same basis the rate
     * metrics use. Absent when no round reported a usable duration.
     */
    readonly averageTokensPerSecond?: number
    /** Worst quality among the counted rounds; the block is only exact when all of them are. */
    readonly usageQuality: FoldUsageQuality
}

/** One request round as the Webview receives it from the rate-metrics projection. */
export interface FoldRoundUsage {
    readonly roundId: string
    readonly providerDurationMs?: number
    readonly inputTokens?: number
    readonly outputTokens?: number
    readonly cacheWriteTokens?: number
    readonly cacheReadTokens?: number
    readonly totalCost?: number
    readonly currency?: string
    readonly usageQuality: FoldUsageQuality
}

const QUALITY_RANK: Record<FoldUsageQuality, number> = {
    none: 0,
    legacy: 1,
    estimated: 2,
    exact: 3,
}

/** Sum the usage of the rounds a block covers. */
export function summarizeRoundsUsage(rounds: readonly FoldRoundUsage[]): FoldUsage | undefined {
    if (rounds.length === 0) return undefined

    let durationMs = 0
    let inputTokens = 0
    let outputTokens = 0
    let cacheWriteTokens = 0
    let cacheReadTokens = 0
    let totalCost: number | undefined
    let currency: string | undefined
    let usageQuality: FoldUsageQuality = "exact"

    for (const round of rounds) {
        // Only provider generation counts as work; a round without a timing
        // contributes no duration rather than an estimated one.
        if (round.providerDurationMs !== undefined && Number.isFinite(round.providerDurationMs)) {
            durationMs += Math.max(0, round.providerDurationMs)
        }
        inputTokens += round.inputTokens ?? 0
        outputTokens += round.outputTokens ?? 0
        cacheWriteTokens += round.cacheWriteTokens ?? 0
        cacheReadTokens += round.cacheReadTokens ?? 0
        if (round.totalCost !== undefined) totalCost = (totalCost ?? 0) + round.totalCost
        currency ??= round.currency
        if (QUALITY_RANK[round.usageQuality] < QUALITY_RANK[usageQuality]) usageQuality = round.usageQuality
    }

    return {
        durationMs,
        inputTokens,
        outputTokens,
        cacheWriteTokens,
        cacheReadTokens,
        ...(totalCost !== undefined ? { totalCost } : {}),
        ...(currency !== undefined ? { currency } : {}),
        ...(durationMs > 0 ? { averageTokensPerSecond: (outputTokens * 1000) / durationMs } : {}),
        usageQuality,
    }
}

/** "480ms", "12.4s", "1m 05s" — a duration a reader can compare at a glance. */
export function formatDuration(durationMs: number): string {
    if (durationMs < 1000) return `${Math.round(durationMs)}ms`
    if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`
    const minutes = Math.floor(durationMs / 60_000)
    const seconds = Math.round((durationMs % 60_000) / 1000)
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`
}

/** "980", "3.2k", "1.4M" — compact enough to sit in a fold header. */
export function formatTokens(tokens: number): string {
    if (tokens < 1_000) return String(Math.round(tokens))
    if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`
    return `${(tokens / 1_000_000).toFixed(1)}M`
}

/**
 * The cost line of a folded block, such as "12.4s · 3.2k in / 1.1k out · 258 tok/s".
 *
 * Approximate figures say so: a block whose rounds did not all report exact usage
 * is prefixed with `~`, so a reader never mistakes an estimate for a measurement.
 */
export function describeFoldUsage(usage: FoldUsage): string {
    const approximate = usage.usageQuality === "exact" ? "" : "~"
    const parts: string[] = []
    if (usage.durationMs > 0) parts.push(`${approximate}${formatDuration(usage.durationMs)}`)
    if (usage.inputTokens + usage.outputTokens > 0) {
        parts.push(`${approximate}${formatTokens(usage.inputTokens)} in / ${formatTokens(usage.outputTokens)} out`)
    }
    if (usage.averageTokensPerSecond !== undefined && Number.isFinite(usage.averageTokensPerSecond)) {
        parts.push(`${approximate}${Math.round(usage.averageTokensPerSecond)} tok/s`)
    }
    return parts.join(" · ")
}
