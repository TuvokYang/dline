import type { ModelTier } from "@shared/proto/dline/models"
import type { ContextWindowBand, ModelPricing, PriceSet } from "@shared/proto/dline/models/metadata"
import { flatMeteredPricing } from "@shared/providers/pricing-shape"

/**
 * Decode-only compatibility for deprecated scalar and tier fields.
 * Current producers write the complete ModelInfo.pricing declaration, never a
 * reverse projection into these fields.
 */

/** The legacy scalar fields a message declares alongside its pricing. */
export interface LegacyPricingFields {
    currency?: string
    inputPrice?: number
    outputPrice?: number
    cacheWritesPrice?: number
    cacheReadsPrice?: number
    tiers: ModelTier[]
}

function pricesOfTier(tier: ModelTier): PriceSet {
    return {
        inputPrice: tier.inputPrice,
        outputPrice: tier.outputPrice,
        cacheWritePrice: tier.cacheWritesPrice,
        cacheReadPrice: tier.cacheReadsPrice,
    }
}

function bandOfTier(tier: ModelTier, maxInputTokens: number | undefined): ContextWindowBand {
    return { maxInputTokens, prices: pricesOfTier(tier) }
}

/**
 * Rebuild the published pricing from a legacy-only message.
 *
 * The legacy tier list records the token count where a rate starts, and the last
 * tier applies above every count, so the rebuilt bands keep that meaning. When
 * the message also declares scalars, they cover requests below the first tier.
 *
 * @param fields Legacy fields read from the message.
 * @returns The pricing to store, or undefined when the message declares no rate.
 */
export function pricingFromLegacyFields(fields: LegacyPricingFields): ModelPricing | undefined {
    const currency = fields.currency ?? "USD"
    if (fields.tiers.length > 0) {
        const declaredAsScalars =
            fields.inputPrice === undefined && fields.outputPrice === undefined
                ? []
                : [
                      {
                          maxInputTokens: fields.tiers[0].contextWindow,
                          prices: {
                              inputPrice: fields.inputPrice,
                              outputPrice: fields.outputPrice,
                              cacheWritePrice: fields.cacheWritesPrice,
                              cacheReadPrice: fields.cacheReadsPrice,
                          },
                      },
                  ]
        const declaredAsTiers = fields.tiers.map((tier, index) =>
            bandOfTier(tier, index === fields.tiers.length - 1 ? undefined : fields.tiers[index + 1].contextWindow),
        )
        return {
            currency,
            strategy: { contextWindow: { bands: [...declaredAsScalars, ...declaredAsTiers] } },
        }
    }
    if (fields.inputPrice === undefined && fields.outputPrice === undefined) {
        return undefined
    }
    return flatMeteredPricing(fields.inputPrice, fields.outputPrice, fields.cacheWritesPrice, fields.cacheReadsPrice, currency)
}
