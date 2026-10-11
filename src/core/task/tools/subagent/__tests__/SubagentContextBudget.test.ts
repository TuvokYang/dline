import { ContextBudgetLedger } from "@core/context/context-management/context-budget-ledger"
import { describe, expect, it } from "vitest"
import { buildContextBudgetSection, resolveFinalResultTokens } from "../SubagentContextBudget"

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

describe("buildContextBudgetSection", () => {
    it("still states the configured final-result budget without a main-task budget", () => {
        // This section is the only source of the figure, so it must not disappear.
        expect(buildContextBudgetSection(undefined, 8_000)).toBe(
            `# Context Budget\nYour final result may use about ${(8_000).toLocaleString()} tokens.`,
        )
    })

    it("reports the current share, the round's budget and the working consumers", () => {
        const parent = ledgerWith(20_000).begin()
        const child = parent.child()
        parent.child()

        const section = buildContextBudgetSection(child, 50_000) ?? ""

        expect(section.startsWith("# Context Budget\n")).toBe(true)
        expect(section.includes(`about ${(32_000).toLocaleString()} tokens`)).toBe(true)
        expect(section.includes(`may take ${(64_000).toLocaleString()} tokens together; 0 are already used`)).toBe(true)
        expect(section.includes("shared by 2 working")).toBe(true)
        expect(section.includes("out of room")).toBe(false)
    })

    it("tells the subagent its result is held whole once the main task must yield", () => {
        const child = ledgerWith(98_000).begin().child()

        const section = buildContextBudgetSection(child, 8_000) ?? ""

        expect(section.includes("out of room")).toBe(true)
        expect(section.includes(`about ${(8_000).toLocaleString()} tokens`)).toBe(true)
        expect(section.includes("held whole and delivered after the main task compacts")).toBe(true)
    })
})
