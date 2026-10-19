export interface InclusiveInputUsage {
    totalInputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
}

export interface CanonicalInputUsage {
    inputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
}

/**
 * Split Provider prompt usage when cache fields are documented subsets of the
 * reported total input count. Do not use this for disjoint Anthropic-style
 * input/cache fields.
 */
export function splitInclusiveInputUsage(usage: InclusiveInputUsage): CanonicalInputUsage {
    const totalInputTokens = normalizeTokens(usage.totalInputTokens)
    const cacheReadTokens = normalizeTokens(usage.cacheReadTokens)
    const cacheWriteTokens = normalizeTokens(usage.cacheWriteTokens)

    return {
        inputTokens: Math.max(0, totalInputTokens - cacheReadTokens - cacheWriteTokens),
        cacheReadTokens,
        cacheWriteTokens,
    }
}

/** Chat Completions usage as far as its reasoning share is concerned. */
export interface ChatCompletionReasoningUsage {
    readonly completion_tokens_details?: { readonly reasoning_tokens?: number | null } | null
}

/**
 * The reasoning share of a Chat Completions `completion_tokens`, which already
 * includes it; absent when the provider does not report one. Reported as the
 * stream's `thoughtsTokenCount`, which is likewise a share of `outputTokens`.
 */
export function chatReasoningTokens(usage: ChatCompletionReasoningUsage | undefined): number | undefined {
    const value = usage?.completion_tokens_details?.reasoning_tokens
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

function normalizeTokens(value: number | undefined): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}
