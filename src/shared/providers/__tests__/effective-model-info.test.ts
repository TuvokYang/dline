import type { ModelInfo } from "@shared/proto/dline/models"
import type { ModelCapabilities, ModelPricing } from "@shared/proto/dline/models/metadata"
import should from "should"
import { describe, it } from "vitest"
import { buildEffectiveModelInfo } from "../effective-model-info"

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
			pricing: {
				inputPrice: 1,
				outputPrice: 2,
				currency: "USD",
			} as ModelPricing,
		}

		const result = buildEffectiveModelInfo("registry-model", registryModel, {
			capabilities: {
				maxTokens: 64_000,
				supportsImages: true,
				temperature: 0.7,
			} as unknown as ModelCapabilities,
			pricing: {
				inputPrice: 0.5,
				cacheReadsPrice: 0.05,
			} as ModelPricing,
		})

		result.id.should.equal("registry-model")
		result.name?.should.equal("Registry Model")
		result.capabilities?.contextWindow?.should.equal(128_000)
		result.capabilities?.maxTokens?.should.equal(64_000)
		result.capabilities?.supportsImages?.should.equal(true)
		;(result.capabilities as unknown as { temperature?: number }).temperature?.should.equal(0.7)
		result.pricing?.inputPrice?.should.equal(0.5)
		result.pricing?.outputPrice?.should.equal(2)
		result.pricing?.cacheReadsPrice?.should.equal(0.05)
		result.pricing?.currency?.should.equal("USD")
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

		result.capabilities?.contextWindow?.should.equal(333_000)
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

		result.capabilities?.contextWindow?.should.equal(1_000_000)
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

		result.capabilities?.contextWindow?.should.equal(200_000)
	})

	it("should preserve an explicitly empty pricing tier override", () => {
		const registryModel: ModelInfo = {
			id: "tiered-pricing-model",
			pricing: {
				inputPrice: 1,
				outputPrice: 2,
				tiers: [{ contextWindow: 128_000, inputPrice: 3, outputPrice: 4 }],
			} as ModelPricing,
		}

		const result = buildEffectiveModelInfo("tiered-pricing-model", registryModel, {
			pricing: { tiers: [] } as unknown as ModelPricing,
			pricingTiersEnabled: true,
		})

		should(result.pricing?.tiers).deepEqual([])
		result.pricing?.inputPrice?.should.equal(1)
		result.pricing?.outputPrice?.should.equal(2)
	})

	it("should compose model info from provider overrides when model id is empty", () => {
		const result = buildEffectiveModelInfo(undefined, undefined, {
			capabilities: {
				contextWindow: 32_000,
				supportsPromptCache: true,
				temperature: 0.2,
			} as unknown as ModelCapabilities,
			pricing: {
				inputPrice: 0.1,
				outputPrice: 0.2,
			} as ModelPricing,
		})

		result.id.should.equal("")
		result.capabilities?.contextWindow?.should.equal(32_000)
		result.capabilities?.supportsPromptCache?.should.equal(true)
		;(result.capabilities as unknown as { temperature?: number }).temperature?.should.equal(0.2)
		result.pricing?.inputPrice?.should.equal(0.1)
		result.pricing?.outputPrice?.should.equal(0.2)
	})

	it("should use the explicit model id when registry metadata is missing", () => {
		const result = buildEffectiveModelInfo("custom-model", undefined, {
			capabilities: {
				maxTokens: 8192,
			} as ModelCapabilities,
		})

		result.id.should.equal("custom-model")
		result.capabilities?.maxTokens?.should.equal(8192)
		should(result.pricing).be.undefined()
	})
})
