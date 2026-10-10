import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiRateTracker } from "./api-rate-tracker"

afterEach(() => {
    vi.useRealTimers()
})

describe("ApiRateTracker", () => {
    it("extrapolates request and token rates from API-active seconds", () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date("2026-08-10T09:00:00.000Z"))
        const tracker = new ApiRateTracker()

        expect(tracker.getSnapshot()).toEqual({})

        tracker.recordRequestStarted()
        tracker.recordEstimatedTokens(120)
        expect(tracker.getSnapshot()).toEqual({ requestsPerMinute: 60, tokensPerMinute: 7_200 })

        vi.advanceTimersByTime(30_000)
        tracker.recordEstimatedTokens(180)
        expect(tracker.getSnapshot()).toEqual({ requestsPerMinute: 30, tokensPerMinute: 9_000 })

        tracker.recordExactTokens(500)
        expect(tracker.getSnapshot()).toEqual({ requestsPerMinute: 30, tokensPerMinute: 15_000 })
    })

    it("does not count idle waiting time or discard the last active rate", () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date("2026-08-10T09:00:00.000Z"))
        const onChanged = vi.fn()
        const tracker = new ApiRateTracker({ onChanged })

        tracker.recordRequestStarted()
        tracker.recordEstimatedTokens(100)
        const activeSnapshot = tracker.getSnapshot()
        onChanged.mockClear()

        vi.advanceTimersByTime(120_000)

        expect(onChanged).not.toHaveBeenCalled()
        expect(tracker.getSnapshot()).toEqual(activeSnapshot)
        tracker.dispose()
    })
})
