import { ApiHandler } from "@core/api/ApiHandler"
import { deepSeekModels } from "@core/api/providers/models/deepseek"
import { describe, expect, it } from "vitest"

const { calculateUsageCost } = ApiHandler

// Independent amounts from the seller's CNY/1M table, checked 2026-11-03:
// Flash peak 2/8/.04, default 1/4/.02; Pro peak 9/27/.30, default 4.5/13.5/.15.
describe("DeepSeek published billing terms", () => {
    it.each([
        ["deepseek-flash", "2026-11-03T01:00:00Z", 1.004],
        ["deepseek-flash", "2026-11-03T04:00:00Z", 0.502],
        ["deepseek-v4-pro", "2026-11-03T01:00:00Z", 3.63],
        ["deepseek-v4-pro", "2026-11-03T04:00:00Z", 1.815],
        ["deepseek-flash", "2026-11-08T01:00:00Z", 0.502],
        ["deepseek-flash", "2026-10-01T06:00:00Z", 0.502],
        ["deepseek-v4-pro", "2026-11-08T06:00:00Z", 1.815],
        ["deepseek-v4-pro", "2026-10-01T01:00:00Z", 1.815],
    ] as const)("bills %s at %s using the explicit published rate", (id, at, amount) => {
        const result = calculateUsageCost(
            deepSeekModels[id].pricing,
            {
                inputTokens: 100_000,
                cacheReadTokens: 100_000,
                outputTokens: 100_000,
            },
            Date.parse(at),
        )
        expect(result.kind).toBe("calculated")
        if (result.kind !== "calculated") throw new Error("Expected a calculated result")
        expect(result.currency).toBe("CNY")
        expect(result.amount).toBeCloseTo(amount, 12)
    })
})
