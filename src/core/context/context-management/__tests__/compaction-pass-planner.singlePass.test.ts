import type { ClineStorageMessage } from "@shared/messages/content"
import { describe, expect, it } from "vitest"
import { planNextCompactionPass } from "../compaction-pass-planner"
import { createCompactionSourceSnapshot } from "../compaction-source-snapshot"
import { indexLogicalTurns } from "../logical-turns"
import { startTargetWindowFitting } from "../target-window-fitting"

/**
 * P0 regression guard: a conversation that fits the Pass ceiling must be compacted
 * in exactly one Pass.
 *
 * The planner calibrated `tokenScale` from the first uncovered turn and extrapolated
 * linearly over the raw source snapshot. A first turn whose exact request cost is far
 * higher than its raw snapshot size inflates that scale, so the approximation projects
 * the whole range as oversized and the bounded calibration loop can no longer reach the
 * end of the conversation. The result was several Passes for a range that fits in one,
 * and a first post-compaction request carrying far less context than the window allows.
 */

const EXPENSIVE_MARKER = "EXPENSIVE"
const FILLER = "f".repeat(4_000)

/**
 * Build one logical turn.
 *
 * @param index The turn ordinal used in the rendered text.
 * @param expensive Whether the turn is cheap in raw size but expensive to request.
 * @returns The user/assistant message pair forming the logical turn.
 */
function turn(index: number, expensive: boolean): ClineStorageMessage[] {
    const body = expensive ? EXPENSIVE_MARKER : FILLER
    return [
        { role: "user", content: [{ type: "text", text: `<task>turn ${index} ${body}</task>` }] },
        { role: "assistant", content: [{ type: "text", text: `reply ${index} ${body}` }] },
    ]
}

/**
 * Build a history whose first turn is small on disk but dominates the request estimate.
 *
 * @returns The storage messages for nine logical turns.
 */
function buildHistory(): ClineStorageMessage[] {
    const history: ClineStorageMessage[] = [...turn(0, true)]
    for (let index = 1; index < 9; index++) history.push(...turn(index, false))
    return history
}

/**
 * Start target-window fitting for the given history.
 *
 * @param history The storage messages to index into logical turns.
 * @returns The initial fitting state.
 */
function startState(history: ClineStorageMessage[]) {
    const snapshot = createCompactionSourceSnapshot(history)
    return startTargetWindowFitting(indexLogicalTurns(history), "operation-single-pass", snapshot)
}

const REQUEST_ENVELOPE_TOKENS = 100
const EXPENSIVE_MESSAGE_TOKENS = 5_000
const CHEAP_MESSAGE_TOKENS = 10

/**
 * Estimate exact request tokens with a cost that is intentionally uncorrelated with raw size.
 *
 * @param messages The candidate Pass history.
 * @returns The estimated request input tokens.
 */
function estimateInputTokens(messages: readonly ClineStorageMessage[]): number {
    return messages.reduce(
        (total, message) =>
            total +
            (JSON.stringify(message.content).includes(EXPENSIVE_MARKER) ? EXPENSIVE_MESSAGE_TOKENS : CHEAP_MESSAGE_TOKENS),
        REQUEST_ENVELOPE_TOKENS,
    )
}

const FULL_RANGE_TOKENS = REQUEST_ENVELOPE_TOKENS + 2 * EXPENSIVE_MESSAGE_TOKENS + 16 * CHEAP_MESSAGE_TOKENS

describe("compaction Pass planner single-Pass selection", () => {
    it("covers every uncovered turn in one Pass when the full range fits the ceiling", async () => {
        const state = startState(buildHistory())

        const result = await planNextCompactionPass({
            state,
            passInputCeiling: FULL_RANGE_TOKENS + 1_000,
            estimateInputTokens,
        })

        expect(result.kind).toBe("planned")
        if (result.kind !== "planned") return
        expect(result.plan.passStartTurnIndex).toBe(0)
        expect(result.plan.passEndTurnIndex).toBe(state.turns.length - 1)
    })

    it("keeps a full range that exactly reaches the ceiling in one Pass", async () => {
        const state = startState(buildHistory())

        // The caller already folded the reserve concession into the ceiling, so a range landing
        // exactly on it must never be split into an extra Pass.
        const result = await planNextCompactionPass({
            state,
            passInputCeiling: FULL_RANGE_TOKENS,
            estimateInputTokens,
        })

        expect(result.kind).toBe("planned")
        if (result.kind !== "planned") return
        expect(result.plan.passEndTurnIndex).toBe(state.turns.length - 1)
        expect(result.plan.estimatedInputTokens).toBe(FULL_RANGE_TOKENS)
    })

    it("splits when the full range exceeds the ceiling", async () => {
        const state = startState(buildHistory())

        const result = await planNextCompactionPass({
            state,
            // Only the expensive first turn plus a few cheap turns can fit.
            passInputCeiling: REQUEST_ENVELOPE_TOKENS + 2 * EXPENSIVE_MESSAGE_TOKENS + 4 * CHEAP_MESSAGE_TOKENS,
            estimateInputTokens,
        })

        expect(result.kind).toBe("planned")
        if (result.kind !== "planned") return
        expect(result.plan.passEndTurnIndex).toBeLessThan(state.turns.length - 1)
    })
})
