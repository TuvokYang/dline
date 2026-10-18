import type { ModelInfo } from "@shared/api"
import { calculateApiCostAnthropic } from "@/utils/cost"

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

const MICRO_UNITS_PER_DOLLAR = 1_000_000
const USD = "USD"

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

/**
 * The request's cost in millionths of a US dollar, priced the way the chat row prices it.
 *
 * Returns undefined when the model is priced in another currency: there is no
 * exchange rate here, and counting yuan as dollars would corrupt every total.
 */
export function settledCostMicroUsd(tokens: SettledUsageTokens, modelInfo: ModelInfo): number | undefined {
    const currency = modelInfo.pricing?.currency
    if (currency && currency.toUpperCase() !== USD) return undefined
    const cost =
        tokens.totalCost ??
        calculateApiCostAnthropic(
            modelInfo,
            tokens.inputTokens,
            tokens.outputTokens,
            tokens.cacheWriteTokens,
            tokens.cacheReadTokens,
        )
    return Number.isFinite(cost) && cost >= 0 ? Math.round(cost * MICRO_UNITS_PER_DOLLAR) : undefined
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
