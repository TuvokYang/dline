import type { ModelInfo, ProviderModelsConfig } from "@shared/providers/types"
import { describe, expect, it } from "vitest"
import { reconcileProviderModels } from "../provider-model-reconciliation"

function config(models: Record<string, ModelInfo>): ProviderModelsConfig {
	return {
		provider: "anthropic",
		providerName: "Anthropic",
		billingMode: "token",
		models,
	}
}

interface ImageModelFixture {
	id: string
	name?: string
	userDefined?: boolean
}

interface ImageCatalogConfig extends ProviderModelsConfig {
	defaultImageModelId?: string
	imageModels?: Record<string, ImageModelFixture>
}

describe("thinking metadata reconciliation", () => {
	it.each(["fill-missing", "overlay-remote"] as const)("preserves thinking subfields and explicit overrides in %s", (mode) => {
		const declared = {
			supported: true,
			mode: "effort",
			defaultEnabled: true,
			canDisable: false,
			defaultEffort: "declared-effort",
			effortLevels: ["declared-effort"],
		}
		const updates = { supported: false, defaultEnabled: false, effortLevels: [] }
		const base = config({ "opaque-model": { id: "opaque-model", capabilities: { thinking: declared } } })
		const partial = config({ "opaque-model": { id: "opaque-model", capabilities: { thinking: updates } } })
		const result =
			mode === "fill-missing" ? reconcileProviderModels(base, partial, mode) : reconcileProviderModels(partial, base, mode)

		expect(result.models["opaque-model"].capabilities?.thinking).toEqual({ ...declared, ...updates })
		expect(base.models["opaque-model"].capabilities?.thinking?.defaultEnabled).toBe(true)
	})
})

describe("provider image model reconciliation", () => {
	it("refreshes built-in image models while preserving unknown user image models", () => {
		const seed: ImageCatalogConfig = {
			provider: "openai",
			providerName: "OpenAI",
			billingMode: "token",
			defaultModelId: "gpt-chat",
			models: { "gpt-chat": { id: "gpt-chat" } },
			defaultImageModelId: "gpt-image-2",
			imageModels: {
				"gpt-image-2": { id: "gpt-image-2", name: "GPT Image 2" },
			},
		}
		const stored: ImageCatalogConfig = {
			provider: "openai",
			providerName: "OpenAI",
			billingMode: "token",
			defaultModelId: "gpt-chat",
			models: { "gpt-chat": { id: "gpt-chat" } },
			imageModels: {
				"gpt-image-2": { id: "gpt-image-2", name: "Stale image model" },
				"private-image": { id: "private-image", name: "Private Image" },
			},
		}

		const result = reconcileProviderModels(seed, stored, "refresh-built-ins") as ImageCatalogConfig

		expect(result.defaultImageModelId).toBe("gpt-image-2")
		expect(result.imageModels?.["gpt-image-2"]).toMatchObject({
			name: "GPT Image 2",
			userDefined: false,
		})
		expect(result.imageModels?.["private-image"]).toMatchObject({
			name: "Private Image",
			userDefined: true,
		})
	})
})

describe("reconcileProviderModels overlay-remote", () => {
	it("keeps stored pricing when the vendor listing omits it", () => {
		const stored = config({
			"claude-fable-5-1": {
				id: "claude-fable-5-1",
				name: "claude-fable-5-1",
				capabilities: { maxTokens: 128_000, contextWindow: 1_000_000 },
				pricing: { inputPrice: 10, outputPrice: 50, cacheReadsPrice: 0.25 },
			},
		})
		const remote = config({
			"claude-fable-5-1": {
				id: "claude-fable-5-1",
				name: "claude-fable-5-1",
				capabilities: { maxTokens: 128_000, contextWindow: 1_000_000, supportsImages: true },
			},
		})

		const merged = reconcileProviderModels(remote, stored, "overlay-remote")

		expect(merged.models["claude-fable-5-1"].pricing).toEqual({
			inputPrice: 10,
			outputPrice: 50,
			cacheReadsPrice: 0.25,
		})
		expect(merged.models["claude-fable-5-1"].capabilities?.supportsImages).toBe(true)
	})

	it("does not erase stored fields that the vendor reports as undefined", () => {
		const stored = config({
			"model-a": {
				id: "model-a",
				name: "model-a",
				description: "local description",
				capabilities: { contextWindow: 200_000, supportsPromptCache: true },
			},
		})
		const remote = config({
			"model-a": {
				id: "model-a",
				name: "model-a",
				description: undefined,
				capabilities: { contextWindow: 300_000, supportsPromptCache: undefined },
			},
		})

		const merged = reconcileProviderModels(remote, stored, "overlay-remote")

		expect(merged.models["model-a"].description).toBe("local description")
		expect(merged.models["model-a"].capabilities?.contextWindow).toBe(300_000)
		expect(merged.models["model-a"].capabilities?.supportsPromptCache).toBe(true)
	})

	it("adds vendor-only models and keeps models the vendor no longer lists", () => {
		const stored = config({
			"retired-model": { id: "retired-model", name: "retired-model", pricing: { inputPrice: 3 } },
		})
		const remote = config({
			"new-model": { id: "new-model", name: "new-model" },
		})

		const merged = reconcileProviderModels(remote, stored, "overlay-remote")

		expect(Object.keys(merged.models).sort()).toEqual(["new-model", "retired-model"])
		expect(merged.models["new-model"].userDefined).toBe(false)
		expect(merged.models["retired-model"].pricing?.inputPrice).toBe(3)
	})

	it("never overwrites a user-defined model", () => {
		const stored = config({
			"model-a": {
				id: "model-a",
				name: "custom name",
				userDefined: true,
				pricing: { inputPrice: 1 },
			},
		})
		const remote = config({
			"model-a": { id: "model-a", name: "vendor name", pricing: { inputPrice: 99 } },
		})

		const merged = reconcileProviderModels(remote, stored, "overlay-remote")

		expect(merged.models["model-a"].name).toBe("custom name")
		expect(merged.models["model-a"].pricing?.inputPrice).toBe(1)
		expect(merged.models["model-a"].userDefined).toBe(true)
	})
})

describe("reconcileProviderModels refresh-built-ins", () => {
	it("removes retired built-ins while preserving explicit and legacy user models", () => {
		const stored = config({
			"retired-built-in": { id: "retired-built-in", name: "Retired", userDefined: false },
			"explicit-user": { id: "explicit-user", name: "Explicit", userDefined: true },
			"legacy-user": { id: "legacy-user", name: "Legacy" },
		})
		const seed = config({
			"current-model": { id: "current-model", name: "Current" },
		})

		const merged = reconcileProviderModels(seed, stored, "refresh-built-ins")

		expect(Object.keys(merged.models).sort()).toEqual(["current-model", "explicit-user", "legacy-user"])
		expect(merged.models["explicit-user"].userDefined).toBe(true)
		expect(merged.models["legacy-user"].userDefined).toBe(true)
	})
})

describe("reconcileProviderModels replace", () => {
	it("drops stored models so that vendor-derived catalogs stay authoritative", () => {
		const stored = config({
			"retired-model": { id: "retired-model", name: "retired-model" },
		})
		const remote = config({
			"new-model": { id: "new-model", name: "new-model" },
		})

		const merged = reconcileProviderModels(remote, stored, "replace")

		expect(Object.keys(merged.models)).toEqual(["new-model"])
	})
})
