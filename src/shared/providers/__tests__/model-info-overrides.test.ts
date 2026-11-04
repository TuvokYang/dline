import type { ModelInfo } from "@shared/proto/dline/models"
import { type ModelPricing, PricingDayRule } from "@shared/proto/dline/models/metadata"
import { describe, expect, it } from "vitest"
import { getModelInfoOverrideFields, mergeModelInfo, pickModelInfoOverride } from "../model-info-overrides"

const base: ModelInfo = {
    id: "model",
    pricing: {
        currency: "USD",
        strategy: {
            flat: {
                prices: { inputPrice: 1, outputPrice: 2, cacheReadPrice: 0.1 },
            },
        },
    },
}
const fields = getModelInfoOverrideFields("openai")

describe("complete model pricing overrides", () => {
    it.each<ModelPricing>([
        {
            currency: "CNY",
            strategy: {
                contextWindow: {
                    bands: [
                        { maxInputTokens: 100, prices: { inputPrice: 3, outputPrice: 4 } },
                        { prices: { inputPrice: 5, outputPrice: 6 } },
                    ],
                },
            },
        },
        {
            currency: "CNY",
            strategy: {
                timeOfDay: {
                    schedule: {
                        timezoneOffsetMinutes: 480,
                        dayRule: PricingDayRule.PRICING_DAY_RULE_ALL_DAYS,
                        defaultOnPublicHolidays: false,
                        holidayCalendar: "",
                    },
                    defaultPrices: { inputPrice: 3, outputPrice: 4 },
                    timeWindows: [{ startMinute: 540, endMinute: 720, prices: { inputPrice: 7, outputPrice: 8 } }],
                },
            },
        },
    ])("keeps the complete strategy through override selection and merge", (pricing) => {
        const override = pickModelInfoOverride({ id: "model", pricing }, base, fields)
        expect(override?.pricing).toEqual(pricing)
        expect(mergeModelInfo(base, override)?.pricing).toEqual(pricing)
        expect(override?.pricing?.strategy?.flat).toBeUndefined()
    })

    it("preserves optional rates and explicit zero without filling them from the catalog", () => {
        const pricing: ModelPricing = {
            currency: "CNY",
            strategy: {
                flat: {
                    prices: { inputPrice: 0, outputPrice: 4, thinkingOutputPrice: 9 },
                },
            },
        }
        const override = pickModelInfoOverride({ id: "model", pricing }, base, fields)
        expect(override?.pricing).toEqual(pricing)
        expect(override?.pricing?.strategy?.flat?.prices?.cacheReadPrice).toBeUndefined()
        expect(base.pricing?.strategy?.flat?.prices?.cacheReadPrice).toBe(0.1)
    })

    it("leaves absent or unchanged pricing inherited", () => {
        expect(pickModelInfoOverride({ id: "model" }, base, fields)).toBeUndefined()
        expect(pickModelInfoOverride(structuredClone(base), base, fields)).toBeUndefined()
    })
})
