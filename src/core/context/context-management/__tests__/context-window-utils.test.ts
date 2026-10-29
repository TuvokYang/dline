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

    it("measures the trigger against Maximum context when the provider window is strictly larger", () => {
        const defaultPolicy = {
            triggerPercent: DEFAULT_AUTO_CONDENSE_TRIGGER_PERCENT,
            minReserveTokens: 5_000,
            maxReserveTokens: 30_000,
            maxContextTokens: 272_000,
        }

        // W = 272K: the reserve is taken from W exactly as for a 272K provider window.
        expect(computeCompactTrigger(1_000_000, computeSummarizeBudget(), defaultPolicy)).toBe(260_340)
    })

    it("places the trigger of the 400K acceptance example at 382.5K", () => {
        const policy = resolveCompactTriggerPolicy(1_000_000, computeSummarizeBudget(), {
            triggerPercent: 97,
            minReserveTokens: 5_000,
            maxReserveTokens: 30_000,
            maxContextTokens: 400_000,
        })

        expect(policy).toMatchObject({
            configuredContextWindowTokens: 400_000,
            guardedReserveTokens: 12_000,
            projectedUsageTriggerTokens: 382_500,
            passInputCeilingTokens: 382_500,
        })
    })

    it("caps a hidden Pass at the trigger line when Maximum context is set below the provider window", () => {
        const providerContextWindow = 752_000
        const configuredMaximumContext = 572_000
        const policy = resolveCompactTriggerPolicy(providerContextWindow, computeSummarizeBudget(), {
            triggerPercent: DEFAULT_AUTO_CONDENSE_TRIGGER_PERCENT,
            minReserveTokens: 5_000,
            maxReserveTokens: 30_000,
            maxContextTokens: configuredMaximumContext,
        })

        // Reserve = 572K × 3% = 17,160, left free for the summary inside W.
        expect(policy).toMatchObject({
            branch: "absolute_cap",
            guardedReserveTokens: 17_160,
            effectiveContextLimitTokens: configuredMaximumContext - 17_160,
            hardPassContextWindowTokens: providerContextWindow,
            configuredContextWindowTokens: configuredMaximumContext,
            projectedUsageTriggerTokens: 549_340,
            compactTriggerTokens: 551_340,
            passInputCeilingTokens: 549_340,
        })
        expect(shouldCompactProjectedUsage(549_339, policy.compactTriggerTokens)).toBe(false)
        expect(shouldCompactProjectedUsage(549_340, policy.compactTriggerTokens)).toBe(true)
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

    it("leaves the configured reserve to the summary by capping a Pass at the trigger line", () => {
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
            passInputCeilingTokens: 442_900,
        })
        // T = W - reserve - summarize instruction - closure reserve.
        expect(policy.passInputCeilingTokens).toBe(472_000 - 23_600 - 2_500 - 3_000)
        // The turn that crosses T may take half of the reserve; the other half stays for the summary.
        expect(policy.lastTurnPassInputCeilingTokens).toBe(policy.passInputCeilingTokens + 11_800)
    })

    it("resolves the Pass ceiling to exactly the trigger line T for every setting", () => {
        // A larger ceiling would spend the reserve the summary needs; a smaller one would reject
        // ranges compaction was started for. Turns larger than T are split instead.
        for (const contextWindow of [16_000, 64_000, 128_000, 272_000, 472_000, 1_000_000]) {
            for (const triggerPercent of [50, 80, 95, 97]) {
                for (const maxContextTokens of [0, 272_000]) {
                    const policy = resolveCompactTriggerPolicy(contextWindow, computeSummarizeBudget(), {
                        triggerPercent,
                        minReserveTokens: 5_000,
                        maxReserveTokens: 30_000,
                        maxContextTokens,
                    })
                    expect(policy.passInputCeilingTokens).toBe(policy.projectedUsageTriggerTokens)
                    expect(policy.passInputCeilingTokens).toBeLessThan(policy.configuredContextWindowTokens)
                }
            }
        }
    })

    it("resolves the same trigger for Maximum context as for an equal provider window", () => {
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
            passInputCeilingTokens: 258_340,
        })
        expect(absolutePolicy).toMatchObject({
            branch: "absolute_cap",
            guardedReserveTokens: 8_160,
            effectiveContextLimitTokens: 263_840,
            hardPassContextWindowTokens: 1_000_000,
            projectedUsageTriggerTokens: 258_340,
            compactTriggerTokens: 260_340,
            passInputCeilingTokens: 258_340,
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
