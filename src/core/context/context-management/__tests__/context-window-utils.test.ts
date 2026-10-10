import { OpenAiHandler } from "@core/api/providers/openai"
import {
    DEFAULT_AUTO_CONDENSE_MAX_CONTEXT_TOKENS,
    DEFAULT_AUTO_CONDENSE_TRIGGER_PERCENT,
    normalizeAutoCondenseMaxContextTokens,
    normalizeAutoCondenseTriggerPercent,
} from "@shared/auto-condense"
import type { ModelInfo } from "@shared/proto/dline/models"
import { describe, expect, it } from "vitest"
import {
    computeCompactTrigger,
    computeSafetyBuffer,
    computeSummarizeBudget,
    getContextWindowInfo,
    getEstimationTolerance,
    resolveCompactTriggerPolicy,
    shouldCompactProjectedUsage,
} from "../context-window-utils"

function openAiHandlerWithModel(id: string, contextWindow?: number): OpenAiHandler {
    const handler = Object.create(OpenAiHandler.prototype) as OpenAiHandler
    handler.getModel = () => ({
        id,
        info: {
            id,
            ...(contextWindow !== undefined
                ? { capabilities: { contextWindow, maxTokens: 8192 } as ModelInfo["capabilities"] }
                : {}),
        } as ModelInfo,
    })
    return handler
}

describe("auto-condense context trigger", () => {
    it("reserves three percent clamped to 5K through 30K", () => {
        expect(computeSafetyBuffer(64_000)).toBe(5_000)
        expect(computeSafetyBuffer(500_000)).toBe(15_000)
        expect(computeSafetyBuffer(1_000_000)).toBe(30_000)
        expect(computeSafetyBuffer(2_000_000)).toBe(30_000)
    })

    it("includes the compaction prompt and 3K closure reserve in the 372K trigger", () => {
        const summarizeBudget = computeSummarizeBudget()
        const triggerTokens = computeCompactTrigger(372_000, summarizeBudget)

        expect(computeSafetyBuffer(372_000)).toBe(11_160)
        expect(summarizeBudget).toBe(2_500)
        expect(triggerTokens).toBe(357_340)
        expect(getEstimationTolerance()).toBe(2_000)
        expect(shouldCompactProjectedUsage(355_339, triggerTokens)).toBe(false)
        expect(shouldCompactProjectedUsage(355_340, triggerTokens)).toBe(true)
    })

    it("uses only the hard ceiling when no auto-condense settings are supplied", () => {
        const summarizeBudget = computeSummarizeBudget()
        expect(computeCompactTrigger(128_000, summarizeBudget)).toBe(119_500)
        expect(computeCompactTrigger(1_000_000, summarizeBudget)).toBe(966_500)
        expect(computeCompactTrigger(2_000_000, summarizeBudget)).toBe(1_966_500)
    })

    it("preserves the default 97 percent reserve clamp at small and large windows", () => {
        const defaultPolicy = {
            triggerPercent: DEFAULT_AUTO_CONDENSE_TRIGGER_PERCENT,
            minReserveTokens: 5_000,
            maxReserveTokens: 30_000,
            maxContextTokens: 0,
        }

        expect(computeCompactTrigger(128_000, computeSummarizeBudget(), defaultPolicy)).toBe(119_500)
        expect(computeCompactTrigger(2_000_000, computeSummarizeBudget(), defaultPolicy)).toBe(1_966_500)
    })

    it("uses the guarded percentage branch when the window equals the absolute cap", () => {
        const defaultPolicy = {
            triggerPercent: DEFAULT_AUTO_CONDENSE_TRIGGER_PERCENT,
            minReserveTokens: 5_000,
            maxReserveTokens: 30_000,
            maxContextTokens: 272_000,
        }

        expect(computeCompactTrigger(272_000, computeSummarizeBudget(), defaultPolicy)).toBe(260_340)
    })

    it("uses the absolute cap only when the provider window is strictly larger", () => {
        const defaultPolicy = {
            triggerPercent: DEFAULT_AUTO_CONDENSE_TRIGGER_PERCENT,
            minReserveTokens: 5_000,
            maxReserveTokens: 30_000,
            maxContextTokens: 272_000,
        }

        expect(computeCompactTrigger(1_000_000, computeSummarizeBudget(), defaultPolicy)).toBe(268_500)
    })

    it("can trigger with 180K provider headroom when Maximum context is configured as an absolute cap", () => {
        const providerContextWindow = 752_000
        const configuredMaximumContext = 572_000
        const policy = resolveCompactTriggerPolicy(providerContextWindow, computeSummarizeBudget(), {
            triggerPercent: DEFAULT_AUTO_CONDENSE_TRIGGER_PERCENT,
            minReserveTokens: 5_000,
            maxReserveTokens: 30_000,
            maxContextTokens: configuredMaximumContext,
        })

        expect(policy).toMatchObject({
            branch: "absolute_cap",
            effectiveContextLimitTokens: configuredMaximumContext,
            hardPassContextWindowTokens: configuredMaximumContext,
            projectedUsageTriggerTokens: 566_500,
            compactTriggerTokens: 568_500,
            // The absolute cap keeps no percentage reserve, so the concession is half of the
            // closure reserve alone.
            passInputCeilingAllowanceTokens: 1_500,
            passInputCeilingTokens: 568_000,
        })
        expect(shouldCompactProjectedUsage(566_499, policy.compactTriggerTokens)).toBe(false)
        expect(shouldCompactProjectedUsage(566_500, policy.compactTriggerTokens)).toBe(true)
        expect(providerContextWindow - policy.effectiveContextLimitTokens).toBe(180_000)
    })

    it("clamps the percentage reserve below, within, and above the configured interval", () => {
        const summarizeBudget = computeSummarizeBudget()
        const settings = {
            triggerPercent: DEFAULT_AUTO_CONDENSE_TRIGGER_PERCENT,
            minReserveTokens: 5_000,
            maxReserveTokens: 30_000,
        }

        expect(computeCompactTrigger(128_000, summarizeBudget, settings)).toBe(119_500)
        expect(computeCompactTrigger(500_000, summarizeBudget, settings)).toBe(481_500)
        expect(computeCompactTrigger(2_000_000, summarizeBudget, settings)).toBe(1_966_500)
    })

    it("lends half of the guarded reserve so a complete range stays one Pass", () => {
        const policy = resolveCompactTriggerPolicy(472_000, computeSummarizeBudget(), {
            triggerPercent: 95,
            minReserveTokens: 5_000,
            maxReserveTokens: 30_000,
            maxContextTokens: 0,
        })

        expect(policy).toMatchObject({
            branch: "percentage_guarded",
            guardedReserveTokens: 23_600,
            effectiveContextLimitTokens: 448_400,
            hardPassContextWindowTokens: 472_000,
            projectedUsageTriggerTokens: 442_900,
            compactTriggerTokens: 444_900,
            passInputCeilingAllowanceTokens: 11_800,
            passInputCeilingTokens: 454_700,
        })
        // 472000 window at 95%: reserve 23600, so the concession is exactly half of that reserve.
        expect(policy.passInputCeilingTokens - policy.projectedUsageTriggerTokens).toBe(11_800)
    })

    it("never resolves a Pass ceiling below the compaction trigger", () => {
        // A ceiling under the trigger would reject the very range compaction was started for and
        // leave the task unable to make progress.
        for (const contextWindow of [16_000, 64_000, 128_000, 272_000, 472_000, 1_000_000]) {
            for (const triggerPercent of [50, 80, 95, 97]) {
                for (const maxContextTokens of [0, 272_000]) {
                    const policy = resolveCompactTriggerPolicy(contextWindow, computeSummarizeBudget(), {
                        triggerPercent,
                        minReserveTokens: 5_000,
                        maxReserveTokens: 30_000,
                        maxContextTokens,
                    })
                    expect(policy.passInputCeilingTokens).toBeGreaterThanOrEqual(policy.projectedUsageTriggerTokens)
                    expect(policy.passInputCeilingTokens).toBeLessThanOrEqual(policy.hardPassContextWindowTokens)
                }
            }
        }
    })

    it("uses the guarded branch at an equal cap and the absolute branch below the provider window", () => {
        const percentagePolicy = resolveCompactTriggerPolicy(272_000, computeSummarizeBudget(), {
            triggerPercent: DEFAULT_AUTO_CONDENSE_TRIGGER_PERCENT,
            minReserveTokens: 5_000,
            maxReserveTokens: 30_000,
            maxContextTokens: 272_000,
        })
        const absolutePolicy = resolveCompactTriggerPolicy(1_000_000, computeSummarizeBudget(), {
            triggerPercent: DEFAULT_AUTO_CONDENSE_TRIGGER_PERCENT,
            minReserveTokens: 5_000,
            maxReserveTokens: 30_000,
            maxContextTokens: 272_000,
        })

        expect(percentagePolicy).toMatchObject({
            branch: "percentage_guarded",
            guardedReserveTokens: 8_160,
            effectiveContextLimitTokens: 263_840,
            hardPassContextWindowTokens: 272_000,
            projectedUsageTriggerTokens: 258_340,
            compactTriggerTokens: 260_340,
            passInputCeilingAllowanceTokens: 4_080,
            passInputCeilingTokens: 262_420,
        })
        expect(absolutePolicy).toMatchObject({
            branch: "absolute_cap",
            effectiveContextLimitTokens: 272_000,
            hardPassContextWindowTokens: 272_000,
            projectedUsageTriggerTokens: 266_500,
            compactTriggerTokens: 268_500,
            passInputCeilingTokens: 268_000,
        })
    })

    it("normalizes persisted values into supported ranges", () => {
        expect(normalizeAutoCondenseTriggerPercent(undefined)).toBe(DEFAULT_AUTO_CONDENSE_TRIGGER_PERCENT)
        expect(normalizeAutoCondenseTriggerPercent(0)).toBe(1)
        expect(normalizeAutoCondenseTriggerPercent(120)).toBe(97)
        expect(normalizeAutoCondenseMaxContextTokens(undefined)).toBe(DEFAULT_AUTO_CONDENSE_MAX_CONTEXT_TOKENS)
        expect(normalizeAutoCondenseMaxContextTokens(-1)).toBe(0)
        expect(normalizeAutoCondenseMaxContextTokens(600_000.9)).toBe(600_000)
    })
})

describe("getContextWindowInfo", () => {
    it("preserves an explicit OpenAI-compatible context window for DeepSeek model IDs", () => {
        expect(getContextWindowInfo(openAiHandlerWithModel("custom-deepseek-v4", 256_000))).toEqual({
            contextWindow: 256_000,
            maxAllowedSize: 216_000,
        })
    })

    it("falls back to the default context window when capabilities are missing", () => {
        expect(getContextWindowInfo(openAiHandlerWithModel("gpt-5-nano"))).toEqual({
            contextWindow: 128_000,
            maxAllowedSize: 98_000,
        })
    })
})
