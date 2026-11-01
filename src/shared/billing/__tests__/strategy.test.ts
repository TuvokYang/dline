import type { ContextWindowPricing, ModelPricing, PriceSet, PricingSchedule } from "@shared/proto/dline/models/metadata"
import { describe, expect, it } from "vitest"
import { resolvePrices } from "../strategy"
import { BillingConfigurationError, type PricingFacts } from "../types"

const UTC8 = 480

function priceSet(input: number, output: number, cacheRead = 0): PriceSet {
    return { inputPrice: input, outputPrice: output, cacheReadPrice: cacheRead }
}

/** 2026-03-02 is a Monday. 02:00Z is 10:00 in UTC+8, inside the 09:00-12:00 peak window. */
const PEAK_MONDAY = new Date("2026-03-02T02:00:00Z")
/** 2026-03-02T14:00Z is 22:00 in UTC+8, outside both peak windows. */
const OFF_PEAK_MONDAY = new Date("2026-03-02T14:00:00Z")
/** 2026-03-02T06:00Z is 14:00 in UTC+8, inside the 14:00-18:00 peak window. */
const PEAK_AFTERNOON = new Date("2026-03-02T06:00:00Z")
/** 2026-03-02T04:00Z is 12:00 in UTC+8, the exclusive end of the first window. */
const middayGapMonday = () => new Date("2026-03-02T04:00:00Z")
/** 2026-03-07 is a Saturday. 02:00Z is 10:00 in UTC+8. */
const WEEKEND_MORNING = new Date("2026-03-07T02:00:00Z")
/** 2026-10-01 is a Chinese public holiday. 02:00Z is 10:00 in UTC+8. */
const HOLIDAY_MORNING = new Date("2026-10-01T02:00:00Z")

function weekdaySchedule(defaultOnHolidays: boolean, calendar: string): PricingSchedule {
    return {
        timezoneOffsetMinutes: UTC8,
        dayRule: 1,
        defaultOnPublicHolidays: defaultOnHolidays,
        holidayCalendar: calendar,
    }
}

/** The two local peak periods DeepSeek publishes, both billed above the default. */
const PEAK_WINDOWS = [
    { startMinute: 540, endMinute: 720 },
    { startMinute: 840, endMinute: 1080 },
]

const PEAK = 6
const OFF_PEAK = 3

function timeOfDayPricing(schedule: PricingSchedule): ModelPricing {
    return {
        metered: {
            currency: "CNY",
            strategy: {
                timeOfDay: {
                    schedule,
                    defaultPrices: priceSet(OFF_PEAK, OFF_PEAK * 2),
                    timeWindows: PEAK_WINDOWS.map((window) => ({ ...window, prices: priceSet(PEAK, PEAK * 2) })),
                },
            },
        },
    }
}

function expectMeteredInput(pricing: ModelPricing, facts: PricingFacts, expectedInput: number): void {
    const resolved = resolvePrices(pricing, facts)
    expect(resolved.kind).toBe("metered")
    if (resolved.kind === "metered") {
        expect(resolved.prices.inputPrice).toBe(expectedInput)
    }
}

describe("resolvePrices: billing modes", () => {
    it("reports subscription as not billable instead of zero", () => {
        expect(resolvePrices({ subscription: {} }, {})).toEqual({ kind: "not-billable", reason: "subscription" })
    })

    it("reports free as not billable", () => {
        expect(resolvePrices({ free: {} }, {})).toEqual({ kind: "not-billable", reason: "free" })
    })

    it("treats absent pricing as unknown, not free", () => {
        expect(resolvePrices(undefined, {})).toEqual({ kind: "not-billable", reason: "unknown" })
    })

    it("rejects a model that declares both metered and free", () => {
        const pricing: ModelPricing = { metered: { currency: "USD", strategy: { flat: { prices: priceSet(1, 1) } } }, free: {} }
        expect(() => resolvePrices(pricing, {})).toThrow(BillingConfigurationError)
    })

    // A proto round-trip of a model with no published terms produces an empty
    // pricing message. That must read as "nothing to bill", not as corruption,
    // or a model without published prices would fail the response it is used in.
    it("reports an empty pricing message as unbillable rather than corrupt", () => {
        expect(resolvePrices({}, {})).toEqual({ kind: "not-billable", reason: "unknown" })
    })
})

describe("resolvePrices: flat strategy", () => {
    it("resolves the single published price set", () => {
        const pricing: ModelPricing = {
            metered: { currency: "USD", strategy: { flat: { prices: priceSet(3, 15, 0.3) } } },
        }
        const resolved = resolvePrices(pricing, {})
        expect(resolved).toEqual({
            kind: "metered",
            prices: {
                inputPrice: 3,
                outputPrice: 15,
                cacheWritePrice: 0,
                cacheReadPrice: 0.3,
                thinkingOutputPrice: undefined,
                currency: "USD",
            },
        })
    })
})

describe("resolvePrices: context-window strategy", () => {
    const pricing: ModelPricing = {
        metered: {
            currency: "USD",
            strategy: {
                contextWindow: {
                    bands: [{ maxInputTokens: 200_000, prices: priceSet(1, 2) }, { prices: priceSet(4, 8) }],
                },
            },
        },
    }

    it("selects the band whose bound is not exceeded", () => {
        expectMeteredInput(pricing, { totalInputTokens: 199_999 }, 1)
    })

    it("keeps the inclusive bound in the lower band", () => {
        expectMeteredInput(pricing, { totalInputTokens: 200_000 }, 1)
    })

    it("uses the unbounded band above the last bound", () => {
        expectMeteredInput(pricing, { totalInputTokens: 200_001 }, 4)
    })

    it("rejects a lookup without a token count instead of guessing a band", () => {
        expect(() => resolvePrices(pricing, {})).toThrow(BillingConfigurationError)
    })

    it("rejects bands whose highest bound is finite", () => {
        const bounded: ModelPricing = {
            metered: {
                currency: "USD",
                strategy: { contextWindow: { bands: [{ maxInputTokens: 1000, prices: priceSet(1, 1) }] } },
            },
        }
        expect(() => resolvePrices(bounded, { totalInputTokens: 5000 })).toThrow(BillingConfigurationError)
    })
})

describe("resolvePrices: time-of-day strategy", () => {
    const direct = timeOfDayPricing(weekdaySchedule(true, "CN"))
    const gateway = timeOfDayPricing(weekdaySchedule(false, ""))

    it("bills peak inside a peak window", () => {
        expectMeteredInput(direct, { requestedAt: PEAK_MONDAY }, PEAK)
        expectMeteredInput(direct, { requestedAt: PEAK_AFTERNOON }, PEAK)
    })

    it("bills off-peak outside the windows", () => {
        expectMeteredInput(direct, { requestedAt: OFF_PEAK_MONDAY }, OFF_PEAK)
    })

    it("bills off-peak on weekends when the schedule is weekday-only", () => {
        expectMeteredInput(direct, { requestedAt: WEEKEND_MORNING }, OFF_PEAK)
    })

    it("bills off-peak on a public holiday when the schedule excludes holidays", () => {
        expectMeteredInput(direct, { requestedAt: HOLIDAY_MORNING }, OFF_PEAK)
    })

    it("bills the same holiday at peak on a gateway that does not exclude holidays", () => {
        expectMeteredInput(gateway, { requestedAt: HOLIDAY_MORNING }, PEAK)
    })

    it("bills the default rate when the request start is unknown", () => {
        // A window is identified by the instant, so an unknown start cannot be
        // placed in one. The default rate is the only defensible answer once
        // windows carry their own prices; there is no "peak side" to fall back to.
        expectMeteredInput(direct, {}, OFF_PEAK)
    })

    it("combines time with window bands", () => {
        const peakBands: ContextWindowPricing = {
            bands: [{ maxInputTokens: 100_000, prices: priceSet(PEAK, PEAK * 2) }, { prices: priceSet(PEAK * 2, PEAK * 3) }],
        }
        const combined: ModelPricing = {
            metered: {
                currency: "CNY",
                strategy: {
                    timeOfDay: {
                        schedule: weekdaySchedule(true, "CN"),
                        defaultPrices: priceSet(OFF_PEAK, OFF_PEAK * 2),
                        timeWindows: PEAK_WINDOWS.map((window) => ({ ...window, bands: peakBands })),
                    },
                },
            },
        }
        expectMeteredInput(combined, { requestedAt: PEAK_MONDAY, totalInputTokens: 50_000 }, PEAK)
        expectMeteredInput(combined, { requestedAt: PEAK_MONDAY, totalInputTokens: 500_000 }, PEAK * 2)
        expectMeteredInput(combined, { requestedAt: OFF_PEAK_MONDAY, totalInputTokens: 50_000 }, OFF_PEAK)
        expectMeteredInput(combined, { requestedAt: OFF_PEAK_MONDAY, totalInputTokens: 500_000 }, OFF_PEAK)
    })

    it("bills the default rate between two windows instead of a window rate", () => {
        expectMeteredInput(direct, { requestedAt: middayGapMonday() }, OFF_PEAK)
    })

    it("rejects windows that overlap the previous window", () => {
        const overlapping: ModelPricing = {
            metered: {
                currency: "CNY",
                strategy: {
                    timeOfDay: {
                        schedule: weekdaySchedule(true, "CN"),
                        defaultPrices: priceSet(OFF_PEAK, OFF_PEAK),
                        timeWindows: [
                            { startMinute: 540, endMinute: 840, prices: priceSet(PEAK, PEAK) },
                            { startMinute: 600, endMinute: 1080, prices: priceSet(PEAK, PEAK) },
                        ],
                    },
                },
            },
        }
        expect(() => resolvePrices(overlapping, { requestedAt: PEAK_MONDAY })).toThrow(BillingConfigurationError)
    })

    it("rejects a window that declares both a price set and bands", () => {
        const conflicting: ModelPricing = {
            metered: {
                currency: "CNY",
                strategy: {
                    timeOfDay: {
                        schedule: weekdaySchedule(true, "CN"),
                        defaultPrices: priceSet(OFF_PEAK, OFF_PEAK),
                        timeWindows: [
                            {
                                startMinute: 540,
                                endMinute: 720,
                                prices: priceSet(PEAK, PEAK),
                                bands: { bands: [{ prices: priceSet(PEAK, PEAK) }] },
                            },
                        ],
                    },
                },
            },
        }
        expect(() => resolvePrices(conflicting, { requestedAt: PEAK_MONDAY })).toThrow(BillingConfigurationError)
    })

    it("bills the default rate when no window is declared at all", () => {
        const defaultOnly: ModelPricing = {
            metered: {
                currency: "CNY",
                strategy: {
                    timeOfDay: {
                        schedule: weekdaySchedule(true, "CN"),
                        defaultPrices: priceSet(OFF_PEAK, OFF_PEAK),
                        timeWindows: [],
                    },
                },
            },
        }
        expectMeteredInput(defaultOnly, { requestedAt: PEAK_MONDAY }, OFF_PEAK)
    })
})

describe("resolvePrices: strategy cardinality", () => {
    it("rejects a metered model with no strategy", () => {
        expect(() => resolvePrices({ metered: { currency: "USD", strategy: {} } }, {})).toThrow(BillingConfigurationError)
    })

    it("rejects a metered model with two strategies", () => {
        const pricing: ModelPricing = {
            metered: {
                currency: "USD",
                strategy: { flat: { prices: priceSet(1, 1) }, contextWindow: { bands: [{ prices: priceSet(2, 2) }] } },
            },
        }
        expect(() => resolvePrices(pricing, { totalInputTokens: 10 })).toThrow(BillingConfigurationError)
    })
})
