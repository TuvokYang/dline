import { describe, expect, it } from "vitest"
import {
    buildSummaryRefitGuidance,
    createSummaryRefitIdentity,
    formatSummaryRefitFailure,
    MAX_SUMMARY_REFIT_ATTEMPTS,
    resolveSummaryRefitCarryLimit,
} from "../summary-refit"
import type { TargetWindowFittingState } from "../target-window-fitting"

const state = {
    operationId: "operation-refit",
    passIndex: 1,
    passStartTurnIndex: 1,
    passEndTurnIndex: 0,
    coveredTurnCount: 1,
    summaryBaselineHash: "sha256:summary",
    sourceHistoryHash: "sha256:source",
    passStartMessageIndex: 2,
    passEndMessageIndex: 1,
} as TargetWindowFittingState

const overflow = {
    kind: "summary_carry_overflow" as const,
    turnIndex: 1,
    candidateEstimateCount: 3,
    requestEnvelopeTokens: 100,
    summaryCarryTokens: 350,
    turnTokens: 200,
    combinedEstimatedInputTokens: 650,
    passInputCeiling: 500,
}

describe("summary refit", () => {
    it("reserves the next turn and shared estimation tolerance from the carry limit", () => {
        expect(resolveSummaryRefitCarryLimit(overflow)).toBe(0)
        expect(
            resolveSummaryRefitCarryLimit({
                ...overflow,
                passInputCeiling: 5_000,
                requestEnvelopeTokens: 500,
                turnTokens: 1_000,
            }),
        ).toBe(1_500)
    })

    it("creates a stable refit identity without advancing Pass or coverage coordinates", () => {
        const first = createSummaryRefitIdentity(state, 0)
        const second = createSummaryRefitIdentity(state, 1)

        expect(first).toMatchObject({
            operationId: "operation-refit",
            passIndex: 1,
            passStartTurnIndex: 1,
            passEndTurnIndex: 0,
            coveredTurnCount: 1,
            summaryBaselineHash: "sha256:summary",
        })
        expect(first.passHistoryHash).toMatch(/^sha256:/)
        expect(second.passHistoryHash).not.toBe(first.passHistoryHash)
    })

    it("renders a bounded refit instruction and carry-specific terminal diagnostic", () => {
        const guidance = buildSummaryRefitGuidance(1_500, 1)
        expect(guidance).toContain("hard limit of 1500 tokens")
        expect(guidance).toContain(`attempt 1 of ${MAX_SUMMARY_REFIT_ATTEMPTS}`)
        expect(formatSummaryRefitFailure(overflow, 2, 0)).toContain("Cumulative summary refit exhausted after 2 attempt(s)")
        expect(formatSummaryRefitFailure(overflow, 2, 0)).toContain("request envelope 100")
        expect(formatSummaryRefitFailure(overflow, 2, 0)).toContain("logical turn 200")
    })
})
