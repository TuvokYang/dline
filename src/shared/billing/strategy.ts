import type {
    ContextWindowBand,
    ContextWindowPricing,
    MeteredPricing,
    ModelPricing,
    PriceSet,
    PricingStrategy,
    TimeOfDayPricing,
    TimeWindow,
} from "@shared/proto/dline/models/metadata"
import { lookupHolidayCalendar } from "./holidays"
import { windowAtInstant } from "./schedule"
import { BillingConfigurationError, type PricingFacts, type ResolvedBilling, type ResolvedPrices } from "./types"

/**
 * Require a declared price set.
 *
 * Proto optional scalars and messages arrive as optional fields, so a band whose
 * `prices` group is missing is structurally invalid rather than free. Failing
 * here keeps a catalog defect from silently billing zero.
 */
function requirePrices(prices: PriceSet | undefined): PriceSet {
    if (!prices) {
        throw new BillingConfigurationError("a price set is required but missing")
    }
    return prices
}

/** Convert a published price set into the resolved shape, treating absent cache prices as zero. */
function toResolvedPrices(prices: PriceSet | undefined, currency: string): ResolvedPrices {
    const declared = requirePrices(prices)
    return {
        inputPrice: declared.inputPrice,
        outputPrice: declared.outputPrice,
        cacheWritePrice: declared.cacheWritePrice ?? 0,
        cacheReadPrice: declared.cacheReadPrice ?? 0,
        thinkingOutputPrice: declared.thinkingOutputPrice,
        currency,
    }
}

/**
 * Pick the band that covers a request's total input tokens.
 *
 * Bands are ascending and the last one is unbounded, so the first covering band
 * wins. A request whose token count is unknown cannot be placed, which only
 * happens when a caller skips usage reporting.
 */
function selectBand(bands: readonly ContextWindowBand[], totalInputTokens: number | undefined): ContextWindowBand {
    if (bands.length === 0) {
        throw new BillingConfigurationError("context-window pricing declares no bands")
    }
    if (totalInputTokens === undefined) {
        throw new BillingConfigurationError("context-window pricing needs total input tokens to select a band")
    }
    const ordered = [...bands].sort(
        (left, right) => (left.maxInputTokens ?? Number.POSITIVE_INFINITY) - (right.maxInputTokens ?? Number.POSITIVE_INFINITY),
    )
    const covering = ordered.find((band) => band.maxInputTokens === undefined || totalInputTokens <= band.maxInputTokens)
    if (!covering) {
        throw new BillingConfigurationError(
            "context-window pricing has no unbounded band; the highest band leaves requests above it unpriced",
        )
    }
    return covering
}

/** Resolve one of the two price shapes a rate can carry. */
function resolveBandPrices(
    prices: PriceSet | undefined,
    bands: ContextWindowPricing | undefined,
    facts: PricingFacts,
    currency: string,
): ResolvedPrices {
    if (prices && bands) {
        throw new BillingConfigurationError("a time-of-day rate declares both a flat price set and window bands")
    }
    if (prices) {
        return toResolvedPrices(prices, currency)
    }
    if (bands) {
        const band = selectBand(bands.bands ?? [], facts.totalInputTokens)
        return toResolvedPrices(band.prices, currency)
    }
    throw new BillingConfigurationError("a time-of-day rate declares neither a price set nor window bands")
}

/**
 * Reject windows that overlap along the local clock.
 *
 * Two overlapping windows can both cover an instant, so the billed rate would
 * depend on the order they happen to be stored in. That is a configuration
 * defect in the price list, not a condition a request can resolve.
 */
function assertNonOverlapping(windows: readonly TimeWindow[]): void {
    const ordered = [...windows].sort((left, right) => left.startMinute - right.startMinute)
    for (let index = 1; index < ordered.length; index += 1) {
        const previous = ordered[index - 1]
        const current = ordered[index]
        if (current.startMinute < previous.endMinute) {
            throw new BillingConfigurationError(
                `time windows overlap at minute ${current.startMinute}; each instant must bill at exactly one rate`,
            )
        }
    }
}

/**
 * Resolve the prices of a time-of-day strategy.
 *
 * Time is decided first and the token band second, because the seller bills one
 * rate for the whole request based on when it started. Every instant no window
 * covers bills the default rate, which is what lets a seller publish one
 * discount period or several without changing the shape.
 */
function resolveTimeOfDay(timeOfDay: TimeOfDayPricing, facts: PricingFacts, currency: string): ResolvedPrices {
    const windows = timeOfDay.timeWindows ?? []
    assertNonOverlapping(windows)
    const window = windowAtInstant(facts.requestedAt, timeOfDay.schedule, windows, lookupHolidayCalendar)
    if (window) {
        return resolveBandPrices(window.prices, window.bands, facts, currency)
    }
    return resolveBandPrices(timeOfDay.defaultPrices, timeOfDay.defaultBands, facts, currency)
}

/** Resolve a metered strategy. Exactly one strategy must be present. */
function resolveStrategy(strategy: PricingStrategy, facts: PricingFacts, currency: string): ResolvedPrices {
    const declared = [strategy.flat, strategy.contextWindow, strategy.timeOfDay].filter((candidate) => candidate !== undefined)
    if (declared.length !== 1) {
        throw new BillingConfigurationError(`metered pricing must declare exactly one strategy, found ${declared.length}`)
    }
    if (strategy.flat) {
        return toResolvedPrices(strategy.flat.prices, currency)
    }
    if (strategy.contextWindow) {
        const band = selectBand(strategy.contextWindow.bands ?? [], facts.totalInputTokens)
        return toResolvedPrices(band.prices, currency)
    }
    return resolveTimeOfDay(strategy.timeOfDay as TimeOfDayPricing, facts, currency)
}

/** Resolve a metered model's terms. */
function resolveMetered(metered: MeteredPricing, facts: PricingFacts): ResolvedPrices {
    if (!metered.strategy) {
        throw new BillingConfigurationError("metered pricing declares no strategy")
    }
    return resolveStrategy(metered.strategy, facts, metered.currency)
}

/**
 * Resolve the price set that applies to one request.
 *
 * This is the only function that knows the pricing shapes. Callers pass the
 * model's published terms and the request facts, and receive either a resolved
 * price set or a reason there is nothing to bill.
 *
 * @param pricing The model's published billing terms.
 * @param facts Request facts the price depends on.
 * @returns The resolved price set, or the reason the request is not billable.
 * @throws BillingConfigurationError when the published terms are structurally invalid.
 */
export function resolvePrices(pricing: ModelPricing | undefined, facts: PricingFacts): ResolvedBilling {
    if (!pricing) {
        return { kind: "not-billable", reason: "unknown" }
    }

    const declared = [pricing.metered, pricing.subscription, pricing.free].filter((candidate) => candidate !== undefined)
    if (declared.length === 0) {
        // An empty pricing message is what a proto round-trip produces for a model
        // with no published terms. Reporting it as unbillable keeps that case from
        // failing a response that simply has nothing to charge for.
        return { kind: "not-billable", reason: "unknown" }
    }
    if (declared.length > 1) {
        throw new BillingConfigurationError(`model pricing must declare exactly one mode, found ${declared.length}`)
    }

    if (pricing.subscription) {
        return { kind: "not-billable", reason: "subscription" }
    }
    if (pricing.free) {
        return { kind: "not-billable", reason: "free" }
    }
    return { kind: "metered", prices: resolveMetered(pricing.metered as MeteredPricing, facts) }
}
