import { type ContextWindowIndicatorLineage, getContextWindowIndicatorTotalTokens } from "@shared/context-window-indicator"
import { describe, expect, it } from "vitest"
import { ContextWindowIndicator } from "../ContextWindowIndicator"

const firstRound: ContextWindowIndicatorLineage = {
    kind: "ordinary",
    requestId: "request-durable-lifecycle-1",
    requestSequence: 1,
    attemptId: "attempt-0",
}

const secondRound: ContextWindowIndicatorLineage = {
    kind: "ordinary",
    requestId: "request-durable-lifecycle-2",
    requestSequence: 2,
    attemptId: "attempt-0",
}

function createIndicator(): ContextWindowIndicator {
    return new ContextWindowIndicator({
        taskId: "task-durable-lifecycle",
        durableContextTokens: 100,
        environmentTokens: 50,
        contextWindow: 1_000,
        mode: "act",
        updatedAt: 1,
    })
}

describe("ContextWindowIndicator durable lifecycle", () => {
    it("stages a completed round until the next send promotes it into Durable", () => {
        const indicator = createIndicator()

        indicator.beginSend({
            lineage: firstRound,
            durableContextTokens: 100,
            pendingSendTokens: 300,
            environmentTokens: 50,
            contextWindow: 1_000,
            mode: "act",
        })
        indicator.receive({ lineage: firstRound, receivingTokens: 40, updatedAt: 2 })

        const settled = indicator.settle({ lineage: firstRound, updatedAt: 3 })

        expect(settled.phase).toBe("stable")
        expect(settled.durableContextTokens).toBe(100)
        expect(settled.pendingSendTokens).toBe(0)
        expect(settled.receivingTokens).toBe(0)
        expect(settled.stagedTokens).toBe(340)
        expect(settled.environmentTokens).toBe(50)
        expect(getContextWindowIndicatorTotalTokens(settled)).toBe(490)
    })

    it("keeps the committed prefix stable when the next request starts", () => {
        const indicator = createIndicator()

        indicator.beginSend({
            lineage: firstRound,
            durableContextTokens: 100,
            pendingSendTokens: 300,
            environmentTokens: 50,
            contextWindow: 1_000,
            mode: "act",
        })
        indicator.receive({
            lineage: firstRound,
            receivingTokens: 40,
            authoritativeContextTokens: 490,
        })
        indicator.settle({ lineage: firstRound })

        const nextSend = indicator.beginSend({
            lineage: secondRound,
            durableContextTokens: 100,
            pendingSendTokens: 370,
            environmentTokens: 50,
            contextWindow: 1_000,
            mode: "act",
        })

        expect(nextSend.phase).toBe("sending")
        expect(nextSend.durableContextTokens).toBe(440)
        expect(nextSend.pendingSendTokens).toBe(30)
        expect(nextSend.stagedTokens).toBe(0)
    })

    it("does not commit the same completed round twice", () => {
        const indicator = createIndicator()

        indicator.beginSend({
            lineage: firstRound,
            durableContextTokens: 100,
            pendingSendTokens: 300,
            environmentTokens: 50,
            contextWindow: 1_000,
            mode: "act",
        })
        indicator.receive({ lineage: firstRound, receivingTokens: 40 })

        const settled = indicator.settle({ lineage: firstRound })
        const repeated = indicator.settle({ lineage: firstRound })

        expect(repeated).toEqual(settled)
        expect(repeated.durableContextTokens).toBe(100)
        expect(repeated.stagedTokens).toBe(340)
    })
})
