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

function normalizeTokens(value: number | undefined): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}
