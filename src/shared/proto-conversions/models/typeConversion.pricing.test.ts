import { ModelInfo, OpenRouterModelInfo } from "@shared/proto/dline/models"
import { ModelPricing, PricingDayRule } from "@shared/proto/dline/models/metadata"
import { describe, expect, it } from "vitest"
import { fromProtobufModelInfo, toProtobufModelInfo } from "./typeConversion"

const pricing: ModelPricing = {
    currency: "CNY",
    strategy: {
        timeOfDay: {
            schedule: {
                timezoneOffsetMinutes: 480,
                dayRule: PricingDayRule.PRICING_DAY_RULE_ALL_DAYS,
                defaultOnPublicHolidays: false,
                holidayCalendar: "",
            },
            defaultPrices: { inputPrice: 0, outputPrice: 2, cacheReadPrice: 0 },
            timeWindows: [
                {
                    startMinute: 60,
                    endMinute: 120,
                    bands: {
                        bands: [
                            { maxInputTokens: 100, prices: { inputPrice: 3, outputPrice: 4 } },
                            { prices: { inputPrice: 5, outputPrice: 6, cacheWritePrice: 0 } },
                        ],
                    },
                },
            ],
        },
    },
}
const json = (value: ModelPricing | undefined) => value && ModelPricing.toJSON(value)

describe("model RPC pricing read compatibility and current-only writes", () => {
    it("round-trips complete time/context prices through JSON and binary without legacy projections", () => {
        const wire = toProtobufModelInfo(ModelInfo.create({ id: "test", pricing }))
        expect(wire.inputPrice).toBeUndefined()
        expect(wire.outputPrice).toBeUndefined()
        expect(wire.currency).toBeUndefined()
        expect(wire.tiers).toEqual([])
        const binary = OpenRouterModelInfo.decode(OpenRouterModelInfo.encode(wire).finish())
        const restored = fromProtobufModelInfo(OpenRouterModelInfo.fromJSON(OpenRouterModelInfo.toJSON(binary)))
        expect(json(restored.pricing)).toEqual(json(pricing))
        expect(restored.pricing?.strategy?.timeOfDay?.defaultPrices?.cacheReadPrice).toBe(0)
        expect(restored.pricing?.strategy?.timeOfDay?.defaultPrices?.cacheWritePrice).toBeUndefined()
    })

    it("consumes a legacy envelope on read then writes only current fields", () => {
        const old = OpenRouterModelInfo.create({
            modelInfo: {
                id: "test",
                pricing: {
                    metered: { currency: "CNY", strategy: pricing.strategy },
                },
            },
        })
        const model = fromProtobufModelInfo(old)
        expect(json(model.pricing)).toEqual(json(pricing))
        expect(toProtobufModelInfo(model).modelInfo?.pricing?.metered).toBeUndefined()
    })

    it("prefers an explicit complete ModelInfo over obsolete scalar projections", () => {
        const model = fromProtobufModelInfo(
            OpenRouterModelInfo.create({
                modelInfo: { id: "test", pricing },
                inputPrice: 99,
                outputPrice: 99,
                currency: "USD",
            }),
        )
        expect(json(model.pricing)).toEqual(json(pricing))
    })

    it("reads legacy-only scalars without dropping currency or optional zeros", () => {
        const model = fromProtobufModelInfo(
            OpenRouterModelInfo.create({
                inputPrice: 1,
                outputPrice: 2,
                cacheReadsPrice: 0,
                currency: "CNY",
            }),
        )
        expect(model.pricing).toEqual({
            currency: "CNY",
            strategy: {
                flat: {
                    prices: {
                        inputPrice: 1,
                        outputPrice: 2,
                        cacheReadPrice: 0,
                        cacheWritePrice: undefined,
                    },
                },
            },
        })
        expect(toProtobufModelInfo(model).cacheReadsPrice).toBeUndefined()
    })

    it.each([
        "inputPrice",
        "outputPrice",
    ])("preserves explicit zero and an absent opposite slot for %s through JSON and binary", (slot) => {
        const model = ModelInfo.fromJSON({
            id: "partial",
            pricing: { currency: "CNY", strategy: { flat: { prices: { [slot]: 0 } } } },
        })
        const wire = toProtobufModelInfo(model)
        const restored = fromProtobufModelInfo(OpenRouterModelInfo.decode(OpenRouterModelInfo.encode(wire).finish()))
        const prices = restored.pricing?.strategy?.flat?.prices
        expect(prices?.[slot as "inputPrice" | "outputPrice"]).toBe(0)
        expect(prices?.[slot === "inputPrice" ? "outputPrice" : "inputPrice"]).toBeUndefined()
        const jsonModel = ModelInfo.fromJSON(ModelInfo.toJSON(restored))
        expect(jsonModel.pricing?.strategy?.flat?.prices?.[slot === "inputPrice" ? "outputPrice" : "inputPrice"]).toBeUndefined()
    })

    it("does not perform read migration inside the current-only writer", () => {
        const wire = toProtobufModelInfo(
            ModelInfo.create({
                id: "test",
                pricing: {
                    metered: { currency: "CNY", strategy: pricing.strategy },
                },
            }),
        )
        expect(wire.modelInfo?.pricing).toBeUndefined()
        expect(wire.currency).toBeUndefined()
    })
})
