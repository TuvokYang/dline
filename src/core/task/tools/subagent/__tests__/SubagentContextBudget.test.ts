import { ContextBudgetLedger } from "@core/context/context-management/context-budget-ledger"
import { describe, expect, it } from "vitest"
import { describeContextBudget, renderContextBudgetSection, resolveFinalResultTokens } from "../SubagentContextBudget"

function ledgerWith(occupied: number): ContextBudgetLedger {
    return new ContextBudgetLedger({
        contextWindow: () => 100_000,
        occupiedTokens: () => occupied,
        tokenPerByte: () => 0.25,
    })
}

describe("resolveFinalResultTokens", () => {
    it("keeps the configured budget when no main-task budget is attached", () => {
        expect(resolveFinalResultTokens(8_000, undefined)).toBe(8_000)
    })

    it("keeps the configured budget when the share is larger", () => {
        const parent = ledgerWith(20_000).begin()
        const child = parent.child()
        parent.child()

        expect(resolveFinalResultTokens(8_000, child)).toBe(8_000)
    })

    it("caps the result at the share of parallel subagents", () => {
        const parent = ledgerWith(20_000).begin()
        const child = parent.child()
        parent.child()

        // 80K of context left: the round may take 64K, split between two subagents.
        expect(resolveFinalResultTokens(50_000, child)).toBe(32_000)
    })

    it("shrinks the share when a sibling result returns", () => {
        const parent = ledgerWith(20_000).begin()
        const first = parent.child()
        const second = parent.child()
        parent.child()

        expect(resolveFinalResultTokens(50_000, second)).toBe(21_333)

        // 160K bytes = 40K tokens staged; 24K of the round's 64K left for the two still working.
        first.end(160_000)

        expect(resolveFinalResultTokens(50_000, second)).toBe(12_000)
    })

    it("caps the result at the share even when the share is small", () => {
        // 4K tokens left: the round may take 3.2K, and the only working subagent gets all of it.
        const child = ledgerWith(96_000).begin().child()

        expect(resolveFinalResultTokens(8_000, child)).toBe(3_200)
    })

    it("keeps a wide fan-out within the round's budget", () => {
        // 10K left: the round may take 8K, split among 32 subagents.
        const parent = ledgerWith(90_000).begin()
        const children = Array.from({ length: 32 }, () => parent.child())

        const shares = children.map((child) => resolveFinalResultTokens(8_000, child))

        expect(shares[0]).toBe(250)
        expect(shares.reduce((total, tokens) => total + tokens, 0)).toBeLessThanOrEqual(8_000)
    })

    it("keeps the configured budget once the main task must yield, because the result is held whole", () => {
        // Below the 3K yield margin the result waits for compaction instead of
        // entering the conversation, so a share cut would only lose it.
        expect(resolveFinalResultTokens(8_000, ledgerWith(99_500).begin().child())).toBe(8_000)
        expect(resolveFinalResultTokens(8_000, ledgerWith(100_000).begin().child())).toBe(8_000)
    })
})

describe("describeContextBudget", () => {
    it("states only the configured final-result budget without a main-task budget", () => {
        expect(describeContextBudget(undefined, 8_000)).toEqual({ finalResultTokens: 8_000, delivery: "inline" })
    })

    it("ties the main task's round figures to the final result's share", () => {
        const parent = ledgerWith(20_000).begin()
        const child = parent.child()
        parent.child()

        expect(describeContextBudget(child, 50_000)).toEqual({
            finalResultTokens: 32_000,
            delivery: "inline",
            mainTaskRound: { budgetTokens: 64_000, usedTokens: 0, workingConsumers: 2 },
        })
    })

    it("drops the share once the main task must yield, because the result is held whole", () => {
        const child = ledgerWith(98_000).begin().child()

        expect(describeContextBudget(child, 8_000)).toEqual({ finalResultTokens: 8_000, delivery: "held_until_compaction" })
    })
})

describe("renderContextBudgetSection", () => {
    const unresolved = /@[A-Z_]+@|\[MISSING:/

    it("fills every runtime figure for each delivery shape", () => {
        const shapes = [
            { finalResultTokens: 8_000, delivery: "inline" },
            { finalResultTokens: 8_000, delivery: "held_until_compaction" },
            {
                finalResultTokens: 32_000,
                delivery: "inline",
                mainTaskRound: { budgetTokens: 64_000, usedTokens: 1_500, workingConsumers: 2 },
            },
        ] as const

        for (const facts of shapes) {
            expect(renderContextBudgetSection(facts)).not.toMatch(unresolved)
        }
    })

    it("renders one more line for the share and one for held delivery", () => {
        const lineCount = (text: string) => text.split("\n").length
        const inline = renderContextBudgetSection({ finalResultTokens: 8_000, delivery: "inline" })
        const shared = renderContextBudgetSection({
            finalResultTokens: 8_000,
            delivery: "inline",
            mainTaskRound: { budgetTokens: 64_000, usedTokens: 0, workingConsumers: 2 },
        })
        const held = renderContextBudgetSection({ finalResultTokens: 8_000, delivery: "held_until_compaction" })

        expect(lineCount(shared)).toBe(lineCount(inline) + 1)
        expect(lineCount(held)).toBe(lineCount(inline) + 1)
        expect(held).not.toBe(shared)
    })
})
