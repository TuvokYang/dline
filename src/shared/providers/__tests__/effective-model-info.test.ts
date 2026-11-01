import type { ModelInfo } from "@shared/proto/dline/models"
import type { ModelCapabilities } from "@shared/proto/dline/models/metadata"
import { flatMeteredPricing, readBands, readCurrency, readPriceSet } from "@shared/providers/pricing-shape"
import should from "should"
import { describe, it } from "vitest"
import { buildEffectiveModelInfo } from "../effective-model-info"

/** Banded rates are listed lowest-first and the last band is unbounded. */
function bandedPricing(bands: { maxInputTokens?: number; inputPrice: number; outputPrice: number }[]) {
    return {
        metered: {
            currency: "USD",
            strategy: {
                contextWindow: {
                    bands: bands.map((band) => ({
                        maxInputTokens: band.maxInputTokens,
                        prices: { inputPrice: band.inputPrice, outputPrice: band.outputPrice },
                    })),
                },
            },
        },
    }
}

describe("buildEffectiveModelInfo", () => {
    it("merges partial thinking overrides without losing declarations or reviving false and empty values", () => {
        const declared = {
            supported: true,
            mode: "effort",
            defaultEnabled: true,
            canDisable: false,
            defaultEffort: "declared-effort",
            effortLevels: ["declared-effort"],
            minBudget: 17,
        }
        const updates = { supported: false, defaultEnabled: false, effortLevels: [], minBudget: 0 }
        const result = buildEffectiveModelInfo(
            "opaque-model",
            { id: "opaque-model", capabilities: { thinking: declared } },
            { capabilities: { thinking: updates } },
        )

        should(result.capabilities?.thinking).deepEqual({ ...declared, ...updates })
        declared.defaultEnabled.should.equal(true)
        declared.effortLevels.should.deepEqual(["declared-effort"])
    })

    it("should merge provider capability and pricing overrides into a registry model", () => {
        const registryModel: ModelInfo = {
            id: "registry-model",
            name: "Registry Model",
            capabilities: {
                maxTokens: 4096,
                contextWindow: 128_000,
                supportsImages: false,
                supportsPromptCache: false,
            } as ModelCapabilities,
            pricing: flatMeteredPricing(1, 2),
        }

        const result = buildEffectiveModelInfo("registry-model", registryModel, {
            capabilities: {
                maxTokens: 64_000,
                supportsImages: true,
                temperature: 0.7,
            } as unknown as ModelCapabilities,
            pricing: flatMeteredPricing(0.5, 2, undefined, 0.05),
        })

        result.id.should.equal("registry-model")
        should(result.name).equal("Registry Model")
        should(result.capabilities?.contextWindow).equal(128_000)
        should(result.capabilities?.maxTokens).equal(64_000)
        should(result.capabilities?.supportsImages).equal(true)
        should(result.capabilities?.temperature).equal(0.7)
        should(readPriceSet(result.pricing?.metered?.strategy?.flat?.prices).inputPrice).equal(0.5)
        should(readPriceSet(result.pricing?.metered?.strategy?.flat?.prices).outputPrice).equal(2)
        should(readPriceSet(result.pricing?.metered?.strategy?.flat?.prices).cacheReadPrice).equal(0.05)
        should(readCurrency(result.pricing)).equal("USD")
    })

    it("should preserve an explicit context window over inherited context tiers", () => {
        const registryModel: ModelInfo = {
            id: "gpt-tiered-model",
            capabilities: {
                contextWindow: 272_000,
                contextWindowTiers: [
                    { id: "standard", contextWindow: 272_000, label: "272K" },
                    { id: "long", contextWindow: 1_050_000, label: "1.05M" },
                ],
            } as ModelCapabilities,
        }

        const result = buildEffectiveModelInfo("gpt-tiered-model", registryModel, {
            capabilities: { contextWindow: 333_000 } as ModelCapabilities,
        })

        should(result.capabilities?.contextWindow).equal(333_000)
    })

    it("should switch to the long context tier when enableLongContext is on", () => {
        const registryModel: ModelInfo = {
            id: "claude-sonnet-tiered",
            capabilities: {
                contextWindow: 200_000,
                contextWindowTiers: [
                    { id: "standard", contextWindow: 200_000, label: "200K" },
                    { id: "long", contextWindow: 1_000_000, label: "1M", apiModelSuffix: ":1m" },
                ],
            } as ModelCapabilities,
        }

        const result = buildEffectiveModelInfo("claude-sonnet-tiered", registryModel, { enableLongContext: true })

        should(result.capabilities?.contextWindow).equal(1_000_000)
    })

    it("should keep the standard context tier when long context is not enabled", () => {
        const registryModel: ModelInfo = {
            id: "claude-sonnet-tiered",
            capabilities: {
                contextWindow: 200_000,
                contextWindowTiers: [
                    { id: "standard", contextWindow: 200_000, label: "200K" },
                    { id: "long", contextWindow: 1_000_000, label: "1M", apiModelSuffix: ":1m" },
                ],
            } as ModelCapabilities,
        }

        const result = buildEffectiveModelInfo("claude-sonnet-tiered", registryModel, {})

        should(result.capabilities?.contextWindow).equal(200_000)
    })

    it("should replace token bands when the profile enables band editing", () => {
        const registryModel: ModelInfo = {
            id: "tiered-pricing-model",
            pricing: bandedPricing([
                { maxInputTokens: 128_000, inputPrice: 1, outputPrice: 2 },
                { inputPrice: 3, outputPrice: 4 },
            ]),
        }

        const result = buildEffectiveModelInfo("tiered-pricing-model", registryModel, {
            pricing: bandedPricing([
                { maxInputTokens: 64_000, inputPrice: 7, outputPrice: 8 },
                { inputPrice: 9, outputPrice: 10 },
            ]),
            pricingTiersEnabled: true,
        })

        should(readBands(result.pricing).map((band) => band.maxInputTokens)).deepEqual([64_000, undefined])
        should(readPriceSet(readBands(result.pricing)[0].prices).inputPrice).equal(7)
        should(readPriceSet(readBands(result.pricing)[1].prices).outputPrice).equal(10)
    })

    it("should keep the registry band shape when band editing is disabled", () => {
        const registryModel: ModelInfo = {
            id: "tiered-pricing-model",
            pricing: bandedPricing([{ inputPrice: 1, outputPrice: 2 }]),
        }

        const result = buildEffectiveModelInfo("tiered-pricing-model", registryModel, {
            pricing: bandedPricing([{ inputPrice: 7, outputPrice: 8 }]),
            pricingTiersEnabled: false,
        })

        should(readBands(result.pricing).length).equal(1)
        should(readPriceSet(readBands(result.pricing)[0].prices).inputPrice).equal(1)
    })

    it("should not turn a subscription plan into a per-token rate", () => {
        const registryModel: ModelInfo = {
            id: "plan-model",
            pricing: { subscription: {} },
        }

        const result = buildEffectiveModelInfo("plan-model", registryModel, {
            pricing: flatMeteredPricing(1, 2),
        })

        should(result.pricing?.subscription).be.ok()
        should(result.pricing?.metered).be.undefined()
    })

    it("should compose model info from provider overrides when model id is empty", () => {
        const result = buildEffectiveModelInfo(undefined, undefined, {
            capabilities: {
                contextWindow: 32_000,
                supportsPromptCache: true,
                temperature: 0.2,
            } as unknown as ModelCapabilities,
            pricing: flatMeteredPricing(0.1, 0.2),
        })

        result.id.should.equal("")
        should(result.capabilities?.contextWindow).equal(32_000)
        should(result.capabilities?.supportsPromptCache).equal(true)
        should(result.capabilities?.temperature).equal(0.2)
        should(readPriceSet(result.pricing?.metered?.strategy?.flat?.prices).inputPrice).equal(0.1)
        should(readPriceSet(result.pricing?.metered?.strategy?.flat?.prices).outputPrice).equal(0.2)
    })

    it("should use the explicit model id when registry metadata is missing", () => {
        const result = buildEffectiveModelInfo("custom-model", undefined, {
            capabilities: {
                maxTokens: 8192,
            } as ModelCapabilities,
        })

        result.id.should.equal("custom-model")
        should(result.capabilities?.maxTokens).equal(8192)
        should(result.pricing).be.undefined()
    })
})
