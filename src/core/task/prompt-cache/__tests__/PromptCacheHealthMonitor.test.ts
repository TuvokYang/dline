import type { PromptCacheHealthResetReason } from "@shared/PromptCacheHealth"
import { describe, expect, it } from "vitest"
import { PromptCacheHealthMonitor, type PromptCacheObservation } from "../PromptCacheHealthMonitor"

const ELIGIBLE_PROMPT_TOKENS = 10_000
const CONTEXT_WINDOW = 100_000
const COMPACT_TRIGGER_TOKENS = 80_000

function observation(overrides: Partial<PromptCacheObservation> = {}): PromptCacheObservation {
    return {
        supportsPromptCache: true,
        cacheUsageReported: true,
        inputTokens: ELIGIBLE_PROMPT_TOKENS,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        contextTokens: ELIGIBLE_PROMPT_TOKENS,
        contextWindow: CONTEXT_WINDOW,
        compactTriggerTokens: COMPACT_TRIGGER_TOKENS,
        ...overrides,
    }
}

function lowHitObservation(cacheReadTokens = 1_000): PromptCacheObservation {
    return observation({
        inputTokens: 9_000,
        cacheReadTokens,
    })
}

function observeThreeLowHits(monitor: PromptCacheHealthMonitor): void {
    monitor.observe(lowHitObservation())
    monitor.observe(lowHitObservation())
    monitor.observe(lowHitObservation())
}

describe("PromptCacheHealthMonitor", () => {
    it("disables detection for models without prompt cache support", () => {
        const monitor = new PromptCacheHealthMonitor()

        const result = monitor.observe(observation({ supportsPromptCache: false }))

        expect(result.snapshot).toEqual({
            status: "disabled",
            sampleCount: 0,
            warmingRound: 0,
            warmingTarget: 3,
            nearContextWindow: false,
        })
        expect(result.isEligibleSample).toBe(false)
    })

    it("waits without stale evidence when the provider does not report cache usage", () => {
        const monitor = new PromptCacheHealthMonitor()
        observeThreeLowHits(monitor)

        const result = monitor.observe(observation({ cacheUsageReported: false }))

        expect(result.snapshot.status).toBe("waiting")
        expect(result.snapshot.sampleCount).toBe(0)
        expect(result.snapshot.warningReason).toBeUndefined()
        expect(result.isEligibleSample).toBe(false)
    })

    it("starts warming at 4096 prompt tokens but ignores smaller prompts", () => {
        const monitor = new PromptCacheHealthMonitor()

        const belowThreshold = monitor.observe(observation({ inputTokens: 4_095, contextTokens: 4_095 }))
        const atThreshold = monitor.observe(observation({ inputTokens: 4_096, contextTokens: 4_096 }))

        expect(belowThreshold.snapshot.status).toBe("waiting")
        expect(belowThreshold.snapshot.sampleCount).toBe(0)
        expect(atThreshold.snapshot.status).toBe("warming")
        expect(atThreshold.snapshot.warmingRound).toBe(1)
        expect(atThreshold.snapshot.sampleCount).toBe(1)
    })

    it("calculates hit rate from prompt input without output tokens", () => {
        const monitor = new PromptCacheHealthMonitor()

        const result = monitor.observe(
            observation({
                inputTokens: 5_000,
                cacheWriteTokens: 1_000,
                cacheReadTokens: 4_000,
            }),
        )

        expect(result.snapshot.hitRate).toBe(40)
        expect(result.snapshot.promptTokens).toBe(10_000)
    })

    it("treats the exact 30 percent boundary as healthy", () => {
        const monitor = new PromptCacheHealthMonitor()

        const result = monitor.observe(
            observation({
                inputTokens: 7_000,
                cacheReadTokens: 3_000,
            }),
        )

        expect(result.snapshot.status).toBe("healthy")
        expect(result.snapshot.hitRate).toBe(30)
        expect(result.enteredWarning).toBeUndefined()
    })

    it("keeps warming while low-hit cache reads are increasing", () => {
        const monitor = new PromptCacheHealthMonitor()

        const first = monitor.observe(lowHitObservation(500))
        const second = monitor.observe(lowHitObservation(750))
        const third = monitor.observe(lowHitObservation(1_000))

        expect(first.snapshot.warmingRound).toBe(1)
        expect(second.snapshot.warmingRound).toBe(1)
        expect(third.snapshot.warmingRound).toBe(1)
        expect(third.snapshot.status).toBe("warming")
        expect(third.enteredWarning).toBeUndefined()
    })

    it("warns on the third low-hit sample when cache reads do not improve", () => {
        const monitor = new PromptCacheHealthMonitor()

        const first = monitor.observe(lowHitObservation())
        const second = monitor.observe(lowHitObservation())
        const third = monitor.observe(lowHitObservation())

        expect(first.snapshot.warmingRound).toBe(1)
        expect(second.snapshot.warmingRound).toBe(2)
        expect(third.snapshot.status).toBe("warning")
        expect(third.snapshot.warningReason).toBe("cache_not_improving")
        expect(third.enteredWarning).toBe("cache_not_improving")
    })

    it("restarts the warming window when cache reads improve before the third stalled sample", () => {
        const monitor = new PromptCacheHealthMonitor()

        monitor.observe(lowHitObservation(1_000))
        monitor.observe(lowHitObservation(1_000))
        const improved = monitor.observe(lowHitObservation(1_500))
        const next = monitor.observe(lowHitObservation(1_500))

        expect(improved.snapshot.status).toBe("warming")
        expect(improved.snapshot.warmingRound).toBe(1)
        expect(improved.enteredWarning).toBeUndefined()
        expect(next.snapshot.warmingRound).toBe(2)
    })

    it("clears a stalled warning when cache reads begin improving", () => {
        const monitor = new PromptCacheHealthMonitor()
        observeThreeLowHits(monitor)

        const recovered = monitor.observe(lowHitObservation(2_000))

        expect(recovered.snapshot.status).toBe("warming")
        expect(recovered.snapshot.warningReason).toBeUndefined()
        expect(recovered.snapshot.warmingRound).toBe(1)
    })

    it("warns immediately below 90 percent near the compact trigger", () => {
        const monitor = new PromptCacheHealthMonitor()

        const result = monitor.observe(
            observation({
                inputTokens: 10_001,
                cacheReadTokens: 89_999,
                contextTokens: COMPACT_TRIGGER_TOKENS,
            }),
        )

        expect(result.snapshot.nearContextWindow).toBe(true)
        expect(result.snapshot.status).toBe("warning")
        expect(result.snapshot.warningReason).toBe("near_context_low_hit_rate")
        expect(result.enteredWarning).toBe("near_context_low_hit_rate")
    })

    it("accepts the exact 90 percent boundary near the compact trigger", () => {
        const monitor = new PromptCacheHealthMonitor()

        const result = monitor.observe(
            observation({
                inputTokens: 10_000,
                cacheReadTokens: 90_000,
                contextTokens: COMPACT_TRIGGER_TOKENS,
            }),
        )

        expect(result.snapshot.nearContextWindow).toBe(true)
        expect(result.snapshot.status).toBe("healthy")
        expect(result.enteredWarning).toBeUndefined()
    })

    it("prioritizes a near-context warning over a stalled warning", () => {
        const monitor = new PromptCacheHealthMonitor()
        observeThreeLowHits(monitor)

        const result = monitor.observe(lowHitObservation(1_000), { contextTokens: COMPACT_TRIGGER_TOKENS })

        expect(result.snapshot.warningReason).toBe("near_context_low_hit_rate")
        expect(result.enteredWarning).toBe("near_context_low_hit_rate")
    })

    it("returns to ordinary health evaluation after leaving the near-context boundary", () => {
        const monitor = new PromptCacheHealthMonitor()
        monitor.observe(
            observation({
                inputTokens: 50_000,
                cacheReadTokens: 50_000,
                contextTokens: COMPACT_TRIGGER_TOKENS,
            }),
        )

        const recovered = monitor.observe(
            observation({
                inputTokens: 7_000,
                cacheReadTokens: 3_000,
                contextTokens: 20_000,
            }),
        )

        expect(recovered.snapshot.nearContextWindow).toBe(false)
        expect(recovered.snapshot.status).toBe("healthy")
        expect(recovered.snapshot.warningReason).toBeUndefined()
    })

    it.each<PromptCacheHealthResetReason>([
        "profile_changed",
        "compaction_completed",
    ])("resets observations after %s", (reason) => {
        const monitor = new PromptCacheHealthMonitor()
        observeThreeLowHits(monitor)

        const resetSnapshot = monitor.reset(reason)
        const next = monitor.observe(lowHitObservation())

        expect(resetSnapshot.status).toBe("waiting")
        expect(resetSnapshot.sampleCount).toBe(0)
        expect(resetSnapshot.warningReason).toBeUndefined()
        expect(next.snapshot.status).toBe("warming")
        expect(next.snapshot.warmingRound).toBe(1)
    })
})
