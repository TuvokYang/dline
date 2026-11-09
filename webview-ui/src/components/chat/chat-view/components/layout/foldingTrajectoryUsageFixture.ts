import type { FoldRoundUsage } from "@shared/chat/foldUsage"
import type { UiMessage } from "@shared/ExtensionMessage"
import { indexRequestRounds } from "../../utils/messageUtils"

/**
 * Usage records for the folding stories.
 *
 * The chat reads these from the task's request-round records, which are the same
 * figures the rate metrics and usage telemetry report. A story has no task behind
 * it, so it receives a fixed transcript-shaped list instead: one record per
 * provider send, in the order `indexRequestRounds` numbers them.
 *
 * The numbers are deliberately uneven — a fast round, a slow one and a round that
 * only returned a little — so a reader can see that a fold sums the rounds it
 * actually holds rather than repeating one figure.
 */
const ROUND_PATTERNS = [
    { providerDurationMs: 6_400, inputTokens: 8_200, outputTokens: 640 },
    { providerDurationMs: 11_900, inputTokens: 9_100, outputTokens: 1_420 },
    { providerDurationMs: 3_100, inputTokens: 9_600, outputTokens: 180 },
    { providerDurationMs: 8_700, inputTokens: 10_400, outputTokens: 950 },
    { providerDurationMs: 2_400, inputTokens: 10_900, outputTokens: 120 },
    { providerDurationMs: 14_200, inputTokens: 11_800, outputTokens: 1_760 },
    { providerDurationMs: 5_600, inputTokens: 12_300, outputTokens: 520 },
] as const

/** One record per request round the transcript actually contains. */
export function createFoldRoundUsage(messages: readonly UiMessage[]): FoldRoundUsage[] {
    const rounds = indexRequestRounds(messages as UiMessage[])
    const providerRounds = [...new Set(rounds.values())].filter((round) => round > 0).sort((left, right) => left - right)

    return providerRounds.map((_round, position) => {
        const pattern = ROUND_PATTERNS[position % ROUND_PATTERNS.length]
        const cycle = Math.floor(position / ROUND_PATTERNS.length)
        return {
            roundId: `round-${position + 1}`,
            providerDurationMs: pattern.providerDurationMs,
            inputTokens: pattern.inputTokens,
            outputTokens: pattern.outputTokens,
            cacheWriteTokens: cycle === 0 ? Math.round(pattern.inputTokens / 4) : 0,
            cacheReadTokens: cycle === 0 ? 0 : Math.round(pattern.inputTokens / 2),
            totalCost: (pattern.inputTokens * 3 + pattern.outputTokens * 15) / 1_000_000,
            currency: "USD",
            usageQuality: "exact" as const,
        }
    })
}
