import type { ContextWindowIndicatorLineage } from "@shared/context-window-indicator"
import { describe, expect, it } from "vitest"
import { ContextWindowIndicator } from "../ContextWindowIndicator"

function createIndicator(): ContextWindowIndicator {
    return new ContextWindowIndicator({
        taskId: "task-fold-round",
        durableContextTokens: 100,
        environmentTokens: 20,
        contextWindow: 1_000,
        mode: "act",
    })
}

const ordinaryLineage: ContextWindowIndicatorLineage = {
    kind: "ordinary",
    requestId: "ordinary:task-fold-round:1",
    requestSequence: 1,
    attemptId: "attempt-0",
}

describe("ContextWindowIndicator round folding", () => {
    it("uses the Provider-reported context snapshot instead of accumulating local request estimates", () => {
        const indicator = createIndicator()
        indicator.beginSend({
            lineage: ordinaryLineage,
            durableContextTokens: 0,
            pendingSendTokens: 16_000,
            environmentTokens: 30,
            contextWindow: 272_000,
            mode: "act",
        })
        indicator.receive({ lineage: ordinaryLineage, receivingTokens: 100 })

        const foldRound = indicator.foldRound as unknown as (input: {
            lineage: ContextWindowIndicatorLineage
            authoritativeContextTokens: number
        }) => ReturnType<ContextWindowIndicator["getSnapshot"]>
        const folded = foldRound.call(indicator, { lineage: ordinaryLineage, authoritativeContextTokens: 140_100 })

        expect(folded.phase).toBe("committing")
        expect(folded.durableContextTokens).toBe(140_070)
        expect(folded.pendingSendTokens).toBe(0)
        expect(folded.receivingTokens).toBe(0)
        expect(folded.environmentTokens).toBe(30)
        expect(folded.durableContextTokens + folded.environmentTokens).toBe(140_100)
    })

    it("never folds the dynamic ENV segment into durable", () => {
        const indicator = createIndicator()
        indicator.beginSend({
            lineage: ordinaryLineage,
            durableContextTokens: 100,
            pendingSendTokens: 300,
            environmentTokens: 50,
            contextWindow: 1_000,
            mode: "act",
        })

        const folded = indicator.foldRound({ lineage: ordinaryLineage })
        expect(folded.durableContextTokens).toBe(400)
        expect(folded.environmentTokens).toBe(50)

        const settled = indicator.settle({ lineage: folded.lineage })
        expect(settled.durableContextTokens).toBe(400)
        expect(settled.environmentTokens).toBe(50)
    })

    it("rejects a stale lineage without folding", () => {
        const indicator = createIndicator()
        indicator.beginSend({
            lineage: ordinaryLineage,
            durableContextTokens: 100,
            pendingSendTokens: 300,
            environmentTokens: 50,
            contextWindow: 1_000,
            mode: "act",
        })
        const before = indicator.getSnapshot()

        const result = indicator.foldRound({ lineage: { ...ordinaryLineage, attemptId: "attempt-99" } })

        expect(result).toEqual(before)
        expect(indicator.getSnapshot()).toEqual(before)
    })

    it("is a no-op when nothing is pending to fold", () => {
        const indicator = createIndicator()
        const before = indicator.getSnapshot()

        const result = indicator.foldRound({ lineage: before.lineage })

        expect(result).toEqual(before)
    })
})
