import type { FoldRoundUsage, FoldUsageQuality } from "@shared/chat/foldUsage"
import { type TaskRateMetricPoint, TaskRateUsageQuality } from "@shared/proto/dline/task"

/**
 * Project the task's Provider rounds into the figures a folded block states.
 *
 * The RPC is the only authority for a round's generation time, so the header
 * never derives a duration from message payloads. Everything a round cannot
 * support is left absent instead of being reported as zero, which is what makes
 * the header fall silent rather than claim `0ms`.
 */
export function projectRoundUsage(points: readonly TaskRateMetricPoint[]): FoldRoundUsage[] {
    return points.flatMap((point) => {
        // A minute/hour/day bucket is an aggregate, not one provider send.
        if (point.roundId === undefined || point.roundId === "") return []
        // A round that reported no usage at all states nothing rather than a zero.
        // Keeping it would only add an empty entry the header cannot print.
        if (!hasAnyFigure(point)) return []
        const usage: FoldRoundUsage = {
            roundId: point.roundId,
            ...(positive(point.providerDurationMs) ? { providerDurationMs: point.providerDurationMs } : {}),
            ...(defined(point.inputTokens) ? { inputTokens: point.inputTokens } : {}),
            ...(defined(point.outputTokens) ? { outputTokens: point.outputTokens } : {}),
            ...(defined(point.cacheWriteTokens) ? { cacheWriteTokens: point.cacheWriteTokens } : {}),
            ...(defined(point.cacheReadTokens) ? { cacheReadTokens: point.cacheReadTokens } : {}),
            ...(defined(point.totalCost) ? { totalCost: point.totalCost } : {}),
            ...(point.currency ? { currency: point.currency } : {}),
            usageQuality: toUsageQuality(point.usageQuality),
        }
        return [usage]
    })
}

/**
 * The transcript round each Provider round belongs to, keyed by round number.
 *
 * `readRecentHistory` returns the newest rounds still retained, so a long task
 * has fewer records than provider sends. Counting from the end is what keeps a
 * record bound to the send it actually measured instead of sliding onto an
 * earlier one.
 */
export function indexRoundNumbers(roundNumbers: readonly number[], recordCount: number): Map<number, number> {
    const byRound = new Map<number, number>()
    if (recordCount <= 0) return byRound
    const tail = roundNumbers.slice(-recordCount)
    const offset = recordCount - tail.length
    tail.forEach((round, index) => byRound.set(round, index + offset))
    return byRound
}

/** Whether the round states at least one figure the header can print. */
function hasAnyFigure(point: TaskRateMetricPoint): boolean {
    return (
        positive(point.providerDurationMs) ||
        defined(point.inputTokens) ||
        defined(point.outputTokens) ||
        defined(point.totalCost)
    )
}

function toUsageQuality(quality: TaskRateUsageQuality): FoldUsageQuality {
    switch (quality) {
        case TaskRateUsageQuality.TASK_RATE_USAGE_QUALITY_EXACT:
            return "exact"
        case TaskRateUsageQuality.TASK_RATE_USAGE_QUALITY_ESTIMATED:
        case TaskRateUsageQuality.TASK_RATE_USAGE_QUALITY_MIXED:
            return "estimated"
        case TaskRateUsageQuality.TASK_RATE_USAGE_QUALITY_LEGACY:
            return "legacy"
        default:
            return "none"
    }
}

function defined(value: number | undefined): value is number {
    return value !== undefined && Number.isFinite(value)
}

function positive(value: number | undefined): value is number {
    return defined(value) && value > 0
}
