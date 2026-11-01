import type { ContextWindowBand, ModelPricing, TimeWindow } from "@shared/proto/dline/models/metadata"
import { describe, expect, it } from "vitest"
import {
    flatMeteredPricing,
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
        metered: {
            currency: "USD",
            strategy: {
                timeOfDay: {
                    schedule: {
                        timezoneOffsetMinutes: 480,
                        dayRule: 1,
                        defaultOnPublicHolidays: false,
                        holidayCalendar: "",
                    },
                    defaultPrices: { inputPrice: 1, outputPrice: 4 },
                    timeWindows: [{ startMinute: 60, endMinute: 180, prices: { inputPrice: 2, outputPrice: 8 } }],
                },
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
            metered: {
                currency: "USD",
                strategy: { contextWindow: { bands: [{ prices: RATES }] } },
            },
        }
        expect(readPricingShape(pricing)).toBe("contextWindow")
    })

    it("defaults to a flat rate when the pricing declares no strategy", () => {
        expect(readPricingShape(undefined)).toBe("flat")
    })
})

describe("withPricingShape", () => {
    it("creates a schedule with an empty window list and a default rate", () => {
        const shaped = withPricingShape(flatMeteredPricing(3, 15), "timeOfDay", "USD")
        const timeOfDay = shaped?.metered?.strategy?.timeOfDay
        expect(timeOfDay?.defaultPrices?.inputPrice).toBe(3)
        expect(timeOfDay?.defaultPrices?.outputPrice).toBe(15)
        expect(timeOfDay?.timeWindows).toEqual([])
    })

    it("carries the default rate when switching away and back", () => {
        const flat = withPricingShape(timeOfDayPricing(), "flat", "USD")
        expect(flat?.metered?.strategy?.flat?.prices?.inputPrice).toBe(1)
        const back = withPricingShape(flat, "timeOfDay", "USD")
        expect(back?.metered?.strategy?.timeOfDay?.defaultPrices?.inputPrice).toBe(1)
    })
})

describe("withTimeOfDayDefaultPrices", () => {
    it("patches one default slot and leaves the windows untouched", () => {
        const next = withTimeOfDayDefaultPrices(timeOfDayPricing(), { ...{ inputPrice: 1, outputPrice: 9 } }, "USD")
        const timeOfDay = next.metered?.strategy?.timeOfDay
        expect(timeOfDay?.defaultPrices?.outputPrice).toBe(9)
        expect(timeOfDay?.timeWindows).toHaveLength(1)
        expect(timeOfDay?.timeWindows[0].prices?.inputPrice).toBe(2)
    })

    it("creates the strategy when the profile has no pricing yet", () => {
        const next = withTimeOfDayDefaultPrices(undefined, RATES, "EUR")
        const timeOfDay = next.metered?.strategy?.timeOfDay
        expect(next.metered?.currency).toBe("EUR")
        expect(timeOfDay?.defaultPrices?.inputPrice).toBe(2)
        expect(timeOfDay?.timeWindows).toEqual([])
    })
})

describe("withTimeWindows", () => {
    it("writes the given window list in the order supplied", () => {
        const windows: TimeWindow[] = [
            { startMinute: 0, endMinute: 60, prices: { inputPrice: 1, outputPrice: 2 } },
            { startMinute: 600, endMinute: 660, prices: { inputPrice: 3, outputPrice: 6 } },
        ]
        const next = withTimeWindows(timeOfDayPricing(), windows, "USD")
        expect(next.metered?.strategy?.timeOfDay?.timeWindows.map((window) => window.startMinute)).toEqual([0, 600])
    })

    it("keeps the default rate when only the windows change", () => {
        const next = withTimeWindows(timeOfDayPricing(), [], "USD")
        expect(next.metered?.strategy?.timeOfDay?.defaultPrices?.inputPrice).toBe(1)
        expect(next.metered?.strategy?.timeOfDay?.timeWindows).toEqual([])
    })
})

describe("withTimeWindowRateKind", () => {
    it("carries the single rate into the first band when switching to bands", () => {
        const windows: TimeWindow[] = [{ startMinute: 60, endMinute: 180, prices: RATES }]
        const next = withTimeWindowRateKind(windows, 0, "bands")
        expect(next[0].prices).toBeUndefined()
        expect(next[0].bands?.bands[0].prices?.inputPrice).toBe(2)
    })

    it("drops the bands when switching back to a single rate", () => {
        const bands: ContextWindowBand[] = [{ maxInputTokens: 1000, prices: RATES }]
        const windows: TimeWindow[] = [{ startMinute: 60, endMinute: 180, bands: { bands } }]
        const next = withTimeWindowRateKind(windows, 0, "prices")
        expect(next[0].bands).toBeUndefined()
        expect(next[0].prices?.outputPrice).toBe(8)
    })

    it("leaves the list unchanged for an index outside it", () => {
        const windows: TimeWindow[] = [{ startMinute: 60, endMinute: 180, prices: RATES }]
        expect(withTimeWindowRateKind(windows, 3, "bands")).toEqual(windows)
    })
})

describe("readTimeWindowRate", () => {
    it("reports the shape the window actually stores", () => {
        expect(readTimeWindowRate({ startMinute: 0, endMinute: 60, prices: RATES })).toBe("prices")
        expect(readTimeWindowRate({ startMinute: 0, endMinute: 60, bands: { bands: [{ prices: RATES }] } })).toBe("bands")
    })
})
