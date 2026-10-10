import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { collectContextWindowRequestPressures, readContextWindowRequestPressure } from "../context-pressure"
import { resolveContextWindowProjection } from "../context-window-projection"

/**
 * Reproduce the previous whole-history scan that ignored the compaction boundary.
 *
 * @param messages The chat messages in chronological order.
 * @returns Pressure records parsed from every persisted API request.
 */
function collectPressuresWithoutCompactionBoundary(messages: readonly UiMessage[]) {
    return messages.flatMap((message) => {
        if (message.say !== "api_req_started") return []
        const pressure = readContextWindowRequestPressure(message.text)
        return pressure === undefined ? [] : [pressure]
    })
}

/**
 * P0 regression guard for the inflated context shown on the first request after a
 * successful compaction.
 *
 * Request pressure was collected from the whole chat history, so the pre-compaction
 * provider occupancy stayed the newest reliable baseline until fresh provider usage
 * arrived. The TaskHeader therefore reported the pre-compaction context for a request
 * that actually carried only the summary.
 */

/**
 * Build one persisted API request message.
 *
 * @param ts The message timestamp.
 * @param info The persisted request pressure metadata.
 * @returns The api_req_started chat message.
 */
function apiRequest(ts: number, info: Record<string, unknown>): UiMessage {
    return { ts, type: "say", say: "api_req_started", text: JSON.stringify(info) } as UiMessage
}

/**
 * Build one compaction card.
 *
 * @param ts The message timestamp.
 * @param compactionStatus The compaction lifecycle status carried by the card.
 * @returns The summarizeTask chat message.
 */
function compactionCard(ts: number, compactionStatus: "completed" | "failed"): UiMessage {
    return {
        ts,
        type: "say",
        say: "tool",
        partial: false,
        text: JSON.stringify({ tool: "summarizeTask", content: "summary", compactionStatus }),
    } as UiMessage
}

const PRE_COMPACTION_PROVIDER_TOKENS = 440_000
const POST_COMPACTION_CANDIDATE_TOKENS = 42_000
const CONTEXT_WINDOW = 472_000

describe("context window request pressure after compaction", () => {
    it("drops provider occupancy recorded before a completed compaction", () => {
        const messages = [
            apiRequest(1, {
                contextTokens: PRE_COMPACTION_PROVIDER_TOKENS,
                estimatedContextTokens: PRE_COMPACTION_PROVIDER_TOKENS,
                contextTokensSource: "provider",
            }),
            compactionCard(2, "completed"),
        ]

        expect(collectContextWindowRequestPressures(messages)).toEqual([])
    })

    it("reports the compacted context on the first post-compaction request", () => {
        const messages = [
            apiRequest(1, {
                contextTokens: PRE_COMPACTION_PROVIDER_TOKENS,
                estimatedContextTokens: PRE_COMPACTION_PROVIDER_TOKENS,
                contextTokensSource: "provider",
            }),
            compactionCard(2, "completed"),
        ]

        const projection = resolveContextWindowProjection({
            requestInfos: collectContextWindowRequestPressures(messages),
            candidateEstimatedTokens: POST_COMPACTION_CANDIDATE_TOKENS,
            contextWindow: CONTEXT_WINDOW,
            triggerTokens: CONTEXT_WINDOW,
        })

        expect(projection.projectedUsageTokens).toBe(POST_COMPACTION_CANDIDATE_TOKENS)
        expect(projection.baselineTokens).toBe(0)
    })

    it("keeps pressure recorded after the completed compaction", () => {
        const messages = [
            apiRequest(1, {
                contextTokens: PRE_COMPACTION_PROVIDER_TOKENS,
                contextTokensSource: "provider",
            }),
            compactionCard(2, "completed"),
            apiRequest(3, { contextTokens: 48_000, estimatedContextTokens: 47_000, contextTokensSource: "provider" }),
        ]

        expect(collectContextWindowRequestPressures(messages)).toEqual([
            { contextTokens: 48_000, estimatedContextTokens: 47_000, contextTokensSource: "provider" },
        ])
    })

    it("differs from the previous whole-history scan that inflated the first request", () => {
        const messages = [
            apiRequest(1, {
                contextTokens: PRE_COMPACTION_PROVIDER_TOKENS,
                estimatedContextTokens: PRE_COMPACTION_PROVIDER_TOKENS,
                contextTokensSource: "provider",
            }),
            compactionCard(2, "completed"),
        ]
        const projectionInput = {
            candidateEstimatedTokens: POST_COMPACTION_CANDIDATE_TOKENS,
            contextWindow: CONTEXT_WINDOW,
            triggerTokens: CONTEXT_WINDOW,
        }

        const regressed = resolveContextWindowProjection({
            ...projectionInput,
            requestInfos: collectPressuresWithoutCompactionBoundary(messages),
        })
        const fixed = resolveContextWindowProjection({
            ...projectionInput,
            requestInfos: collectContextWindowRequestPressures(messages),
        })

        // The old scan reported the entire pre-compaction context for a summary-only request.
        expect(regressed.projectedUsageTokens).toBe(PRE_COMPACTION_PROVIDER_TOKENS)
        expect(fixed.projectedUsageTokens).toBe(POST_COMPACTION_CANDIDATE_TOKENS)
    })

    it("keeps pre-compaction pressure when the compaction failed", () => {
        // A failed compaction leaves the conversation untouched, so its occupancy still counts.
        const messages = [
            apiRequest(1, { contextTokens: PRE_COMPACTION_PROVIDER_TOKENS, contextTokensSource: "provider" }),
            compactionCard(2, "failed"),
        ]

        expect(collectContextWindowRequestPressures(messages)).toEqual([
            { contextTokens: PRE_COMPACTION_PROVIDER_TOKENS, contextTokensSource: "provider" },
        ])
    })

    it("cuts at the latest completed compaction when several exist", () => {
        const messages = [
            apiRequest(1, { contextTokens: 400_000, contextTokensSource: "provider" }),
            compactionCard(2, "completed"),
            apiRequest(3, { contextTokens: 300_000, contextTokensSource: "provider" }),
            compactionCard(4, "completed"),
            apiRequest(5, { contextTokens: 50_000, contextTokensSource: "provider" }),
        ]

        expect(collectContextWindowRequestPressures(messages)).toEqual([
            { contextTokens: 50_000, contextTokensSource: "provider" },
        ])
    })
})
