import { ApiHandler } from "@core/api/ApiHandler"
import type { ModelInfo } from "@shared/proto/dline/models"
import { type ModelPricing, PricingDayRule } from "@shared/proto/dline/models/metadata"
import { buildEffectiveModelInfo, mergePricing } from "@shared/providers/effective-model-info"
import {
    flatMeteredPricing,
    withBands,
    withPricingShape,
    withTimeOfDayDefaultPrices,
    withTimeWindows,
} from "@shared/providers/pricing-shape"
import { describe, expect, it } from "vitest"
import { validateModelPricing } from "../index"

const { calculateUsageCost } = ApiHandler

const base: ModelInfo = { id: "test", pricing: flatMeteredPricing(1, 2) }
const timePricing = (): ModelPricing => ({
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
})

describe("model-owned pricing declarations", () => {
    it("replaces a flat declaration with complete context pricing rather than manufacturing flat zeros", () => {
        const pricing: ModelPricing = {
            currency: "USD",
            strategy: {
                contextWindow: {
                    bands: [{ prices: { inputPrice: 5, outputPrice: 9 } }],
                },
            },
        }
        const info = buildEffectiveModelInfo("test", base, { pricing })
        expect(info.pricing).toEqual(pricing)
        expect(calculateUsageCost(info.pricing, { inputTokens: 1_000_000, outputTokens: 0 }, 0)).toEqual({
            kind: "calculated",
            amount: 5,
            currency: "USD",
        })
    })

    it("applies a full time declaration to both display metadata and billing", () => {
        const pricing = timePricing()
        const info = buildEffectiveModelInfo("test", base, { pricing })
        expect(info.pricing).toEqual(pricing)
        expect(
            calculateUsageCost(info.pricing, { inputTokens: 1_000_000, outputTokens: 0 }, Date.parse("2026-11-03T01:00:00Z")),
        ).toEqual({ kind: "calculated", amount: 7, currency: "CNY" })
        expect(buildEffectiveModelInfo("test", base, {}).pricing).toEqual(base.pricing)
    })

    it("inherits missing or zero prices only while no explicit Profile pricing exists", () => {
        for (const pricing of [undefined, flatMeteredPricing(0, 0)]) {
            expect(buildEffectiveModelInfo("test", { ...base, pricing }, {}).pricing).toEqual(pricing)
            const effective = buildEffectiveModelInfo("test", { ...base, pricing }, { pricing: flatMeteredPricing(5, 9) })
            expect(calculateUsageCost(effective.pricing, { inputTokens: 1_000_000, outputTokens: 0 }, 0)).toEqual({
                kind: "calculated",
                amount: 5,
                currency: "USD",
            })
        }
    })

    it("replaces strategy branches rather than shallow-merging oneofs", () => {
        expect(mergePricing(base.pricing, timePricing())).toEqual(timePricing())
    })

    it("creates a valid unbounded context declaration without inventing optional rates", () => {
        const pricing = withPricingShape(base.pricing, "contextWindow", "USD")!
        expect(validateModelPricing(pricing)).toEqual([])
        expect(pricing.strategy!.contextWindow!.bands).toEqual([{ prices: { inputPrice: 1, outputPrice: 2 } }])
    })

    it("replaces a strategy instead of retaining a flat sibling", () => {
        const pricing = withBands(base.pricing, [{ prices: { inputPrice: 3, outputPrice: 4 } }])!
        expect(validateModelPricing(pricing)).toEqual([])
        expect(calculateUsageCost(pricing, { inputTokens: 1_000_000, outputTokens: 0 }, 0)).toEqual({
            kind: "calculated",
            amount: 3,
            currency: "USD",
        })
    })

    it("preserves default rates when creating time windows from a flat declaration", () => {
        const pricing = withTimeWindows(base.pricing, [], "USD")
        expect(validateModelPricing(pricing)).toEqual([])
        expect(calculateUsageCost(pricing, { inputTokens: 1_000_000, outputTokens: 0 }, 0)).toEqual({
            kind: "calculated",
            amount: 1,
            currency: "USD",
        })
    })

    it("replaces default bands with explicit prices without leaving both rate shapes", () => {
        const source = timePricing()
        const time = source.strategy!.timeOfDay!
        delete time.defaultPrices
        time.defaultBands = { bands: [{ prices: { inputPrice: 1, outputPrice: 2 } }] }
        const pricing = withTimeOfDayDefaultPrices(source, { inputPrice: 3, outputPrice: 4 }, "CNY")
        expect(validateModelPricing(pricing)).toEqual([])
        expect(pricing.strategy!.timeOfDay!.timeWindows).toEqual(time.timeWindows)
    })
})
