import type { PromptCacheHealthResetReason, PromptCacheHealthSnapshot, PromptCacheWarningReason } from "@shared/PromptCacheHealth"

const MINIMUM_CACHEABLE_PROMPT_TOKENS = 4_096
const LOW_HIT_RATE_PERCENT = 30
const NEAR_CONTEXT_HIT_RATE_PERCENT = 90
const WARMING_TARGET = 3

export interface PromptCacheObservation {
    readonly supportsPromptCache: boolean
    readonly cacheUsageReported: boolean
    readonly inputTokens: number
    readonly cacheWriteTokens: number
    readonly cacheReadTokens: number
    readonly contextTokens: number
    readonly contextWindow: number
    readonly compactTriggerTokens: number
}

export interface PromptCacheObservationOverrides {
    readonly contextTokens?: number
}

export interface PromptCacheObservationResult {
    readonly snapshot: PromptCacheHealthSnapshot
    readonly isEligibleSample: boolean
    readonly enteredWarning?: PromptCacheWarningReason
}

/** Track Task-local prompt cache health from normalized request usage. */
export class PromptCacheHealthMonitor {
    private snapshot: PromptCacheHealthSnapshot = createInactiveSnapshot("waiting")
    private sampleCount = 0
    private stalledLowHitSamples = 0
    private cacheReadHighWatermark = 0

    /** Observe one completed ordinary provider request. */
    observe(observation: PromptCacheObservation, overrides: PromptCacheObservationOverrides = {}): PromptCacheObservationResult {
        if (!observation.supportsPromptCache) {
            this.clearObservations()
            this.snapshot = createInactiveSnapshot("disabled")
            return { snapshot: this.getSnapshot(), isEligibleSample: false }
        }

        if (!observation.cacheUsageReported) {
            this.clearObservations()
            this.snapshot = createInactiveSnapshot("waiting")
            return { snapshot: this.getSnapshot(), isEligibleSample: false }
        }

        const promptTokens =
            normalizeTokens(observation.inputTokens) +
            normalizeTokens(observation.cacheWriteTokens) +
            normalizeTokens(observation.cacheReadTokens)
        if (promptTokens < MINIMUM_CACHEABLE_PROMPT_TOKENS) {
            return { snapshot: this.getSnapshot(), isEligibleSample: false }
        }

        this.sampleCount++
        const cacheReadTokens = normalizeTokens(observation.cacheReadTokens)
        const rawHitRate = (cacheReadTokens / promptTokens) * 100
        const hitRate = roundPercentage(rawHitRate)
        const contextTokens = normalizeTokens(overrides.contextTokens ?? observation.contextTokens)
        const nearContextWindow =
            observation.contextWindow > 0 &&
            observation.compactTriggerTokens >= 0 &&
            contextTokens >= observation.compactTriggerTokens
        const previousWarning = this.snapshot.warningReason
        const improved = cacheReadTokens > this.cacheReadHighWatermark

        if (improved) {
            this.cacheReadHighWatermark = cacheReadTokens
            this.stalledLowHitSamples = 0
        }

        let warningReason: PromptCacheWarningReason | undefined
        if (nearContextWindow && rawHitRate < NEAR_CONTEXT_HIT_RATE_PERCENT) {
            warningReason = "near_context_low_hit_rate"
        } else if (rawHitRate >= LOW_HIT_RATE_PERCENT) {
            this.stalledLowHitSamples = 0
        } else {
            this.stalledLowHitSamples = improved ? 1 : this.stalledLowHitSamples + 1
            if (this.stalledLowHitSamples >= WARMING_TARGET) {
                warningReason = "cache_not_improving"
            }
        }

        const status = warningReason ? "warning" : rawHitRate >= LOW_HIT_RATE_PERCENT ? "healthy" : "warming"
        const warmingRound = status === "warming" ? Math.min(this.stalledLowHitSamples, WARMING_TARGET - 1) : 0
        this.snapshot = Object.freeze({
            status,
            sampleCount: this.sampleCount,
            warmingRound,
            warmingTarget: WARMING_TARGET,
            hitRate,
            cacheReadTokens,
            promptTokens,
            nearContextWindow,
            ...(warningReason ? { warningReason } : {}),
        })

        return {
            snapshot: this.getSnapshot(),
            isEligibleSample: true,
            ...(warningReason && warningReason !== previousWarning ? { enteredWarning: warningReason } : {}),
        }
    }

    /** Reset health evidence after a confirmed cache identity or history boundary. */
    reset(_reason: PromptCacheHealthResetReason): PromptCacheHealthSnapshot {
        this.clearObservations()
        this.snapshot = createInactiveSnapshot("waiting")
        return this.getSnapshot()
    }

    /** Return an immutable snapshot for state projection. */
    getSnapshot(): PromptCacheHealthSnapshot {
        return this.snapshot
    }

    private clearObservations(): void {
        this.sampleCount = 0
        this.stalledLowHitSamples = 0
        this.cacheReadHighWatermark = 0
    }
}

function createInactiveSnapshot(status: "disabled" | "waiting"): PromptCacheHealthSnapshot {
    return Object.freeze({
        status,
        sampleCount: 0,
        warmingRound: 0,
        warmingTarget: WARMING_TARGET,
        nearContextWindow: false,
    })
}

function normalizeTokens(value: number): number {
    return Number.isFinite(value) ? Math.max(0, value) : 0
}

function roundPercentage(value: number): number {
    return Math.round(value * 100) / 100
}
