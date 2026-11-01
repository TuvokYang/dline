import { describe, expect, it } from "vitest"
import { costOf, resolveThinkingPrice } from "../cost"
import type { BillableTokens, ResolvedPrices } from "../types"
import { billableTokens } from "../usage-mapping"

const PRICES: ResolvedPrices = {
    inputPrice: 3,
    outputPrice: 15,
    cacheWritePrice: 3.75,
    cacheReadPrice: 0.3,
    currency: "USD",
}

function tokens(partial: Partial<BillableTokens> = {}): BillableTokens {
    return { regularInput: 0, output: 0, cacheWrite: 0, cacheRead: 0, thinking: 0, ...partial }
}

describe("costOf", () => {
    it("prices each slot at its own unit price", () => {
        const cost = costOf(PRICES, tokens({ regularInput: 1_000_000, output: 1_000_000 }))
        expect(cost).toBeCloseTo(3 + 15, 10)
    })

    it("prices cache writes and reads separately from input", () => {
        const cost = costOf(PRICES, tokens({ cacheWrite: 1_000_000, cacheRead: 1_000_000 }))
        expect(cost).toBeCloseTo(3.75 + 0.3, 10)
    })

    it("returns zero for an empty request", () => {
        expect(costOf(PRICES, tokens())).toBe(0)
    })

    it("bills thinking tokens at the output price when no thinking price is published", () => {
        const cost = costOf(PRICES, tokens({ thinking: 1_000_000 }))
        expect(cost).toBeCloseTo(15, 10)
    })

    it("bills thinking tokens at the thinking price when one is published", () => {
        const withThinking: ResolvedPrices = { ...PRICES, thinkingOutputPrice: 60 }
        const cost = costOf(withThinking, tokens({ thinking: 1_000_000 }))
        expect(cost).toBeCloseTo(60, 10)
    })

    it("does not bill regular output at the thinking price", () => {
        const withThinking: ResolvedPrices = { ...PRICES, thinkingOutputPrice: 60 }
        const cost = costOf(withThinking, tokens({ output: 1_000_000 }))
        expect(cost).toBeCloseTo(15, 10)
    })

    it("adds thinking on top of regular output", () => {
        const withThinking: ResolvedPrices = { ...PRICES, thinkingOutputPrice: 60 }
        const cost = costOf(withThinking, tokens({ output: 1_000_000, thinking: 500_000 }))
        expect(cost).toBeCloseTo(15 + 30, 10)
    })
})

describe("resolveThinkingPrice", () => {
    it("falls back to the output price", () => {
        expect(resolveThinkingPrice(PRICES)).toBe(15)
    })

    it("prefers the published thinking price", () => {
        expect(resolveThinkingPrice({ ...PRICES, thinkingOutputPrice: 60 })).toBe(60)
    })
})

describe("billableTokens", () => {
    it("keeps Anthropic input as reported because it already excludes cache counts", () => {
        const mapped = billableTokens("anthropic", {
            inputTokens: 1000,
            outputTokens: 500,
            cacheWriteTokens: 200,
            cacheReadTokens: 300,
        })
        expect(mapped).toEqual({ regularInput: 1000, output: 500, cacheWrite: 200, cacheRead: 300, thinking: 0 })
    })

    it("subtracts cache counts from inclusive input for OpenAI", () => {
        const mapped = billableTokens("openai", {
            inputTokens: 1500,
            outputTokens: 500,
            cacheWriteTokens: 200,
            cacheReadTokens: 300,
        })
        expect(mapped.regularInput).toBe(1000)
    })

    it("subtracts cache counts from inclusive input for Qwen", () => {
        const mapped = billableTokens("qwen", {
            inputTokens: 1500,
            outputTokens: 500,
            cacheWriteTokens: 200,
            cacheReadTokens: 300,
        })
        expect(mapped.regularInput).toBe(1000)
    })

    it("does not go negative when inclusive input is smaller than the cache counts", () => {
        const mapped = billableTokens("openai", { inputTokens: 100, outputTokens: 10, cacheReadTokens: 300 })
        expect(mapped.regularInput).toBe(0)
    })

    it("treats missing optional counts as zero", () => {
        const mapped = billableTokens("openai", { inputTokens: 1000, outputTokens: 100 })
        expect(mapped).toEqual({ regularInput: 1000, output: 100, cacheWrite: 0, cacheRead: 0, thinking: 0 })
    })

    it("charges a request the same total through either inclusive or exclusive reporting", () => {
        const inclusive = billableTokens("openai", {
            inputTokens: 1500,
            outputTokens: 100,
            cacheWriteTokens: 200,
            cacheReadTokens: 300,
        })
        const exclusive = billableTokens("anthropic", {
            inputTokens: 1000,
            outputTokens: 100,
            cacheWriteTokens: 200,
            cacheReadTokens: 300,
        })
        expect(costOf(PRICES, inclusive)).toBeCloseTo(costOf(PRICES, exclusive), 10)
    })
})
