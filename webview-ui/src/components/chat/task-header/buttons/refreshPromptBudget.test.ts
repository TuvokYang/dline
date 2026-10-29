import { describe, expect, it } from "vitest"
import { buildRefreshPromptBudget } from "./refreshPromptBudget"

describe("refresh prompt budget", () => {
    it("formats cache miss tokens and price on separate prominent lines", () => {
        const budget = buildRefreshPromptBudget({
            estimatedInputTokens: 12_400,
            inputPrice: 1.5,
            currency: "USD",
        })

        expect(budget.tokenLine).toBe("12.4K input tokens")
        expect(budget.priceLine).toBe("≈ $0.0186")
        expect(budget.inputPriceLine).toBe("Input price: $1.50 / 1M tokens")
    })

    it("formats CNY with the yuan symbol instead of dollar prefix", () => {
        const budget = buildRefreshPromptBudget({
            estimatedInputTokens: 12_400,
            inputPrice: 1.5,
            currency: "CNY",
        })

        expect(budget.priceLine).toBe("≈ ¥0.0186")
        expect(budget.inputPriceLine).toBe("Input price: ¥1.50 / 1M tokens")
    })

    it("names an unlisted currency instead of pricing it in dollars", () => {
        const budget = buildRefreshPromptBudget({
            estimatedInputTokens: 12_400,
            inputPrice: 1.5,
            currency: "CHF",
        })

        expect(budget.inputPriceLine).toBe("Input price: CHF 1.50 / 1M tokens")
    })

    it("switches to M tokens without showing K at million scale", () => {
        const budget = buildRefreshPromptBudget({
            estimatedInputTokens: 1_240_000,
            inputPrice: 1.5,
            currency: "USD",
        })

        expect(budget.tokenLine).toBe("1.2M input tokens")
        expect(budget.tokenLine).not.toContain("K")
    })

    it("omits price lines when pricing is unavailable", () => {
        const budget = buildRefreshPromptBudget({
            estimatedInputTokens: 12_400,
        })

        expect(budget.tokenLine).toBe("12.4K input tokens")
        expect(budget.priceLine).toBeUndefined()
        expect(budget.inputPriceLine).toBeUndefined()
    })
})
