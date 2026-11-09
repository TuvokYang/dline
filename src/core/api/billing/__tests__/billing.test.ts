import { ApiHandler } from "@core/api/ApiHandler"
import { type ModelPricing, type PriceSet, PricingDayRule } from "@shared/proto/dline/models/metadata"
import { describe, expect, it } from "vitest"
import { validateModelPricing } from "../index"

const { calculateUsageCost } = ApiHandler
const flat = (prices: PriceSet): ModelPricing => ({ currency: "CNY", strategy: { flat: { prices } } })
const instant = Date.parse("2026-11-03T01:00:00Z")
const zeroUsage = { inputTokens: 0, outputTokens: 0 }
const flash = (): ModelPricing => ({
    currency: "CNY",
    strategy: {
        timeOfDay: {
            schedule: {
                timezoneOffsetMinutes: 480,
                dayRule: PricingDayRule.PRICING_DAY_RULE_WEEKDAYS,
                defaultOnPublicHolidays: true,
                holidayCalendar: "CN",
            },
            defaultPrices: { inputPrice: 1, outputPrice: 4, cacheReadPrice: 0.02 },
            timeWindows: [
                { startMinute: 540, endMinute: 720, prices: { inputPrice: 2, outputPrice: 8, cacheReadPrice: 0.04 } },
                { startMinute: 840, endMinute: 1080, prices: { inputPrice: 2, outputPrice: 8, cacheReadPrice: 0.04 } },
            ],
        },
    },
})

describe("ApiHandler one-send billing", () => {
    it("prices disjoint input slots and splits inclusive output exactly once", () => {
        const result = calculateUsageCost(
            flat({ inputPrice: 2, outputPrice: 4, cacheWritePrice: 3, cacheReadPrice: 0.5, thinkingOutputPrice: 10 }),
            { inputTokens: 60, outputTokens: 50, cacheWriteTokens: 10, cacheReadTokens: 20, thoughtsTokenCount: 30 },
            instant,
        )
        expect(result.kind).toBe("calculated")
        if (result.kind !== "calculated") throw new Error("Expected a calculated result")
        expect(result.amount).toBeCloseTo(0.00054, 12)
        expect(result.currency).toBe("CNY")
    })

    it("bills all inclusive output at output price when thinking has no separate rate", () => {
        expect(
            calculateUsageCost(
                flat({ inputPrice: 0, outputPrice: 4 }),
                {
                    inputTokens: 0,
                    outputTokens: 50,
                    thoughtsTokenCount: 30,
                },
                instant,
            ),
        ).toEqual({ kind: "calculated", amount: 0.0002, currency: "CNY" })
    })

    it.each([
        [99, 0.000099],
        [100, 0.0001],
        [101, 0.00101],
    ])("selects one whole-send band at %i total input", (total, amount) => {
        const pricing: ModelPricing = {
            currency: "CNY",
            strategy: {
                contextWindow: {
                    bands: [
                        { maxInputTokens: 100, prices: { inputPrice: 1, outputPrice: 0, cacheReadPrice: 1 } },
                        { prices: { inputPrice: 10, outputPrice: 0, cacheReadPrice: 10 } },
                    ],
                },
            },
        }
        const result = calculateUsageCost(pricing, { inputTokens: total - 40, cacheReadTokens: 40, outputTokens: 0 }, instant)
        expect(result.kind).toBe("calculated")
        if (result.kind !== "calculated") throw new Error("Expected a calculated result")
        expect(result.amount).toBeCloseTo(amount, 12)
    })

    it.each([
        ["2026-11-03T00:59:59Z", 5],
        ["2026-11-03T01:00:00Z", 10],
        ["2026-11-03T03:59:59Z", 10],
        ["2026-11-03T04:00:00Z", 5],
        ["2026-11-03T06:00:00Z", 10],
        ["2026-11-03T10:00:00Z", 5],
        ["2026-11-07T01:00:00Z", 5],
        ["2026-02-23T01:00:00Z", 5],
    ])("uses the supplied seller-time instant %s", (sentAt, amount) => {
        expect(calculateUsageCost(flash(), { inputTokens: 1_000_000, outputTokens: 1_000_000 }, Date.parse(sentAt))).toEqual({
            kind: "calculated",
            amount,
            currency: "CNY",
        })
    })

    it("selects token bands inside the selected time window", () => {
        const pricing = flash()
        const window = pricing.strategy!.timeOfDay!.timeWindows[0]
        delete window.prices
        window.bands = {
            bands: [
                { maxInputTokens: 100, prices: { inputPrice: 2, outputPrice: 0 } },
                { prices: { inputPrice: 7, outputPrice: 0 } },
            ],
        }
        expect(calculateUsageCost(pricing, { inputTokens: 101, outputTokens: 0 }, instant)).toEqual({
            kind: "calculated",
            amount: 0.000707,
            currency: "CNY",
        })
    })

    it("keeps declared zero, missing pricing and incomplete pricing distinct", () => {
        expect(calculateUsageCost(flat({ inputPrice: 0, outputPrice: 0 }), zeroUsage, instant)).toEqual({
            kind: "calculated",
            amount: 0,
            currency: "CNY",
        })
        expect(calculateUsageCost(undefined, zeroUsage, instant)).toEqual({ kind: "unavailable" })
        expect(calculateUsageCost({}, zeroUsage, instant).kind).toBe("invalid")
        // Retired account markers must not suppress a current declaration's amount.
        for (const marker of [{ subscription: {} }, { free: {} }]) {
            expect(
                calculateUsageCost(
                    { ...flat({ inputPrice: 2, outputPrice: 0 }), ...marker },
                    {
                        inputTokens: 1_000_000,
                        outputTokens: 0,
                    },
                    instant,
                ),
            ).toEqual({ kind: "calculated", amount: 2, currency: "CNY" })
        }
    })

    it("does not mutate configuration or depend on previous calls", () => {
        const pricing = flash()
        const before = structuredClone(pricing)
        const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
        const first = calculateUsageCost(pricing, usage, instant)
        calculateUsageCost(pricing, usage, Date.parse("2026-11-03T04:00:00Z"))
        expect(calculateUsageCost(pricing, usage, instant)).toEqual(first)
        expect(pricing).toEqual(before)
    })

    it("rejects an invalid supplied clock rather than choosing the default rate", () => {
        expect(calculateUsageCost(flash(), zeroUsage, Number.NaN).kind).toBe("invalid")
    })

    it("rejects invalid usage and overflow rather than returning a plausible amount", () => {
        for (const inputTokens of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
            expect(
                calculateUsageCost(flat({ inputPrice: 2, outputPrice: 3 }), { inputTokens, outputTokens: 0 }, instant).kind,
            ).toBe("invalid")
        }
        expect(
            calculateUsageCost(
                flat({ inputPrice: 2, outputPrice: 3 }),
                {
                    inputTokens: 1,
                    outputTokens: 2,
                    thoughtsTokenCount: 3,
                },
                instant,
            ).kind,
        ).toBe("invalid")
        expect(
            calculateUsageCost(
                flat({ inputPrice: Number.MAX_VALUE, outputPrice: 0 }),
                {
                    inputTokens: 2,
                    outputTokens: 0,
                },
                instant,
            ).kind,
        ).toBe("invalid")
    })

    it("validates an unselected branch", () => {
        const pricing = flash()
        pricing.strategy!.timeOfDay!.timeWindows[1].prices!.inputPrice = -1
        expect(validateModelPricing(pricing).length).toBeGreaterThan(0)
        expect(calculateUsageCost(pricing, zeroUsage, instant).kind).toBe("invalid")
    })

    it("rejects multiple strategies, overlapping/empty windows and finite final bands", () => {
        const both = flat({ inputPrice: 1, outputPrice: 1 })
        both.strategy!.contextWindow = { bands: [{ prices: { inputPrice: 1, outputPrice: 1 } }] }
        expect(validateModelPricing(both).length).toBeGreaterThan(0)
        for (const bounds of [
            [600, 800],
            [1440, 1440],
        ]) {
            const pricing = flash()
            pricing.strategy!.timeOfDay!.timeWindows.push({
                startMinute: bounds[0],
                endMinute: bounds[1],
                prices: { inputPrice: 1, outputPrice: 1 },
            })
            expect(validateModelPricing(pricing).length).toBeGreaterThan(0)
        }
        expect(
            validateModelPricing({
                currency: "CNY",
                strategy: {
                    contextWindow: { bands: [{ maxInputTokens: 100, prices: { inputPrice: 1, outputPrice: 1 } }] },
                },
            }).length,
        ).toBeGreaterThan(0)
    })

    it("uses declared all-days and holiday rules rather than viewer workdays", () => {
        const pricing = flash()
        const schedule = pricing.strategy!.timeOfDay!.schedule!
        schedule.dayRule = PricingDayRule.PRICING_DAY_RULE_ALL_DAYS
        expect(
            calculateUsageCost(pricing, { inputTokens: 1_000_000, outputTokens: 1_000_000 }, Date.parse("2026-11-07T01:00:00Z")),
        ).toEqual({ kind: "calculated", amount: 10, currency: "CNY" })
        schedule.defaultOnPublicHolidays = false
        expect(
            calculateUsageCost(pricing, { inputTokens: 1_000_000, outputTokens: 1_000_000 }, Date.parse("2026-02-23T01:00:00Z")),
        ).toEqual({ kind: "calculated", amount: 10, currency: "CNY" })
    })

    it("does not guess a holiday outside calendar coverage or for an unknown calendar", () => {
        const pricing = flash()
        expect(calculateUsageCost(pricing, zeroUsage, Date.parse("2027-01-04T01:00:00Z")).kind).toBe("invalid")
        pricing.strategy!.timeOfDay!.schedule!.holidayCalendar = "unknown"
        expect(calculateUsageCost(pricing, zeroUsage, instant).kind).toBe("invalid")
    })

    it("selects default bands when there is no window", () => {
        const pricing = flash()
        const time = pricing.strategy!.timeOfDay!
        delete time.defaultPrices
        time.defaultBands = {
            bands: [
                { maxInputTokens: 100, prices: { inputPrice: 1, outputPrice: 0 } },
                { prices: { inputPrice: 6, outputPrice: 0 } },
            ],
        }
        time.timeWindows = []
        expect(calculateUsageCost(pricing, { inputTokens: 101, outputTokens: 0 }, instant)).toEqual({
            kind: "calculated",
            amount: 0.000606,
            currency: "CNY",
        })
    })

    it("handles seller-local midnight independently of the UTC date", () => {
        const pricing = flash()
        pricing.strategy!.timeOfDay!.timeWindows = [{ startMinute: 0, endMinute: 60, prices: { inputPrice: 3, outputPrice: 0 } }]
        expect(
            calculateUsageCost(pricing, { inputTokens: 1_000_000, outputTokens: 0 }, Date.parse("2026-11-02T16:00:00Z")),
        ).toEqual({ kind: "calculated", amount: 3, currency: "CNY" })
    })

    it("diagnoses an offset exceeding the supported Date range", () => {
        expect(calculateUsageCost(flash(), zeroUsage, 8_640_000_000_000_000).kind).toBe("invalid")
    })
})
