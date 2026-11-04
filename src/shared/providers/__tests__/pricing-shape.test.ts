import type { ContextWindowBand, ModelPricing, PricingTimeWindow } from "@shared/proto/dline/models/metadata"
import { describe, expect, it } from "vitest"
import {
    flatMeteredPricing,
    patchFlatPrices,
    readPricingShape,
    readTimeWindowRate,
    withPricingShape,
    withTimeOfDayDefaultPrices,
    withTimeWindowRateKind,
    withTimeWindows,
} from "../pricing-shape"

const RATES = { inputPrice: 2, outputPrice: 8 }

/** A price list that already prices one window over a default rate. */
function timeOfDayPricing(): ModelPricing {
    return {
        currency: "USD",
        strategy: {
            timeOfDay: {
                schedule: { timezoneOffsetMinutes: 480, dayRule: 1, defaultOnPublicHolidays: false, holidayCalendar: "" },
                defaultPrices: { inputPrice: 1, outputPrice: 4 },
                timeWindows: [{ startMinute: 60, endMinute: 180, prices: { inputPrice: 2, outputPrice: 8 } }],
            },
        },
    }
}

describe("readPricingShape", () => {
    it("reports the time-of-day strategy a profile stores", () => {
        expect(readPricingShape(timeOfDayPricing())).toBe("timeOfDay")
    })

    it("reports a context-window strategy before a flat one", () => {
        const pricing: ModelPricing = {
            currency: "USD",
            strategy: { contextWindow: { bands: [{ prices: RATES }] } },
        }
        expect(readPricingShape(pricing)).toBe("contextWindow")
    })

    it("defaults to a flat rate when the pricing declares no strategy", () => {
        expect(readPricingShape(undefined)).toBe("flat")
    })
})

describe("withPricingShape", () => {
    it("carries absence through structural edits instead of declaring free prices", () => {
        const flat = withPricingShape(undefined, "flat", "USD")
        const banded = withPricingShape(flat, "contextWindow", "USD")
        const timed = withTimeWindows(banded, [], "USD")
        const windows = withTimeWindowRateKind([{ startMinute: 0, endMinute: 60 }], 0, "bands")
        expect(flat.strategy?.flat?.prices).toEqual({})
        expect(banded.strategy?.contextWindow?.bands[0].prices).toEqual({})
        expect(timed.strategy?.timeOfDay?.defaultBands?.bands[0].prices).toEqual({})
        expect(windows[0].bands?.bands[0].prices).toEqual({})
    })

    it("patches a declared slot without filling other missing slots", () => {
        const patched = patchFlatPrices(flatMeteredPricing(undefined, 0), { cacheReadPrice: 0 })
        expect(patched?.strategy?.flat?.prices?.inputPrice).toBeUndefined()
        expect(patched?.strategy?.flat?.prices?.outputPrice).toBe(0)
        expect(patched?.strategy?.flat?.prices?.cacheReadPrice).toBe(0)
    })

    it("creates a schedule with an empty window list and a default rate", () => {
        const shaped = withPricingShape(flatMeteredPricing(3, 15), "timeOfDay", "USD")
        const timeOfDay = shaped?.strategy?.timeOfDay
        expect(timeOfDay?.defaultPrices?.inputPrice).toBe(3)
        expect(timeOfDay?.defaultPrices?.outputPrice).toBe(15)
        expect(timeOfDay?.timeWindows).toEqual([])
    })

    it("carries the default rate when switching away and back", () => {
        const flat = withPricingShape(timeOfDayPricing(), "flat", "USD")
        expect(flat?.strategy?.flat?.prices?.inputPrice).toBe(1)
        const back = withPricingShape(flat, "timeOfDay", "USD")
        expect(back?.strategy?.timeOfDay?.defaultPrices?.inputPrice).toBe(1)
    })
})

describe("withTimeOfDayDefaultPrices", () => {
    it("patches one default slot and leaves the windows untouched", () => {
        const next = withTimeOfDayDefaultPrices(timeOfDayPricing(), { ...{ inputPrice: 1, outputPrice: 9 } }, "USD")
        const timeOfDay = next.strategy?.timeOfDay
        expect(timeOfDay?.defaultPrices?.outputPrice).toBe(9)
        expect(timeOfDay?.timeWindows).toHaveLength(1)
        expect(timeOfDay?.timeWindows[0].prices?.inputPrice).toBe(2)
    })

    it("creates the strategy when the profile has no pricing yet", () => {
        const next = withTimeOfDayDefaultPrices(undefined, RATES, "EUR")
        const timeOfDay = next.strategy?.timeOfDay
        expect(next.currency).toBe("EUR")
        expect(timeOfDay?.defaultPrices?.inputPrice).toBe(2)
        expect(timeOfDay?.timeWindows).toEqual([])
    })
})

describe("withTimeWindows", () => {
    it("writes the given window list in the order supplied", () => {
        const windows: PricingTimeWindow[] = [
            { startMinute: 0, endMinute: 60, prices: { inputPrice: 1, outputPrice: 2 } },
            { startMinute: 600, endMinute: 660, prices: { inputPrice: 3, outputPrice: 6 } },
        ]
        const next = withTimeWindows(timeOfDayPricing(), windows, "USD")
        expect(next.strategy?.timeOfDay?.timeWindows.map((window) => window.startMinute)).toEqual([0, 600])
    })

    it("keeps the default rate when only the windows change", () => {
        const next = withTimeWindows(timeOfDayPricing(), [], "USD")
        expect(next.strategy?.timeOfDay?.defaultPrices?.inputPrice).toBe(1)
        expect(next.strategy?.timeOfDay?.timeWindows).toEqual([])
    })
})

describe("withTimeWindowRateKind", () => {
    it("carries the single rate into the first band when switching to bands", () => {
        const windows: PricingTimeWindow[] = [{ startMinute: 60, endMinute: 180, prices: RATES }]
        const next = withTimeWindowRateKind(windows, 0, "bands")
        expect(next[0].prices).toBeUndefined()
        expect(next[0].bands?.bands[0].prices?.inputPrice).toBe(2)
    })

    it("drops the bands when switching back to a single rate", () => {
        const bands: ContextWindowBand[] = [{ maxInputTokens: 1000, prices: RATES }]
        const windows: PricingTimeWindow[] = [{ startMinute: 60, endMinute: 180, bands: { bands } }]
        const next = withTimeWindowRateKind(windows, 0, "prices")
        expect(next[0].bands).toBeUndefined()
        expect(next[0].prices?.outputPrice).toBe(8)
    })

    it("leaves the list unchanged for an index outside it", () => {
        const windows: PricingTimeWindow[] = [{ startMinute: 60, endMinute: 180, prices: RATES }]
        expect(withTimeWindowRateKind(windows, 3, "bands")).toEqual(windows)
    })
})

describe("readTimeWindowRate", () => {
    it("reports the shape the window actually stores", () => {
        expect(readTimeWindowRate({ startMinute: 0, endMinute: 60, prices: RATES })).toBe("prices")
        expect(readTimeWindowRate({ startMinute: 0, endMinute: 60, bands: { bands: [{ prices: RATES }] } })).toBe("bands")
    })
})
