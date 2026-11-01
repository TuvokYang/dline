import {
    type ContextWindowBand,
    type ModelPricing,
    type PriceSet,
    PricingDayRule,
    type PricingSchedule,
    type TimeWindow,
} from "@shared/proto/dline/models/metadata"

/**
 * Read/write helpers for the published pricing shape.
 *
 * `ModelPricing` is a mode union: a model either bills per token (metered), is
 * covered by a plan, or is free. A metered price then picks exactly one
 * strategy: one flat rate, token bands, or a time-of-day schedule.
 *
 * All three are editable from settings. A user may legitimately switch a
 * profile from one shape to another — a reseller that publishes peak/off-peak
 * rates is a real seller shape, not just catalog data — so the writers below
 * create the strategy they are asked for instead of requiring the catalog to
 * have declared it first.
 */

/** The metered strategy a profile currently uses. */
export type PricingShapeKind = "flat" | "contextWindow" | "timeOfDay"

/**
 * Build a schedule that declares no day rule.
 *
 * The windows carry the rates now, so this only supplies the clock the windows
 * are read against. The object is rebuilt per call so a consumer cannot mutate a
 * shared schedule.
 */
export function emptyPricingSchedule(): PricingSchedule {
    return {
        timezoneOffsetMinutes: 0,
        dayRule: PricingDayRule.PRICING_DAY_RULE_UNSPECIFIED,
        defaultOnPublicHolidays: false,
        holidayCalendar: "",
    }
}

/** Which rate shape one window of a time-of-day price uses. */
export type TimeWindowRateKind = "prices" | "bands"

/** Read which rate shape a window carries, defaulting to a flat price set. */
export function readTimeWindowRate(window: TimeWindow | undefined): TimeWindowRateKind {
    return window?.bands ? "bands" : "prices"
}

/** Read which metered strategy is present, defaulting to a flat rate. */
export function readPricingShape(pricing: ModelPricing | undefined): PricingShapeKind {
    const strategy = pricing?.metered?.strategy
    if (strategy?.contextWindow) return "contextWindow"
    if (strategy?.timeOfDay) return "timeOfDay"
    return "flat"
}

/**
 * Rewrite a metered price into the requested strategy.
 *
 * Only the metered mode is rewritten. A plan or a free price has no per-token
 * rate to reshape, so those values are returned unchanged and the caller keeps
 * showing its own controls.
 *
 * @param pricing Pricing to reshape.
 * @param kind Strategy to install.
 * @param currency Currency the rates are quoted in.
 * @returns Pricing using the requested strategy, or the original value.
 */
export function withPricingShape(
    pricing: ModelPricing | undefined,
    kind: PricingShapeKind,
    currency: string,
): ModelPricing | undefined {
    if (!pricing?.metered) {
        return kind === "flat" ? flatMeteredPricing(0, 0, undefined, undefined, currency) : undefined
    }
    const current = pricing.metered.strategy
    // Carry the rates the user already typed into the newly chosen shape so
    // switching shapes never silently resets a published price to zero.
    const carried = readPriceSet(
        current?.flat?.prices ??
            current?.contextWindow?.bands?.[0]?.prices ??
            current?.timeOfDay?.defaultPrices ??
            current?.timeOfDay?.timeWindows?.[0]?.prices,
    )
    const base: Omit<PriceSet, "thinkingOutputPrice"> = {
        inputPrice: carried.inputPrice,
        outputPrice: carried.outputPrice,
        cacheWritePrice: carried.cacheWritePrice,
        cacheReadPrice: carried.cacheReadPrice,
    }
    const strategy =
        kind === "flat"
            ? { flat: { prices: base } }
            : kind === "contextWindow"
              ? { contextWindow: { bands: [{ maxInputTokens: 128_000, prices: base }] } }
              : { timeOfDay: { schedule: emptyPricingSchedule(), defaultPrices: base, timeWindows: [] } }
    return { metered: { ...pricing.metered, currency, strategy } }
}

/** Cache prices default to zero when unpublished, which is what a price list means by omitting them. */
export function readPriceSet(prices: PriceSet | undefined): {
    inputPrice: number
    outputPrice: number
    cacheWritePrice: number
    cacheReadPrice: number
} {
    return {
        inputPrice: prices?.inputPrice ?? 0,
        outputPrice: prices?.outputPrice ?? 0,
        cacheWritePrice: prices?.cacheWritePrice ?? 0,
        cacheReadPrice: prices?.cacheReadPrice ?? 0,
    }
}

/** The currency a metered price is quoted in, or undefined for non-metered modes. */
export function readCurrency(pricing: ModelPricing | undefined): string | undefined {
    return pricing?.metered?.currency
}

/**
 * Replace the flat price set of a metered model.
 *
 * @returns The rewritten pricing, or undefined when the pricing is not a flat
 * metered price and therefore cannot be edited as a single rate.
 */
export function withFlatPrices(
    pricing: ModelPricing | undefined,
    prices: Omit<PriceSet, "thinkingOutputPrice">,
    currency: string,
): ModelPricing | undefined {
    if (!pricing?.metered) {
        return undefined
    }
    const strategy = pricing.metered.strategy
    if (!strategy?.flat) {
        return undefined
    }
    return {
        metered: {
            ...pricing.metered,
            currency,
            strategy: {
                ...strategy,
                flat: {
                    ...strategy.flat,
                    prices: {
                        ...strategy.flat.prices,
                        inputPrice: prices.inputPrice,
                        outputPrice: prices.outputPrice,
                        cacheWritePrice: prices.cacheWritePrice,
                        cacheReadPrice: prices.cacheReadPrice,
                    },
                },
            },
        },
    }
}

/**
 * Build a flat metered price from per-million rates.
 *
 * Remote catalogs quote one rate per token slot, so a published entry maps
 * straight onto a flat strategy. Cache prices stay absent when the catalog does
 * not publish them, which keeps "not published" distinct from "published as 0".
 *
 * @param inputPrice Per-million input price.
 * @param outputPrice Per-million output price.
 * @param cacheWritePrice Per-million cache-write price, when published.
 * @param cacheReadPrice Per-million cache-read price, when published.
 * @param currency Currency the catalog quotes in.
 * @returns The metered pricing to store on the model.
 */
export function flatMeteredPricing(
    inputPrice: number,
    outputPrice: number,
    cacheWritePrice?: number,
    cacheReadPrice?: number,
    currency = "USD",
): ModelPricing {
    return {
        metered: {
            currency,
            strategy: {
                flat: {
                    prices: { inputPrice, outputPrice, cacheWritePrice, cacheReadPrice },
                },
            },
        },
    }
}

/** A writable price slot. */
export type PriceSlot = "inputPrice" | "outputPrice" | "cacheWritePrice" | "cacheReadPrice"

/**
 * Return pricing with selected flat rates replaced.
 *
 * Remote catalogs publish partial prices and the app corrects individual rates
 * afterwards, so a correction must not have to restate the whole price set.
 * When the pricing is not a flat metered price the value is returned unchanged:
 * a catalog patch has no defined meaning for a schedule or a plan.
 *
 * @param pricing Pricing to patch.
 * @param patches Rates to replace, keyed by slot.
 * @returns Pricing with the patches applied, or the original value.
 */
export function patchFlatPrices(
    pricing: ModelPricing | undefined,
    patches: Partial<Record<PriceSlot, number>>,
): ModelPricing | undefined {
    if (!pricing?.metered?.strategy?.flat) {
        return pricing
    }
    const current = pricing.metered.strategy.flat.prices
    return {
        metered: {
            ...pricing.metered,
            strategy: {
                ...pricing.metered.strategy,
                flat: {
                    ...pricing.metered.strategy.flat,
                    prices: {
                        inputPrice: patches.inputPrice ?? current?.inputPrice ?? 0,
                        outputPrice: patches.outputPrice ?? current?.outputPrice ?? 0,
                        cacheWritePrice: patches.cacheWritePrice ?? current?.cacheWritePrice,
                        cacheReadPrice: patches.cacheReadPrice ?? current?.cacheReadPrice,
                        thinkingOutputPrice: current?.thinkingOutputPrice,
                    },
                },
            },
        },
    }
}

/**
 * Replace the default rate of a time-of-day strategy.
 *
 * The default covers every minute no window covers, so it is one rate set — not
 * a peak/off-peak pair. Editing it creates the strategy when absent, which is
 * the same latitude a profile has when it is the first to publish a schedule.
 *
 * @param pricing Pricing to rewrite.
 * @param prices Per-million rates for instants outside every window.
 * @param currency Currency the rates are quoted in.
 * @returns Pricing carrying the edited default rate.
 */
export function withTimeOfDayDefaultPrices(
    pricing: ModelPricing | undefined,
    prices: Omit<PriceSet, "thinkingOutputPrice">,
    currency: string,
): ModelPricing {
    const metered = pricing?.metered
    const timeOfDay = metered?.strategy?.timeOfDay
    return {
        metered: {
            ...metered,
            currency: metered?.currency ?? currency,
            strategy: {
                ...metered?.strategy,
                timeOfDay: {
                    ...timeOfDay,
                    schedule: timeOfDay?.schedule ?? emptyPricingSchedule(),
                    defaultPrices: declaredPrices(prices),
                    timeWindows: timeOfDay?.timeWindows ?? [],
                },
            },
        },
    }
}

/**
 * Replace the whole window list of a time-of-day strategy.
 *
 * The list is written as given because the editor owns ordering and overlap while
 * the user is typing; billing re-validates overlap before it charges anything.
 * Existing windows are replaced wholesale, which is what an add, remove, or
 * boundary edit amounts to.
 *
 * @param pricing Pricing to rewrite.
 * @param windows Non-overlapping windows, each carrying its own rate.
 * @param currency Currency the rates are quoted in.
 * @returns Pricing carrying the given windows.
 */
export function withTimeWindows(
    pricing: ModelPricing | undefined,
    windows: readonly TimeWindow[],
    currency: string,
): ModelPricing {
    const metered = pricing?.metered
    const timeOfDay = metered?.strategy?.timeOfDay
    return {
        metered: {
            ...metered,
            currency: metered?.currency ?? currency,
            strategy: {
                ...metered?.strategy,
                timeOfDay: {
                    ...timeOfDay,
                    schedule: timeOfDay?.schedule ?? emptyPricingSchedule(),
                    timeWindows: windows.map((window) => ({ ...window })),
                },
            },
        },
    }
}

/**
 * Set the rate shape of one window.
 *
 * A window bills either one price set or its own token bands, never both, so
 * switching the shape drops the other one instead of leaving two rates that
 * billing would reject. The rates already typed carry over to the new shape.
 *
 * @param windows Windows to rewrite.
 * @param index Window to change.
 * @param kind Rate shape that window should carry.
 * @returns Windows with the edited shape, or the originals when the index is out of range.
 */
export function withTimeWindowRateKind(windows: readonly TimeWindow[], index: number, kind: TimeWindowRateKind): TimeWindow[] {
    const window = windows[index]
    if (!window) {
        return [...windows]
    }
    const carried = readPriceSet(window.prices ?? window.bands?.bands?.[0]?.prices)
    const next: TimeWindow =
        kind === "bands"
            ? {
                  startMinute: window.startMinute,
                  endMinute: window.endMinute,
                  bands: window.bands ?? { bands: [{ prices: carried }] },
              }
            : { startMinute: window.startMinute, endMinute: window.endMinute, prices: window.prices ?? carried }
    return windows.map((candidate, candidateIndex) => (candidateIndex === index ? next : candidate))
}

/** Copy the four editable rates of a price set, dropping the thinking-only slot. */
function declaredPrices(prices: Omit<PriceSet, "thinkingOutputPrice">): PriceSet {
    return {
        inputPrice: prices.inputPrice,
        outputPrice: prices.outputPrice,
        cacheWritePrice: prices.cacheWritePrice,
        cacheReadPrice: prices.cacheReadPrice,
    }
}

/** The token bands of a metered model, or an empty list when the price is a flat rate. */
export function readBands(pricing: ModelPricing | undefined): readonly ContextWindowBand[] {
    return pricing?.metered?.strategy?.contextWindow?.bands ?? []
}

/** True when the model bills by request size rather than at a single rate. */
export function hasBands(pricing: ModelPricing | undefined): boolean {
    return readBands(pricing).length > 0
}

/**
 * Replace the token bands of a metered model.
 *
 * A profile may legitimately be the first place bands appear — a reseller can
 * quote token tiers the catalog never published — so a missing structure is
 * created rather than rejected. Rejecting it made "Add Pricing Tier" silently
 * drop the edit for every model the catalog only priced flat.
 *
 * Only the metered mode is rewritten; a plan or a free price has no per-token
 * rate to reshape and is returned unchanged.
 *
 * @returns Pricing using the given bands.
 */
export function withBands(pricing: ModelPricing | undefined, bands: readonly ContextWindowBand[]): ModelPricing | undefined {
    const metered = pricing?.metered
    if (!metered) {
        return undefined
    }
    return {
        metered: {
            ...metered,
            strategy: {
                ...metered.strategy,
                contextWindow: { bands: [...bands] },
            },
        },
    }
}
