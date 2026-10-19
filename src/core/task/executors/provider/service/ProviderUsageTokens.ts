/** The token and cost figures of a settled request, read from its usage record. */
export interface SettledUsageTokens {
    /** Fresh input, excluding cache reads and writes. */
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheWriteTokens: number
    readonly cacheReadTokens: number
    /** The provider's reported cost; absent when it reported none, so the model price applies. */
    readonly totalCost?: number
}

/**
 * Read the token counts and reported cost of a settled request.
 *
 * An absent cost lets callers price the request from model metadata; an
 * explicitly reported zero suppresses that fallback for subscriptions and free tiers.
 */
export function readSettledUsageTokens(usage: Readonly<Record<string, number>> | undefined): SettledUsageTokens {
    const costUsageReported = usageWasReported(usage, "costUsageReported", "totalCost")
    return {
        inputTokens: nonNegative(usage?.inputTokens),
        outputTokens: nonNegative(usage?.outputTokens),
        cacheWriteTokens: nonNegative(usage?.cacheWriteTokens),
        cacheReadTokens: nonNegative(usage?.cacheReadTokens),
        totalCost: costUsageReported ? optionalNonNegative(usage?.totalCost) : undefined,
    }
}

/** Whether the provider reported a category, by its marker flag or, without one, by the value's presence. */
export function usageWasReported(
    usage: Readonly<Record<string, number>> | undefined,
    markerKey: string,
    valueKey: string,
): boolean {
    if (!usage) return false
    const marker = usage[markerKey]
    if (typeof marker === "number" && Number.isFinite(marker)) return marker > 0
    return Object.hasOwn(usage, valueKey)
}

export function nonNegative(value: number | undefined): number {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0
}

export function optionalNonNegative(value: number | undefined): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined
}
