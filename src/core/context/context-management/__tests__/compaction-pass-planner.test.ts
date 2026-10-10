import type { ClineStorageMessage } from "@shared/messages/content"
import { describe, expect, it } from "vitest"
import { planNextCompactionPass } from "../compaction-pass-planner"
import { createCompactionSourceSnapshot } from "../compaction-source-snapshot"
import { indexLogicalTurns } from "../logical-turns"
import { startTargetWindowFitting } from "../target-window-fitting"

function message(role: "user" | "assistant", text: string): ClineStorageMessage {
    return { role, content: [{ type: "text", text }] }
}

function createHistory(): ClineStorageMessage[] {
    return createTurnHistory(["A", "B", "C"])
}

function createTurnHistory(markers: readonly string[]): ClineStorageMessage[] {
    return markers.flatMap((marker, index) => [
        message("user", index === 0 ? `<task>Turn ${marker}</task>` : `<user_message>Turn ${marker}</user_message>`),
        message("assistant", `Response ${marker}`),
    ])
}

function startFitting(history: readonly ClineStorageMessage[], operationId: string) {
    const snapshot = createCompactionSourceSnapshot(history)
    return startTargetWindowFitting(indexLogicalTurns(snapshot.messages), operationId, snapshot)
}

function estimateByTurnMarkers(messages: readonly ClineStorageMessage[]): number {
    const text = JSON.stringify(messages)
    return 100 + ["Turn A", "Turn B", "Turn C"].filter((marker) => text.includes(marker)).length * 100
}

describe("compaction Pass planner", () => {
    it("packs every consecutive complete turn that fits before the first overflowing turn", async () => {
        const state = startFitting(createHistory(), "operation-maximal-batch")

        const result = await planNextCompactionPass({
            state,
            passInputCeiling: 350,
            estimateInputTokens: estimateByTurnMarkers,
        })

        expect(result).toMatchObject({
            kind: "planned",
            plan: {
                passStartTurnIndex: 0,
                passEndTurnIndex: 1,
                passStartMessageIndex: 0,
                passEndMessageIndex: 3,
                estimatedInputTokens: 300,
                passInputCeiling: 350,
            },
        })
        if (result.kind !== "planned") throw new Error("Expected a planned compaction Pass")
        expect(result.plan.sourceHistoryHash).toMatch(/^sha256:[a-f0-9]{64}$/)
        expect(result.plan.rangeHash).toMatch(/^sha256:[a-f0-9]{64}$/)
        expect(result.plan.rangeHash).not.toBe(result.plan.sourceHistoryHash)
    })

    it("includes the cumulative summary in the next Pass estimate", async () => {
        const state = {
            ...startFitting(createHistory(), "operation-summary-baseline"),
            coveredTurnCount: 1,
            passIndex: 1,
            cumulativeSummary: "SUMMARY_BASELINE",
        }
        const estimatedInputs: string[] = []

        const result = await planNextCompactionPass({
            state,
            passInputCeiling: 260,
            estimateInputTokens: (messages) => {
                const text = JSON.stringify(messages)
                estimatedInputs.push(text)
                return (
                    100 +
                    (text.includes("SUMMARY_BASELINE") ? 50 : 0) +
                    (text.includes("Turn B") ? 100 : 0) +
                    (text.includes("Turn C") ? 100 : 0)
                )
            },
        })

        expect(result).toMatchObject({
            kind: "planned",
            plan: {
                passStartTurnIndex: 1,
                passEndTurnIndex: 1,
                estimatedInputTokens: 250,
                summaryCarryTokens: 50,
            },
        })
        expect(estimatedInputs.some((input) => input.includes("SUMMARY_BASELINE") && input.includes("Turn B"))).toBe(true)
    })

    it("classifies cumulative-summary carry overflow without blaming the next logical turn", async () => {
        const state = {
            ...startFitting(createHistory(), "operation-carry-overflow"),
            coveredTurnCount: 1,
            passIndex: 1,
            cumulativeSummary: "SUMMARY_CARRY",
        }

        const result = await planNextCompactionPass({
            state,
            passInputCeiling: 300,
            estimateInputTokens: (messages) => {
                const text = JSON.stringify(messages)
                return 100 + (text.includes("SUMMARY_CARRY") ? 180 : 0) + (text.includes("Turn B") ? 100 : 0)
            },
        })

        expect(result).toEqual({
            kind: "summary_carry_overflow",
            turnIndex: 1,
            candidateEstimateCount: 3,
            requestEnvelopeTokens: 100,
            summaryCarryTokens: 180,
            turnTokens: 100,
            combinedEstimatedInputTokens: 380,
            passInputCeiling: 300,
        })
    })

    it("uses the summary-safe hard ceiling only for an indivisible single turn", async () => {
        const state = startFitting(createHistory(), "operation-single-turn-hard-ceiling")

        const result = await planNextCompactionPass({
            state,
            passInputCeiling: 199,
            singleTurnInputCeiling: 200,
            estimateInputTokens: estimateByTurnMarkers,
        })

        expect(result).toMatchObject({
            kind: "planned",
            plan: {
                passStartTurnIndex: 0,
                passEndTurnIndex: 0,
                estimatedInputTokens: 200,
                passInputCeiling: 199,
            },
        })
    })

    it("reports a true single-turn overflow using the turn-only estimate", async () => {
        const state = startFitting(createHistory(), "operation-too-large-turn")

        const result = await planNextCompactionPass({
            state,
            passInputCeiling: 199,
            estimateInputTokens: estimateByTurnMarkers,
        })

        expect(result).toEqual({
            kind: "single_turn_overflow",
            turnIndex: 0,
            candidateEstimateCount: 2,
            requestEnvelopeTokens: 100,
            summaryCarryTokens: 0,
            turnTokens: 100,
            combinedEstimatedInputTokens: 200,
            passInputCeiling: 199,
        })
    })

    it("uses logarithmic exact request estimates when locating the maximal fitting turn range", async () => {
        const markers = Array.from({ length: 32 }, (_, index) => `M${index}`)
        const state = startFitting(createTurnHistory(markers), "operation-binary-search")
        let estimateCount = 0

        const result = await planNextCompactionPass({
            state,
            passInputCeiling: 1_700,
            estimateInputTokens: (messages) => {
                estimateCount += 1
                return 100 + messages.filter((message) => message.role === "user").length * 100
            },
        })

        expect(result).toMatchObject({
            kind: "planned",
            plan: { passStartTurnIndex: 0, passEndTurnIndex: 15, estimatedInputTokens: 1_700 },
        })
        if (result.kind !== "planned") throw new Error("Expected a planned compaction Pass")
        expect(result.plan.candidateEstimateCount).toBe(estimateCount)
        // Full-range, seeded, and adjacent-overflow probes preserve an exact maximality proof while
        // keeping candidate estimation logarithmic instead of scanning every turn.
        expect(estimateCount).toBeLessThanOrEqual(10)
    })
})
