import type { ModelTier } from "@shared/proto/dline/models"
import type { ContextWindowBand, ModelPricing, PriceSet } from "@shared/proto/dline/models/metadata"
import { flatMeteredPricing, readPriceSet } from "@shared/providers/pricing-shape"

/**
 * Compatibility projections between the published pricing shape and the legacy
 * flat scalar fields still present on provider model-info messages.
 *
 * `ModelInfo.model_info` carries the complete pricing mode and is what current
 * clients read. Older projections declare a single rate plus a list of tiers, so
 * the two must be derived from the same source instead of restated at each call
 * site. Deriving them here keeps the compatibility surface in one place and lets
 * the published shape evolve without editing every converter.
 */

/** The legacy scalar fields a message declares alongside its pricing. */
export interface LegacyPricingFields {
    inputPrice?: number
    outputPrice?: number
    cacheWritesPrice?: number
    cacheReadsPrice?: number
    tiers: ModelTier[]
}

function pricesOfTier(tier: ModelTier): PriceSet {
    return {
        inputPrice: tier.inputPrice ?? 0,
        outputPrice: tier.outputPrice ?? 0,
        cacheWritePrice: tier.cacheWritesPrice,
        cacheReadPrice: tier.cacheReadsPrice,
    }
}

function bandOfTier(tier: ModelTier, maxInputTokens: number | undefined): ContextWindowBand {
    return { maxInputTokens, prices: pricesOfTier(tier) }
}

/**
 * Project the published pricing onto the legacy scalar and tier fields.
 *
 * A flat rate projects onto the four scalars. A banded rate projects its lowest
 * band onto the scalars and its remaining bands onto tiers, which is how the
 * legacy shape expressed "a base rate plus a rate that starts at a token count".
 * Modes the legacy shape cannot express project onto no price at all, because an
 * old consumer reading a subscription as a per-token rate would be misled about
 * a cost it is not being charged.
 *
 * @param pricing The model's published billing terms.
 * @returns The legacy fields to declare, all absent when the mode is not metered.
 */
export function projectLegacyPricing(pricing: ModelPricing | undefined): Partial<LegacyPricingFields> {
    const strategy = pricing?.metered?.strategy
    if (strategy?.flat) {
        const prices = readPriceSet(strategy.flat.prices)
        return {
            inputPrice: prices.inputPrice,
            outputPrice: prices.outputPrice,
            cacheWritesPrice: prices.cacheWritePrice || undefined,
            cacheReadsPrice: prices.cacheReadPrice || undefined,
            tiers: [],
        }
    }
    const bands = strategy?.contextWindow?.bands
    if (!bands || bands.length === 0) {
        return { tiers: [] }
    }
    const [lowest, ...higher] = bands
    const lowestPrices = readPriceSet(lowest.prices)
    return {
        inputPrice: lowestPrices.inputPrice,
        outputPrice: lowestPrices.outputPrice,
        cacheWritesPrice: lowestPrices.cacheWritePrice || undefined,
        cacheReadsPrice: lowestPrices.cacheReadPrice || undefined,
        tiers: higher.map((band) => ({
            contextWindow: band.maxInputTokens ?? Number.MAX_SAFE_INTEGER,
            inputPrice: band.prices?.inputPrice,
            outputPrice: band.prices?.outputPrice,
            cacheWritesPrice: band.prices?.cacheWritePrice,
            cacheReadsPrice: band.prices?.cacheReadPrice,
        })),
    }
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
    const currency = "USD"
    if (fields.tiers.length > 0) {
        const declaredAsScalars =
            fields.inputPrice === undefined || fields.outputPrice === undefined
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
            metered: {
                currency,
                strategy: { contextWindow: { bands: [...declaredAsScalars, ...declaredAsTiers] } },
            },
        }
    }
    if (fields.inputPrice === undefined || fields.outputPrice === undefined) {
        return undefined
    }
    return flatMeteredPricing(fields.inputPrice, fields.outputPrice, fields.cacheWritesPrice, fields.cacheReadsPrice, currency)
}
