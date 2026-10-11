import { describe, expect, it } from "vitest"
import { resolveTargetContextScope, shouldContinueTargetWindowFitting } from "../target-context-scope"

describe("target context scope", () => {
    it("uses the enabled absolute cap as W when it is smaller than the provider window", () => {
        // The reserve comes out of W like for any window: 272K × 3% = 8,160.
        expect(resolveTargetContextScope({ providerContextWindow: 1_000_000, maxContextTokens: 272_000 })).toEqual({
            targetContextWindow: 272_000,
            effectiveContextLimit: 263_840,
            compactTriggerTokens: 260_340,
            fittingExitTarget: 217_600,
        })
    })

    it("stops at 80 percent of the provider window when the absolute cap is disabled or larger", () => {
        expect(resolveTargetContextScope({ providerContextWindow: 200_000, maxContextTokens: 0 })).toEqual({
            targetContextWindow: 200_000,
            effectiveContextLimit: 194_000,
            compactTriggerTokens: 190_500,
            fittingExitTarget: 160_000,
        })
        expect(resolveTargetContextScope({ providerContextWindow: 200_000, maxContextTokens: 272_000 })).toEqual({
            targetContextWindow: 200_000,
            effectiveContextLimit: 194_000,
            compactTriggerTokens: 190_500,
            fittingExitTarget: 160_000,
        })
    })

    it("derives the 80 percent stop line from the configured window, not the reserve-adjusted limit", () => {
        expect(
            resolveTargetContextScope({
                providerContextWindow: 472_000,
                triggerPercent: 95,
                minReserveTokens: 5_000,
                maxReserveTokens: 30_000,
                maxContextTokens: 0,
            }),
        ).toEqual({
            targetContextWindow: 472_000,
            effectiveContextLimit: 448_400,
            compactTriggerTokens: 444_900,
            fittingExitTarget: 377_600,
        })
    })

    it("continues at the 80 percent boundary and exits only when strictly below it", () => {
        const scope = resolveTargetContextScope({ providerContextWindow: 1_000_000, maxContextTokens: 272_000 })

        expect(shouldContinueTargetWindowFitting(217_601, scope)).toBe(true)
        expect(shouldContinueTargetWindowFitting(217_600, scope)).toBe(true)
        expect(shouldContinueTargetWindowFitting(217_599, scope)).toBe(false)
    })

    it("rejects an unavailable provider context window", () => {
        expect(() => resolveTargetContextScope({ providerContextWindow: 0, maxContextTokens: 272_000 })).toThrow(
            "Target provider context window must be positive",
        )
    })
})
