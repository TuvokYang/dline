import { expect } from "chai"
import { describe, it } from "vitest"
import { getHighContextPressureWarning, showContextUsage } from "../environment-context"

describe("showContextUsage", () => {
    it("keeps context window details visible for next-gen models after profile switches", () => {
        const result = showContextUsage({
            contextWindow: 1_000_000,
            lastApiReqTotalTokens: 10_000,
            modelId: "claude-sonnet-4-6[1m]",
        })

        expect(result).to.equal(true)
    })
})

describe("getHighContextPressureWarning", () => {
    it("warns when strictly less than 10 percent of the context window remains", () => {
        const warning = getHighContextPressureWarning({
            contextWindow: 100_000,
            lastApiReqTotalTokens: 90_001,
            modelId: "gpt-5.6-sol",
        })

        expect(warning).to.include("# High Context Pressure")
        expect(warning).to.include("Avoid launching too many parallel tool calls that may produce large results")
        expect(warning).to.include("Do not skip information or verification required to complete the current task")
    })

    it("does not warn when exactly 10 percent remains", () => {
        const warning = getHighContextPressureWarning({
            contextWindow: 100_000,
            lastApiReqTotalTokens: 90_000,
            modelId: "gpt-5.6-sol",
        })

        expect(warning).to.equal("")
    })
})
