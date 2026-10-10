import { describe, expect, it } from "vitest"
import { decideTargetWindowFitting } from "../TargetWindowFittingService"

describe("target window fitting decision", () => {
    it("continues at the strict 80 percent boundary when another complete turn remains", () => {
        expect(
            decideTargetWindowFitting({
                candidateEstimatedTokens: 217_600,
                providerContextWindow: 1_000_000,
                maxContextTokens: 272_000,
                hasMoreTurns: true,
            }),
        ).toEqual({
            status: "continue",
            projectedUsageTokens: 217_600,
            targetContextWindow: 272_000,
            effectiveContextLimit: 272_000,
            fittingExitTarget: 217_600,
        })
    })

    it("completes only when the complete target candidate is strictly below the exit target", () => {
        expect(
            decideTargetWindowFitting({
                candidateEstimatedTokens: 217_599,
                providerContextWindow: 1_000_000,
                maxContextTokens: 272_000,
                hasMoreTurns: true,
            }),
        ).toEqual({
            status: "complete",
            projectedUsageTokens: 217_599,
            targetContextWindow: 272_000,
            effectiveContextLimit: 272_000,
            fittingExitTarget: 217_600,
        })
    })

    it("completes when no complete turn remains and the candidate still fits the hard window", () => {
        expect(
            decideTargetWindowFitting({
                candidateEstimatedTokens: 250_000,
                providerContextWindow: 1_000_000,
                maxContextTokens: 272_000,
                hasMoreTurns: false,
            }),
        ).toEqual({
            status: "complete",
            projectedUsageTokens: 250_000,
            targetContextWindow: 272_000,
            effectiveContextLimit: 272_000,
            fittingExitTarget: 217_600,
        })
    })

    it("fails when no complete turn remains and the candidate reaches the hard target window", () => {
        expect(
            decideTargetWindowFitting({
                candidateEstimatedTokens: 272_000,
                providerContextWindow: 1_000_000,
                maxContextTokens: 272_000,
                hasMoreTurns: false,
            }),
        ).toEqual({
            status: "exhausted",
            projectedUsageTokens: 272_000,
            targetContextWindow: 272_000,
            effectiveContextLimit: 272_000,
            fittingExitTarget: 217_600,
        })
    })

    it("uses the percentage guarded context for fitting instead of the provider window", () => {
        expect(
            decideTargetWindowFitting({
                candidateEstimatedTokens: 358_720,
                providerContextWindow: 472_000,
                triggerPercent: 95,
                minReserveTokens: 5_000,
                maxReserveTokens: 30_000,
                maxContextTokens: 0,
                hasMoreTurns: true,
            }),
        ).toEqual({
            status: "continue",
            projectedUsageTokens: 358_720,
            targetContextWindow: 472_000,
            effectiveContextLimit: 448_400,
            fittingExitTarget: 358_720,
        })
    })
})
