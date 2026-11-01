import {
    describeFoldUsage,
    type FoldRoundUsage,
    formatDuration,
    formatTokens,
    summarizeRoundsUsage,
} from "@shared/chat/foldUsage"
import { describe, expect, it } from "vitest"

const round = (overrides: Partial<FoldRoundUsage> = {}): FoldRoundUsage => ({
    roundId: "round-1",
    providerDurationMs: 4_000,
    inputTokens: 1_000,
    outputTokens: 400,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    usageQuality: "exact",
    ...overrides,
})

describe("summarizeRoundsUsage", () => {
    it("sums the rounds it is given and nothing else", () => {
        const usage = summarizeRoundsUsage([round(), round({ roundId: "round-2", providerDurationMs: 6_000, outputTokens: 600 })])
        expect(usage?.durationMs).toBe(10_000)
        expect(usage?.inputTokens).toBe(2_000)
        expect(usage?.outputTokens).toBe(1_000)
    })

    it("derives the average token rate from provider generation time", () => {
        // 600 output tokens over 4s of generation is 150 tokens per second.
        const usage = summarizeRoundsUsage([round({ outputTokens: 600, providerDurationMs: 4_000 })])
        expect(usage?.averageTokensPerSecond).toBeCloseTo(150, 5)
    })

    it("says nothing about a rate when no round reported a duration", () => {
        const usage = summarizeRoundsUsage([round({ providerDurationMs: undefined })])
        expect(usage?.averageTokensPerSecond).toBeUndefined()
        expect(usage?.durationMs).toBe(0)
    })

    it("reports the worst usage quality of the counted rounds", () => {
        expect(summarizeRoundsUsage([round(), round({ roundId: "round-2", usageQuality: "estimated" })])?.usageQuality).toBe(
            "estimated",
        )
        expect(summarizeRoundsUsage([round(), round({ roundId: "round-2" })])?.usageQuality).toBe("exact")
    })

    it("has nothing to say about an empty block", () => {
        expect(summarizeRoundsUsage([])).toBeUndefined()
    })
})

describe("formatting", () => {
    it("keeps a duration readable at every scale", () => {
        expect(formatDuration(480)).toBe("480ms")
        expect(formatDuration(12_400)).toBe("12.4s")
        expect(formatDuration(65_000)).toBe("1m 05s")
    })

    it("compacts token counts", () => {
        expect(formatTokens(980)).toBe("980")
        expect(formatTokens(3_240)).toBe("3.2k")
        expect(formatTokens(1_400_000)).toBe("1.4M")
    })

    it("states time, tokens and rate together", () => {
        const usage = summarizeRoundsUsage([round({ outputTokens: 600, inputTokens: 3_200, providerDurationMs: 4_000 })])
        if (!usage) throw new Error("expected usage")
        expect(describeFoldUsage(usage)).toBe("4.0s · 3.2k in / 600 out · 150 tok/s")
    })

    it("marks an inexact block as approximate", () => {
        const usage = summarizeRoundsUsage([round({ outputTokens: 600, providerDurationMs: 4_000, usageQuality: "estimated" })])
        if (!usage) throw new Error("expected usage")
        expect(describeFoldUsage(usage).startsWith("~")).toBe(true)
    })

    it("omits the parts the rounds cannot support", () => {
        const usage = summarizeRoundsUsage([round({ providerDurationMs: undefined, inputTokens: 0, outputTokens: 0 })])
        if (!usage) throw new Error("expected usage")
        expect(describeFoldUsage(usage)).toBe("")
    })
})
