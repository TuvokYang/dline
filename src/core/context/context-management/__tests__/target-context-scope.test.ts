import { describe, expect, it } from "vitest"
import { resolveTargetContextScope, shouldContinueTargetWindowFitting } from "../target-context-scope"

describe("target context scope", () => {
    it("uses the enabled absolute cap when it is smaller than the provider window", () => {
        expect(resolveTargetContextScope({ providerContextWindow: 1_000_000, maxContextTokens: 272_000 })).toEqual({
            targetContextWindow: 272_000,
            effectiveContextLimit: 272_000,
            compactTriggerTokens: 266_500,
            fittingExitTarget: 217_600,
        })
    })

    it("uses the guarded percentage limit when the absolute cap is disabled or larger", () => {
        expect(resolveTargetContextScope({ providerContextWindow: 200_000, maxContextTokens: 0 })).toEqual({
            targetContextWindow: 200_000,
            effectiveContextLimit: 194_000,
            compactTriggerTokens: 188_500,
            fittingExitTarget: 155_200,
        })
        expect(resolveTargetContextScope({ providerContextWindow: 200_000, maxContextTokens: 272_000 })).toEqual({
            targetContextWindow: 200_000,
            effectiveContextLimit: 194_000,
            compactTriggerTokens: 188_500,
            fittingExitTarget: 155_200,
        })
    })

    it("uses the configured percentage effective limit for the strict 80 percent exit", () => {
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
            compactTriggerTokens: 442_900,
            fittingExitTarget: 358_720,
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
