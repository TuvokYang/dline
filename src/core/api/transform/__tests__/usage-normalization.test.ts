import { describe, expect, it } from "vitest"
import { splitInclusiveInputUsage } from "../usage-normalization"

describe("splitInclusiveInputUsage", () => {
    it("splits cache subsets out of a Provider total input count", () => {
        expect(
            splitInclusiveInputUsage({
                totalInputTokens: 1_000,
                cacheReadTokens: 500,
                cacheWriteTokens: 300,
            }),
        ).toEqual({
            inputTokens: 200,
            cacheReadTokens: 500,
            cacheWriteTokens: 300,
        })
    })

    it("never manufactures negative uncached input when Provider cache metadata exceeds the total", () => {
        expect(
            splitInclusiveInputUsage({
                totalInputTokens: 50,
                cacheReadTokens: 40,
                cacheWriteTokens: 30,
            }),
        ).toEqual({
            inputTokens: 0,
            cacheReadTokens: 40,
            cacheWriteTokens: 30,
        })
    })

    it("normalizes invalid and fractional token values at the Provider boundary", () => {
        expect(
            splitInclusiveInputUsage({
                totalInputTokens: 12.9,
                cacheReadTokens: Number.NaN,
                cacheWriteTokens: -4,
            }),
        ).toEqual({
            inputTokens: 12,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
        })
    })
})
