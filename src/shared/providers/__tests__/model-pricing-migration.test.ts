import type { ModelPricing } from "@shared/proto/dline/models/metadata"
import { PricingDayRule, ModelPricing as PricingMessage } from "@shared/proto/dline/models/metadata"
import { flatMeteredPricing, migrateModelPricing } from "@shared/providers/pricing-shape"
import { describe, expect, it } from "vitest"

const strategy: NonNullable<ModelPricing["strategy"]> = {
    timeOfDay: {
        schedule: {
            timezoneOffsetMinutes: 480,
            dayRule: PricingDayRule.PRICING_DAY_RULE_WEEKDAYS,
            defaultOnPublicHolidays: true,
            holidayCalendar: "CN",
        },
        defaultBands: {
            bands: [
                { maxInputTokens: 100, prices: { inputPrice: 1, outputPrice: 2, cacheReadPrice: 0 } },
                { prices: { inputPrice: 3, outputPrice: 4 } },
            ],
        },
        timeWindows: [{ startMinute: 540, endMinute: 720, prices: { inputPrice: 5, outputPrice: 6 } }],
    },
}

const current: ModelPricing = { currency: "CNY", strategy }

describe("read-once ModelPricing migration", () => {
    it("expands a legacy envelope without losing nested rates or optional zero prices", () => {
        const legacy: ModelPricing = { metered: { currency: "CNY", strategy } }
        const before = structuredClone(legacy)
        expect(migrateModelPricing(legacy)).toEqual(current)
        expect(legacy).toEqual(before)
    })

    it("gives canonical fields precedence and removes every deprecated field", () => {
        const mixed: ModelPricing = {
            ...current,
            metered: { currency: "USD", strategy: { flat: { prices: { inputPrice: 99, outputPrice: 99 } } } },
            subscription: {},
            free: {},
        }
        expect(migrateModelPricing(mixed)).toEqual(current)
    })

    it("does not replace an explicitly invalid new declaration with a valid legacy price", () => {
        expect(migrateModelPricing({ currency: "", metered: { currency: "USD", strategy } })).toEqual({
            currency: "",
            strategy: undefined,
        })
    })

    it("keeps missing prices unknown instead of inventing rates from account-mode markers", () => {
        for (const input of [undefined, {}, { subscription: {} }, { free: {} }]) {
            expect(migrateModelPricing(input)).toBeUndefined()
        }
    })

    it("writes only canonical fields after decoding old JSON and remains idempotent", () => {
        const decoded = PricingMessage.fromJSON({ metered: { currency: "CNY", strategy } })
        const migrated = migrateModelPricing(decoded)
        expect(migrated).toEqual(current)
        expect(migrateModelPricing(migrated)).toEqual(current)
        const stored = PricingMessage.toJSON(migrated!)
        expect(stored).toMatchObject({
            currency: "CNY",
            strategy: {
                timeOfDay: {
                    defaultBands: {
                        bands: [
                            { maxInputTokens: 100, prices: { inputPrice: 1, outputPrice: 2, cacheReadPrice: 0 } },
                            { prices: { inputPrice: 3, outputPrice: 4 } },
                        ],
                    },
                },
            },
        })
        expect(stored).not.toHaveProperty("metered")
        expect(stored).not.toHaveProperty("subscription")
        expect(stored).not.toHaveProperty("free")
    })

    it("constructs a genuine zero price in the same canonical structure", () => {
        expect(flatMeteredPricing(0, 0, undefined, 0, "EUR")).toEqual({
            currency: "EUR",
            strategy: {
                flat: {
                    prices: {
                        inputPrice: 0,
                        outputPrice: 0,
                        cacheWritePrice: undefined,
                        cacheReadPrice: 0,
                    },
                },
            },
        })
    })
})
