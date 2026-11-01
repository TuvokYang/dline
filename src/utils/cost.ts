import { ModelInfo } from "@shared/api"
import { billableTokens, costOf, type PricingFacts, resolvePrices, type UsageProfile } from "@shared/billing"

/**
 * Cost of one API call.
 *
 * The published pricing terms decide the rate; this module only supplies the
 * request facts and the provider's token-counting convention. All price-shape
 * interpretation lives in `@shared/billing`, so a new pricing strategy does not
 * change this file.
 *
 * A model with no published terms has no cost. That is reported as zero rather
 * than an error because caller reporting already distinguishes "no cost known"
 * from "cost was zero" through its own presence checks.
 */
function calculateApiCostInternal(
    modelInfo: ModelInfo,
    profile: UsageProfile,
    inputTokens: number,
    outputTokens: number,
    cacheCreationInputTokens: number,
    cacheReadInputTokens: number,
    totalInputTokensForPricing: number | undefined,
    thinkingBudgetTokens: number | undefined,
): number {
    const facts: PricingFacts = { totalInputTokens: totalInputTokensForPricing }
    const resolved = resolvePrices(modelInfo.pricing, facts)
    if (resolved.kind === "not-billable") {
        return 0
    }

    const tokens = billableTokens(profile, {
        inputTokens,
        outputTokens,
        cacheWriteTokens: cacheCreationInputTokens,
        cacheReadTokens: cacheReadInputTokens,
        thinkingTokens: thinkingBudgetTokens,
    })
    return costOf(resolved.prices, tokens)
}

// For Anthropic compliant usage, the input tokens count does NOT include the cached tokens
export function calculateApiCostAnthropic(
    modelInfo: ModelInfo,
    inputTokens: number,
    outputTokens: number,
    cacheCreationInputTokens?: number,
    cacheReadInputTokens?: number,
    thinkingBudgetTokens?: number,
): number {
    const cacheCreationInputTokensNum = cacheCreationInputTokens || 0
    const cacheReadInputTokensNum = cacheReadInputTokens || 0
    // Anthropic style: inputTokens already represents the total, so pass it directly for tiered pricing lookup if needed
    // (though Anthropic models currently don't use tiered pricing based on input size)
    // Anthropic style doesn't need totalInputTokensForPricing as its inputTokens already represents the total
    return calculateApiCostInternal(
        modelInfo,
        "anthropic",
        inputTokens,
        outputTokens,
        cacheCreationInputTokensNum,
        cacheReadInputTokensNum,
        inputTokens + cacheCreationInputTokensNum + cacheReadInputTokensNum, // used for tiered price lookup
        thinkingBudgetTokens,
    )
}

// For OpenAI compliant usage, the input tokens count INCLUDES the cached tokens
export function calculateApiCostOpenAI(
    modelInfo: ModelInfo,
    inputTokens: number, // For OpenAI-style, this includes cached tokens
    outputTokens: number,
    cacheCreationInputTokens?: number,
    cacheReadInputTokens?: number,
    thinkingBudgetTokens?: number,
): number {
    const cacheCreationInputTokensNum = cacheCreationInputTokens || 0
    const cacheReadInputTokensNum = cacheReadInputTokens || 0
    // Pass the original 'inputTokens' as 'totalInputTokensForPricing' for tier lookup
    return calculateApiCostInternal(
        modelInfo,
        "openai",
        inputTokens,
        outputTokens,
        cacheCreationInputTokensNum,
        cacheReadInputTokensNum,
        inputTokens,
        thinkingBudgetTokens,
    )
}

// For Qwen compliant usage, follows OpenAI-style token counting where input tokens include cached tokens
export function calculateApiCostQwen(
    modelInfo: ModelInfo,
    inputTokens: number, // For Qwen-style, this includes cached tokens
    outputTokens: number,
    cacheCreationInputTokens?: number,
    cacheReadInputTokens?: number,
    thinkingBudgetTokens?: number,
): number {
    const cacheCreationInputTokensNum = cacheCreationInputTokens || 0
    const cacheReadInputTokensNum = cacheReadInputTokens || 0
    // Pass the original 'inputTokens' as 'totalInputTokensForPricing' for tier lookup
    return calculateApiCostInternal(
        modelInfo,
        "qwen",
        inputTokens,
        outputTokens,
        cacheCreationInputTokensNum,
        cacheReadInputTokensNum,
        inputTokens,
        thinkingBudgetTokens,
    )
}
