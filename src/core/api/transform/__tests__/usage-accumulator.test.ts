import { describe, expect, it } from "vitest"
import { ApiUsageAccumulator } from "../usage-accumulator"

describe("ApiUsageAccumulator", () => {
    it("replaces split Provider snapshots without adding repeated totals", () => {
        const accumulator = new ApiUsageAccumulator()

        accumulator.apply({
            type: "usage",
            inputTokens: 1_000,
            outputTokens: 0,
            cacheReadTokens: 500,
            cacheWriteTokens: 300,
        })
        accumulator.apply({ type: "usage", inputTokens: 0, outputTokens: 120 })
        accumulator.apply({ type: "usage", inputTokens: 0, outputTokens: 120 })

        expect(accumulator.getUsage()).toEqual({
            inputTokens: 1_000,
            outputTokens: 120,
            cacheReadTokens: 500,
            cacheWriteTokens: 300,
        })
    })

    it("adds explicit deltas and lets a final snapshot replace an earlier estimate", () => {
        const accumulator = new ApiUsageAccumulator()

        accumulator.apply({ type: "usage", inputTokens: 1_100, outputTokens: 0 })
        accumulator.apply({ type: "usage", usageMode: "delta", inputTokens: 0, outputTokens: 40 })
        accumulator.apply({ type: "usage", usageMode: "delta", inputTokens: 0, outputTokens: 60 })
        accumulator.apply({ type: "usage", inputTokens: 900, outputTokens: 100 })

        expect(accumulator.getUsage()).toEqual({
            inputTokens: 900,
            outputTokens: 100,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
        })
    })

    it("reports only the newly accepted usage for downstream telemetry", () => {
        const accumulator = new ApiUsageAccumulator()

        expect(accumulator.apply({ type: "usage", inputTokens: 100, outputTokens: 0 }).delta).toEqual({
            inputTokens: 100,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
        })
        expect(accumulator.apply({ type: "usage", inputTokens: 100, outputTokens: 25 }).delta).toEqual({
            inputTokens: 0,
            outputTokens: 25,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
        })
        expect(accumulator.apply({ type: "usage", inputTokens: 100, outputTokens: 25 }).delta).toEqual({
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
        })
    })
})
