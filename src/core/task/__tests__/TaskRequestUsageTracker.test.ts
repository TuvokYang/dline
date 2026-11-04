import { describe, expect, it } from "vitest"
import { TaskRequestUsageTracker } from "../TaskRequestUsageTracker"

describe("TaskRequestUsageTracker", () => {
    it("keeps one authoritative request total across split and duplicate Provider snapshots", () => {
        const tracker = new TaskRequestUsageTracker()

        tracker.apply({
            type: "usage",
            inputTokens: 1_000,
            outputTokens: 0,
            cacheWriteTokens: 300,
            cacheReadTokens: 500,
            totalCost: 0.2,
        })
        tracker.apply({ type: "usage", inputTokens: 0, outputTokens: 120 })
        tracker.apply({ type: "usage", inputTokens: 0, outputTokens: 120 })

        expect(tracker.getSnapshot()).toEqual({
            inputTokens: 1_000,
            outputTokens: 120,
            cacheWriteTokens: 300,
            cacheReadTokens: 500,
            totalCost: 0.2,
            cacheUsageReported: true,
        })
    })

    it("replaces explicit output deltas with the final Provider snapshot", () => {
        const tracker = new TaskRequestUsageTracker()

        tracker.apply({ type: "usage", inputTokens: 1_100, outputTokens: 0 })
        tracker.apply({ type: "usage", usageMode: "delta", inputTokens: 0, outputTokens: 40, totalCost: 0.01 })
        tracker.apply({ type: "usage", usageMode: "delta", inputTokens: 0, outputTokens: 60, totalCost: 0.02 })
        tracker.apply({ type: "usage", inputTokens: 900, outputTokens: 100, totalCost: 0.03 })

        expect(tracker.getSnapshot()).toEqual({
            inputTokens: 900,
            outputTokens: 100,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            totalCost: 0.03,
            cacheUsageReported: false,
        })
    })

    it("retains the latest Provider metadata without adding it across snapshots", () => {
        const tracker = new TaskRequestUsageTracker()

        tracker.apply({ type: "usage", inputTokens: 100, outputTokens: 10, thoughtsTokenCount: 4, totalCost: 0.1 })
        tracker.apply({ type: "usage", inputTokens: 100, outputTokens: 20, thoughtsTokenCount: 7, totalCost: 0.15 })

        expect(tracker.getSnapshot()).toEqual({
            inputTokens: 100,
            outputTokens: 20,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            thoughtsTokens: 7,
            totalCost: 0.15,
            cacheUsageReported: false,
        })
    })

    it("adds money deltas and lets a snapshot replace them while carrying currency", () => {
        const tracker = new TaskRequestUsageTracker()
        tracker.apply({ type: "usage", usageMode: "delta", inputTokens: 100, outputTokens: 1, totalCost: 1, currency: "CNY" })
        tracker.apply({ type: "usage", usageMode: "delta", inputTokens: 50, outputTokens: 1, totalCost: 2, currency: "CNY" })
        expect(tracker.getSnapshot()).toMatchObject({ inputTokens: 150, outputTokens: 2, totalCost: 3, currency: "CNY" })
        tracker.apply({ type: "usage", inputTokens: 150, outputTokens: 2, totalCost: 4, currency: "CNY" })
        expect(tracker.getSnapshot()).toMatchObject({ inputTokens: 150, outputTokens: 2, totalCost: 4, currency: "CNY" })
    })

    it("does not inherit currency for a replacement unlabelled amount", () => {
        const tracker = new TaskRequestUsageTracker()
        tracker.apply({ type: "usage", inputTokens: 100, outputTokens: 1, totalCost: 1, currency: "CNY" })
        tracker.apply({ type: "usage", inputTokens: 100, outputTokens: 2, totalCost: 2 })
        expect(tracker.getSnapshot().totalCost).toBe(2)
        expect(tracker.getSnapshot()).not.toHaveProperty("currency")
    })

    it("does not clamp invalid negative money to a reported zero", () => {
        const tracker = new TaskRequestUsageTracker()
        tracker.apply({ type: "usage", inputTokens: 100, outputTokens: 1, totalCost: -1, currency: "USD" })
        expect(tracker.getSnapshot()).not.toHaveProperty("totalCost")
        expect(tracker.getSnapshot()).not.toHaveProperty("currency")
    })
})
