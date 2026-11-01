import type {
    ContextWindowBand,
    MeteredPricing,
    ModelPricing,
    PriceSet,
    PricingSchedule,
} from "@shared/proto/dline/models/metadata"

/**
 * Pricing constructors for the bundled catalog.
 *
 * A catalog entry carries 300+ price literals. Writing the full nested
 * `metered.strategy.flat.prices` shape at each of them made the price tables
 * unreadable, so these helpers wrap the shape once. They only fill defaults and
 * nest: no price is derived, discounted, or validated here. Consumers still read
 * strict proto shapes through `resolvePrices`.
 */

/** Price set for one rate. Cache prices default to zero, which is what an unpublished cache price means. */
export function priceSet(
    inputPrice: number,
    outputPrice: number,
    cacheWritePrice?: number,
    cacheReadPrice?: number,
    thinkingOutputPrice?: number,
): PriceSet {
    return { inputPrice, outputPrice, cacheWritePrice, cacheReadPrice, thinkingOutputPrice }
}

/** A model billed at one rate for every request. */
export function flatPricing(
    inputPrice: number,
    outputPrice: number,
    cacheWritePrice?: number,
    cacheReadPrice?: number,
    currency = "USD",
    thinkingOutputPrice?: number,
): ModelPricing {
    return metered({
        currency,
        strategy: {
            flat: { prices: priceSet(inputPrice, outputPrice, cacheWritePrice, cacheReadPrice, thinkingOutputPrice) },
        },
    })
}

/** One band of a context-window price. Omit `maxInputTokens` on the last band to leave it unbounded. */
export function band(
    maxInputTokens: number | undefined,
    inputPrice: number,
    outputPrice: number,
    cacheWritePrice?: number,
    cacheReadPrice?: number,
    thinkingOutputPrice?: number,
): ContextWindowBand {
    return {
        maxInputTokens,
        prices: priceSet(inputPrice, outputPrice, cacheWritePrice, cacheReadPrice, thinkingOutputPrice),
    }
}

/** A model billed by the request's total input tokens. The final band must be unbounded. */
export function bandedPricing(bands: readonly ContextWindowBand[], currency = "USD"): ModelPricing {
    return metered({ currency, strategy: { contextWindow: { bands: [...bands] } } })
}

/** One window of a time-of-day price, billed at its own rate. */
export interface TimeWindowInput {
    startMinute: number
    endMinute: number
    prices?: PriceSet
    bands?: readonly ContextWindowBand[]
}

/**
 * A model billed by a default rate plus non-overlapping windows of its own.
 *
 * `defaultPrices` covers every instant no window covers, so a seller that
 * discounts one period declares one window, and a seller with two daily peak
 * periods declares two windows over the same default.
 */
export function timeOfDayPricing(input: {
    schedule: PricingSchedule
    defaultPrices?: PriceSet
    defaultBands?: readonly ContextWindowBand[]
    timeWindows?: readonly TimeWindowInput[]
    currency?: string
}): ModelPricing {
    return metered({
        currency: input.currency ?? "USD",
        strategy: {
            timeOfDay: {
                schedule: input.schedule,
                defaultPrices: input.defaultPrices,
                defaultBands: input.defaultBands ? { bands: [...input.defaultBands] } : undefined,
                timeWindows: (input.timeWindows ?? []).map((window) => ({
                    startMinute: window.startMinute,
                    endMinute: window.endMinute,
                    prices: window.prices,
                    bands: window.bands ? { bands: [...window.bands] } : undefined,
                })),
            },
        },
    })
}

/** A plan or prepaid quota covers the model, so no per-request cost is computed. */
export function subscriptionPricing(): ModelPricing {
    return { subscription: {} }
}

/** The model carries no charge and no quota. */
export function freePricing(): ModelPricing {
    return { free: {} }
}

/** Wrap a strategy in the metered mode. Exported because catalogs occasionally compose a strategy directly. */
export function metered(pricing: MeteredPricing): ModelPricing {
    return { metered: pricing }
}
