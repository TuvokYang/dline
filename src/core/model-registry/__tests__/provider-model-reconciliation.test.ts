import { flatMeteredPricing } from "@shared/providers/pricing-shape"
import type { ModelInfo, ProviderModelsConfig } from "@shared/providers/types"
import { describe, expect, it } from "vitest"
import { reconcileProviderModels } from "../provider-model-reconciliation"

/** The input rate, which is what the stored-versus-vendor cases compare. */
function inputPriceOf(model: ModelInfo | undefined): number | undefined {
    return model?.pricing?.strategy?.flat?.prices?.inputPrice
}

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
            minBudget: 17,
        }
        const updates = { supported: false, defaultEnabled: false, effortLevels: [], minBudget: 0 }
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
                pricing: flatMeteredPricing(10, 50, undefined, 0.25),
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

        expect(merged.models["claude-fable-5-1"].pricing).toEqual(flatMeteredPricing(10, 50, undefined, 0.25))
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
            "retired-model": { id: "retired-model", name: "retired-model", pricing: flatMeteredPricing(3, 0) },
        })
        const remote = config({
            "new-model": { id: "new-model", name: "new-model" },
        })

        const merged = reconcileProviderModels(remote, stored, "overlay-remote")

        expect(Object.keys(merged.models).sort()).toEqual(["new-model", "retired-model"])
        expect(merged.models["new-model"].userDefined).toBe(false)
        expect(inputPriceOf(merged.models["retired-model"])).toBe(3)
    })

    it("never overwrites a user-defined model", () => {
        const stored = config({
            "model-a": {
                id: "model-a",
                name: "custom name",
                userDefined: true,
                pricing: flatMeteredPricing(1, 0),
            },
        })
        const remote = config({
            "model-a": { id: "model-a", name: "vendor name", pricing: flatMeteredPricing(99, 0) },
        })

        const merged = reconcileProviderModels(remote, stored, "overlay-remote")

        expect(merged.models["model-a"].name).toBe("custom name")
        expect(inputPriceOf(merged.models["model-a"])).toBe(1)
        expect(merged.models["model-a"].userDefined).toBe(true)
    })
})

describe("reconcileProviderModels refresh-built-ins", () => {
    it("keeps a listing-derived catalog intact when the seed declares no model of its own", () => {
        // OpenCode ships no model declaration: discovery writes every entry.
        // Refreshing from that empty seed must not treat the whole catalog as
        // retired built-ins, or each startup would wipe the vendor's limits,
        // capabilities and prices.
        const stored = config({
            "kimi-k3": {
                id: "kimi-k3",
                name: "Kimi K3",
                userDefined: false,
                capabilities: { contextWindow: 1_048_576, maxTokens: 131_072, supportsPromptCache: true },
            },
        })
        const emptySeed = config({})

        const merged = reconcileProviderModels(emptySeed, stored, "refresh-built-ins")

        expect(Object.keys(merged.models)).toEqual(["kimi-k3"])
        expect(merged.models["kimi-k3"].capabilities?.contextWindow).toBe(1_048_576)
        expect(merged.models["kimi-k3"].capabilities?.maxTokens).toBe(131_072)
        expect(merged.models["kimi-k3"].capabilities?.supportsPromptCache).toBe(true)
    })

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

describe("reconcileProviderModels refresh-built-ins catalogs", () => {
    /** A provider with one alternative catalog, so the cleanup path is exercised. */
    function catalogConfig(
        models: Record<string, ModelInfo>,
        catalogModels: Record<string, ModelInfo>,
        defaultModelId?: string,
    ): ProviderModelsConfig {
        return {
            provider: "qwen",
            providerName: "Alibaba Qwen",
            billingMode: "token",
            models,
            catalogs: { "qwen-cn": { models: catalogModels, ...(defaultModelId ? { defaultModelId } : {}) } },
        }
    }

    it("removes a built-in entry the seed no longer declares inside an alternative catalog", () => {
        // `userDefined` is absent on entries written before the marker existed and
        // on every listing-persisted entry, so absent has to mean built-in. Reading
        // it literally is what left stale vendor models in the file forever.
        const stored = catalogConfig({}, { "retired-listing-model": { id: "retired-listing-model", name: "Retired" } })
        const seed = catalogConfig({}, { "current-model": { id: "current-model", name: "Current" } })

        const merged = reconcileProviderModels(seed, stored, "refresh-built-ins")

        expect(Object.keys(merged.catalogs?.["qwen-cn"]?.models ?? {})).toEqual(["current-model"])
    })

    it("keeps an explicitly user-defined entry the seed does not declare inside a catalog", () => {
        const stored = catalogConfig({}, { "private-model": { id: "private-model", name: "Private", userDefined: true } })
        const seed = catalogConfig({}, { "current-model": { id: "current-model", name: "Current" } })

        const merged = reconcileProviderModels(seed, stored, "refresh-built-ins")

        expect(Object.keys(merged.catalogs?.["qwen-cn"]?.models ?? {}).sort()).toEqual(["current-model", "private-model"])
        expect(merged.catalogs?.["qwen-cn"]?.models["private-model"].userDefined).toBe(true)
    })

    it("leaves a fully listing-derived catalog untouched", () => {
        // The OpenCode plans declare no model, so discovery owns every entry there.
        // Treating them as retired built-ins would empty the plan on each startup.
        const stored = catalogConfig({}, { "listed-model": { id: "listed-model", name: "Listed", userDefined: false } })
        const seed = catalogConfig({}, {})

        const merged = reconcileProviderModels(seed, stored, "refresh-built-ins")

        expect(Object.keys(merged.catalogs?.["qwen-cn"]?.models ?? {})).toEqual(["listed-model"])
    })

    it("drops a default that names a model the cleanup removed", () => {
        // A default pointing at nothing would leave the catalog with no usable
        // selection even though it still lists models.
        const stored = catalogConfig(
            {},
            { "retired-default": { id: "retired-default", name: "Retired" }, "current-model": { id: "current-model" } },
            "retired-default",
        )
        const seed = catalogConfig({}, { "current-model": { id: "current-model", name: "Current" } })

        const merged = reconcileProviderModels(seed, stored, "refresh-built-ins")

        const defaultModelId = merged.catalogs?.["qwen-cn"]?.defaultModelId
        expect(defaultModelId === undefined || merged.catalogs?.["qwen-cn"]?.models[defaultModelId]).toBeTruthy()
        expect(defaultModelId).not.toBe("retired-default")
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
