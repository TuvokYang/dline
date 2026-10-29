import { describe, expect, it } from "vitest"
import { getTaskUsageLabel, getTotalTokens, isTaskCompleted } from "./task-metrics"

describe("isTaskCompleted", () => {
    it("accepts only a revisioned completion projection", () => {
        expect(isTaskCompleted({ isCompleted: true, completionStateRevision: 3 })).toBe(true)
        expect(isTaskCompleted({ isCompleted: false, completionStateRevision: 3 })).toBe(false)
    })

    it("rejects a legacy completion flag without a revision", () => {
        expect(isTaskCompleted({ isCompleted: true })).toBe(false)
        expect(isTaskCompleted({})).toBe(false)
    })
})

describe("getTotalTokens", () => {
    it("sums input, output and both cache directions", () => {
        expect(getTotalTokens({ tokensIn: 10, tokensOut: 5, cacheWrites: 2, cacheReads: 3 })).toBe(20)
    })

    it("treats missing counters as zero", () => {
        expect(getTotalTokens({})).toBe(0)
    })
})

describe("getTaskUsageLabel", () => {
    it("shows the billed cost when the task has a real price", () => {
        expect(getTaskUsageLabel({ totalCost: 22.588, currency: "USD", tokensIn: 100 })).toMatchObject({
            kind: "cost",
            text: "$22.59",
        })
    })

    it("labels a yuan-billed task with the yuan symbol", () => {
        expect(getTaskUsageLabel({ totalCost: 3.5, currency: "CNY" })).toMatchObject({ kind: "cost", text: "¥3.50" })
    })

    it("shows total tokens instead of a meaningless zero cost", () => {
        const label = getTaskUsageLabel({ totalCost: 0, currency: "CNY", tokensIn: 900, tokensOut: 400 })

        expect(label).toMatchObject({ kind: "tokens", text: "1.3k tokens" })
        expect(label?.title).toBe("Total tokens: 1,300")
    })

    it("treats a missing cost the same as a zero cost", () => {
        expect(getTaskUsageLabel({ tokensIn: 120 })).toMatchObject({ kind: "tokens", text: "120 tokens" })
    })

    it("renders nothing when there is neither cost nor token usage", () => {
        expect(getTaskUsageLabel({ totalCost: 0 })).toBeUndefined()
    })

    it("honors the requested precision for real costs", () => {
        expect(getTaskUsageLabel({ totalCost: 1.23456, currency: "USD" }, 4)).toMatchObject({ text: "$1.2346" })
    })
})
