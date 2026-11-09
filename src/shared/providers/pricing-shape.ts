import {
    type ContextWindowBand,
    type ModelPricing,
    type PriceSet,
    PricingDayRule,
    type PricingSchedule,
    type PricingTimeWindow,
} from "@shared/proto/dline/models/metadata"

/** Configuration-only readers and immutable edits; no rate selection or money arithmetic. */
export type PricingShapeKind = "flat" | "contextWindow" | "timeOfDay"
export type TimeWindowRateKind = "prices" | "bands"
export type PriceSlot = "inputPrice" | "outputPrice" | "cacheWritePrice" | "cacheReadPrice"

/** Project only current fields for writers; never interpret a deprecated envelope. */
export function modelPricingForWrite(pricing: ModelPricing | undefined): ModelPricing | undefined {
    if (!pricing || (pricing.currency === undefined && pricing.strategy === undefined)) return undefined
    return { currency: pricing.currency, strategy: pricing.strategy }
}

/** Consume deprecated fields at read boundaries. Current fields always win and only current fields survive. */
export function migrateModelPricing(pricing: ModelPricing | undefined): ModelPricing | undefined {
    if (!pricing) return undefined
    if (pricing.currency !== undefined || pricing.strategy !== undefined) {
        return { currency: pricing.currency, strategy: pricing.strategy }
    }
    if (pricing.metered) {
        return { currency: pricing.metered.currency, strategy: pricing.metered.strategy }
    }
    // The retired account-mode markers contain neither rates nor a currency.
    return undefined
}

export function emptyPricingSchedule(): PricingSchedule {
    return {
        timezoneOffsetMinutes: 0,
        dayRule: PricingDayRule.PRICING_DAY_RULE_ALL_DAYS,
        defaultOnPublicHolidays: false,
        holidayCalendar: "",
    }
}

export function readTimeWindowRate(window: PricingTimeWindow | undefined): TimeWindowRateKind {
    return window?.bands ? "bands" : "prices"
}

export function readPricingShape(pricing: ModelPricing | undefined): PricingShapeKind {
    if (pricing?.strategy?.contextWindow) return "contextWindow"
    if (pricing?.strategy?.timeOfDay) return "timeOfDay"
    return "flat"
}

/** Preserve declared rates while changing only the editor's selected strategy. */
export function withPricingShape(pricing: ModelPricing | undefined, kind: PricingShapeKind, currency: string): ModelPricing {
    const current = pricing?.strategy
    const carried =
        current?.flat?.prices ??
        current?.contextWindow?.bands?.[0]?.prices ??
        current?.timeOfDay?.defaultPrices ??
        current?.timeOfDay?.defaultBands?.bands?.[0]?.prices ??
        current?.timeOfDay?.timeWindows?.[0]?.prices ??
        {}
    const prices: PriceSet = { ...carried }
    const strategy =
        kind === "flat"
            ? { flat: current?.flat ?? { prices } }
            : kind === "contextWindow"
              ? { contextWindow: current?.contextWindow ?? { bands: [{ prices }] } }
              : { timeOfDay: current?.timeOfDay ?? { schedule: emptyPricingSchedule(), defaultPrices: prices, timeWindows: [] } }
    return { currency, strategy }
}

/** Numeric projection for existing scalar consumers; it does not alter declaration presence. */
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

export function readCurrency(pricing: ModelPricing | undefined): string | undefined {
    return pricing?.currency
}

export function withFlatPrices(
    pricing: ModelPricing | undefined,
    prices: Omit<PriceSet, "thinkingOutputPrice">,
    currency: string,
): ModelPricing | undefined {
    const flat = pricing?.strategy?.flat
    if (!flat) return undefined
    return { currency, strategy: { flat: { prices: { ...flat.prices, ...prices } } } }
}

/** Construct one declaration from per-million rates; absent optional prices stay absent. */
export function flatMeteredPricing(
    inputPrice: number | undefined,
    outputPrice: number | undefined,
    cacheWritePrice?: number,
    cacheReadPrice?: number,
    currency = "USD",
): ModelPricing {
    return { currency, strategy: { flat: { prices: { inputPrice, outputPrice, cacheWritePrice, cacheReadPrice } } } }
}

export function patchFlatPrices(
    pricing: ModelPricing | undefined,
    patches: Partial<Record<PriceSlot, number>>,
): ModelPricing | undefined {
    if (!pricing?.strategy?.flat) return pricing
    const current = pricing.strategy.flat.prices
    return {
        currency: pricing.currency,
        strategy: {
            flat: {
                prices: {
                    inputPrice: patches.inputPrice ?? current?.inputPrice,
                    outputPrice: patches.outputPrice ?? current?.outputPrice,
                    cacheWritePrice: patches.cacheWritePrice ?? current?.cacheWritePrice,
                    cacheReadPrice: patches.cacheReadPrice ?? current?.cacheReadPrice,
                    thinkingOutputPrice: current?.thinkingOutputPrice,
                },
            },
        },
    }
}

export function withTimeOfDayDefaultPrices(pricing: ModelPricing | undefined, prices: PriceSet, currency: string): ModelPricing {
    const timeOfDay = pricing?.strategy?.timeOfDay
    return {
        currency: pricing?.currency ?? currency,
        strategy: {
            timeOfDay: {
                ...timeOfDay,
                schedule: timeOfDay?.schedule ?? emptyPricingSchedule(),
                defaultBands: undefined,
                defaultPrices: { ...prices },
                timeWindows: timeOfDay?.timeWindows ?? [],
            },
        },
    }
}

export function withTimeWindows(
    pricing: ModelPricing | undefined,
    windows: readonly PricingTimeWindow[],
    currency: string,
): ModelPricing {
    const timeOfDay = pricing?.strategy?.timeOfDay
    const defaultRate = timeOfDay
        ? { defaultPrices: timeOfDay.defaultPrices, defaultBands: timeOfDay.defaultBands }
        : pricing?.strategy?.contextWindow
          ? { defaultBands: pricing.strategy.contextWindow }
          : { defaultPrices: pricing?.strategy?.flat?.prices ?? {} }
    return {
        currency: pricing?.currency ?? currency,
        strategy: {
            timeOfDay: {
                ...timeOfDay,
                ...defaultRate,
                schedule: timeOfDay?.schedule ?? emptyPricingSchedule(),
                timeWindows: windows.map((window) => ({ ...window })),
            },
        },
    }
}

export function withTimeWindowRateKind(
    windows: readonly PricingTimeWindow[],
    index: number,
    kind: TimeWindowRateKind,
): PricingTimeWindow[] {
    const window = windows[index]
    if (!window) return [...windows]
    const carried = window.prices ?? window.bands?.bands?.[0]?.prices ?? {}
    const next: PricingTimeWindow =
        kind === "bands"
            ? {
                  startMinute: window.startMinute,
                  endMinute: window.endMinute,
                  bands: window.bands ?? { bands: [{ prices: carried }] },
              }
            : { startMinute: window.startMinute, endMinute: window.endMinute, prices: window.prices ?? carried }
    return windows.map((candidate, candidateIndex) => (candidateIndex === index ? next : candidate))
}

export function readBands(pricing: ModelPricing | undefined): readonly ContextWindowBand[] {
    return pricing?.strategy?.contextWindow?.bands ?? []
}

export function hasBands(pricing: ModelPricing | undefined): boolean {
    return readBands(pricing).length > 0
}

export function withBands(pricing: ModelPricing | undefined, bands: readonly ContextWindowBand[]): ModelPricing | undefined {
    if (!pricing) return undefined
    return { currency: pricing.currency, strategy: { contextWindow: { bands: [...bands] } } }
}
