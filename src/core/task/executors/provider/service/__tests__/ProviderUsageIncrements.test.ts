import { describe, expect, it } from "vitest"
import { mergeProviderUsage } from "../ProviderRequestReport"
import { ProviderUsageIncrements } from "../ProviderUsageIncrements"

function settle(chunks: Parameters<ProviderUsageIncrements["next"]>[0][]): Readonly<Record<string, number>> | undefined {
    const increments = new ProviderUsageIncrements()
    let settled: Readonly<Record<string, number>> | undefined
    for (const chunk of chunks) settled = mergeProviderUsage(settled, increments.next(chunk))
    return settled
}

describe("ProviderUsageIncrements", () => {
    it("counts cached input once when every event repeats the running request snapshot", () => {
        const settled = settle([
            {
                type: "usage",
                usageMode: "snapshot",
                inputTokens: 400,
                outputTokens: 0,
                cacheWriteTokens: 9_000,
                cacheReadTokens: 10_000,
            },
            {
                type: "usage",
                usageMode: "snapshot",
                inputTokens: 400,
                outputTokens: 120,
                cacheWriteTokens: 9_000,
                cacheReadTokens: 10_000,
            },
        ])

        expect(settled).toMatchObject({
            inputTokens: 400,
            outputTokens: 120,
            cacheWriteTokens: 9_000,
            cacheReadTokens: 10_000,
            cacheUsageReported: 1,
        })
    })

    it("adds explicit deltas", () => {
        const settled = settle([
            { type: "usage", inputTokens: 300, outputTokens: 0 },
            { type: "usage", usageMode: "delta", inputTokens: 0, outputTokens: 40, thoughtsTokenCount: 10 },
            { type: "usage", usageMode: "delta", inputTokens: 0, outputTokens: 60, thoughtsTokenCount: 15 },
        ])

        expect(settled).toMatchObject({
            inputTokens: 300,
            outputTokens: 100,
            thoughtsTokenCount: 25,
            thoughtsUsageReported: 1,
            cacheUsageReported: 0,
        })
    })

    it("keeps the request total cost when a later event omits it", () => {
        const settled = settle([
            {
                type: "usage",
                inputTokens: 300,
                outputTokens: 10,
                totalCost: 0.02,
                serverToolUsage: { webSearchRequests: 2, webFetchRequests: 1 },
            },
            {
                type: "usage",
                inputTokens: 300,
                outputTokens: 50,
                serverToolUsage: { webSearchRequests: 2, webFetchRequests: 1 },
            },
        ])

        expect(settled).toMatchObject({
            outputTokens: 50,
            totalCost: 0.02,
            costUsageReported: 1,
            webSearchRequests: 2,
            webFetchRequests: 1,
            serverToolUsageReported: 1,
        })
    })

    it("preserves explicit zero reasoning and cost as reported values", () => {
        const settled = settle([
            { type: "usage", inputTokens: 300, outputTokens: 10, thoughtsTokenCount: 0, totalCost: 0 },
            { type: "usage", inputTokens: 300, outputTokens: 50 },
        ])

        expect(settled).toMatchObject({
            thoughtsTokenCount: 0,
            thoughtsUsageReported: 1,
            totalCost: 0,
            costUsageReported: 1,
        })
    })

    it("retains that cache usage was reported when later snapshots omit cache fields", () => {
        const settled = settle([
            { type: "usage", inputTokens: 300, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            { type: "usage", inputTokens: 300, outputTokens: 50 },
        ])

        expect(settled).toMatchObject({ cacheUsageReported: 1 })
    })
})
