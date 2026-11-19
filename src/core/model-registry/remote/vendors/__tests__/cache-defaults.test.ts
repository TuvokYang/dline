/**
 * Cache capability declarations per listing source.
 *
 * The product default for prompt caching is `true` and lives in exactly one
 * place: `buildEffectiveModelInfo`. A listing source therefore reports only what
 * the vendor actually stated — absent stays `undefined` — and an explicit
 * `false` must survive to the effective metadata. These tests pin that contract
 * for every source that used to answer for the vendor, and that a price is never
 * read as a capability.
 */

import fs from "node:fs/promises"
import * as path from "node:path"
import { ModelRegistry } from "@core/model-registry/ModelRegistry"
import { persistProviderCatalog } from "@core/model-registry/provider-catalog-storage"
import { buildEffectiveModelInfo } from "@shared/providers/effective-model-info"
import { readPriceSet } from "@shared/providers/pricing-shape"
import type { ModelInfo } from "@shared/providers/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mockFetchForTesting } from "@/shared/net"
import { aiHubMixModelSource } from "../aihubmix"
import { AnthropicModelSource } from "../anthropic"
import { liteLlmModelSource } from "../litellm"
import { ocaModelSource } from "../oca"
import { openRouterModelSource } from "../openrouter"
import { requestyModelSource } from "../requesty"
import { vercelAiGatewayModelSource } from "../vercel"

function respondWith(payload: unknown): typeof fetch {
    return (async () =>
        new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch
}

/** The capability a source reported, before any product default is applied. */
function rawCache(models: Record<string, ModelInfo>, modelId: string): boolean | undefined {
    return models[modelId].capabilities?.supportsPromptCache
}

/** The capability a consumer sees, after the single product default is applied. */
function effectiveCache(models: Record<string, ModelInfo>, modelId: string): boolean | undefined {
    return buildEffectiveModelInfo(modelId, models[modelId], {}).capabilities?.supportsPromptCache
}

function openRouterListing(entry: Record<string, unknown>): unknown {
    return { data: [{ id: "vendor/minimal", ...entry }] }
}

function anthropicListing(entry: Record<string, unknown>, modelId = "claude-fable-5-1"): unknown {
    return {
        data: [{ type: "model", id: modelId, display_name: modelId, ...entry }],
        has_more: false,
    }
}

function litellmListing(modelInfo: unknown): unknown {
    return {
        data: [
            {
                model_name: "litellm-minimal",
                litellm_params: { model: "litellm-minimal" },
                ...(modelInfo === undefined ? {} : { model_info: modelInfo }),
            },
        ],
    }
}

function ocaListing(modelInfo: unknown, modelId = "oca/minimal"): unknown {
    return {
        data: [
            {
                litellm_params: { model: modelId },
                ...(modelInfo === undefined ? {} : { model_info: modelInfo }),
            },
        ],
    }
}

function aiHubMixListing(entry: Record<string, unknown>): unknown {
    return { success: true, data: [{ model: "hub/minimal", ...entry }] }
}

describe("a source that states no cache flag leaves the capability unresolved", () => {
    it("OpenRouter reports undefined instead of denying caching for every model", async () => {
        const models = await mockFetchForTesting(respondWith(openRouterListing({})), () => openRouterModelSource.fetchModels({}))

        expect(rawCache(models, "vendor/minimal")).toBeUndefined()
        expect(effectiveCache(models, "vendor/minimal")).toBe(true)
    })

    it("AIhubmix reports undefined instead of guessing from a ratio or a price", async () => {
        const models = await mockFetchForTesting(
            respondWith(aiHubMixListing({ cache_ratio: 0.1, pricing: { input: 1, output: 2, cache_read: 0.1 } })),
            () => aiHubMixModelSource.fetchModels({}),
        )

        expect(rawCache(models, "hub/minimal")).toBeUndefined()
        expect(effectiveCache(models, "hub/minimal")).toBe(true)
    })

    it("Vercel AI Gateway reports undefined instead of deriving from a cache price", async () => {
        const models = await mockFetchForTesting(
            respondWith({
                data: [
                    {
                        id: "vendor/minimal",
                        pricing: { input: "0.000001", output: "0.000002", input_cache_read: "0.000001", input_cache_write: "0" },
                    },
                ],
            }),
            () => vercelAiGatewayModelSource.fetchModels({}),
        )

        expect(rawCache(models, "vendor/minimal")).toBeUndefined()
        expect(effectiveCache(models, "vendor/minimal")).toBe(true)
    })

    it("LiteLLM reports undefined when the deployment omits the flag", async () => {
        const models = await mockFetchForTesting(respondWith(litellmListing({ input_cost_per_token: 0.000001 })), () =>
            liteLlmModelSource.fetchModels({ apiKey: "k" }),
        )

        expect(rawCache(models, "litellm-minimal")).toBeUndefined()
        expect(effectiveCache(models, "litellm-minimal")).toBe(true)
    })

    it("OCA reports undefined when model_info states no cache flag", async () => {
        const models = await mockFetchForTesting(respondWith(ocaListing({ description: "no flag" })), () =>
            ocaModelSource.fetchModels({ apiKey: "k" }),
        )

        expect(rawCache(models, "oca/minimal")).toBeUndefined()
        expect(effectiveCache(models, "oca/minimal")).toBe(true)
    })

    it("Anthropic reports undefined when the listing carries no capability tree", async () => {
        const source = new AnthropicModelSource()
        const models = await mockFetchForTesting(respondWith(anthropicListing({})), () => source.fetchModels({ apiKey: "k" }))

        expect(rawCache(models, "claude-fable-5-1")).toBeUndefined()
        expect(effectiveCache(models, "claude-fable-5-1")).toBe(true)
    })
})

describe("an explicit cache flag survives the source boundary", () => {
    it("LiteLLM keeps an explicit boolean and drops a non-boolean value", async () => {
        const listing = {
            data: [
                { model_name: "cache-on", litellm_params: { model: "cache-on" }, model_info: { supports_prompt_caching: true } },
                {
                    model_name: "cache-off",
                    litellm_params: { model: "cache-off" },
                    model_info: { supports_prompt_caching: false },
                },
                {
                    model_name: "cache-string",
                    litellm_params: { model: "cache-string" },
                    model_info: { supports_prompt_caching: "true" },
                },
                {
                    model_name: "cache-nested",
                    litellm_params: { model: "cache-nested" },
                    model_info: { supports_prompt_caching: { supported: true } },
                },
                {
                    model_name: "cache-null",
                    litellm_params: { model: "cache-null" },
                    model_info: { supports_prompt_caching: null },
                },
            ],
        }

        const models = await mockFetchForTesting(respondWith(listing), () => liteLlmModelSource.fetchModels({ apiKey: "k" }))

        expect(rawCache(models, "cache-on")).toBe(true)
        expect(rawCache(models, "cache-off")).toBe(false)
        expect(rawCache(models, "cache-string")).toBeUndefined()
        expect(rawCache(models, "cache-nested")).toBeUndefined()
        expect(rawCache(models, "cache-null")).toBeUndefined()
        expect(effectiveCache(models, "cache-off")).toBe(false)
        expect(effectiveCache(models, "cache-string")).toBe(true)
    })

    it("LiteLLM keeps its existing vision and reasoning reading", async () => {
        const models = await mockFetchForTesting(
            respondWith(
                litellmListing({
                    supports_prompt_caching: true,
                    supports_vision: true,
                    supports_reasoning: false,
                }),
            ),
            () => liteLlmModelSource.fetchModels({ apiKey: "k" }),
        )

        // The cache field became presence-aware; the other two flags did not.
        expect(models["litellm-minimal"].capabilities?.supportsImages).toBe(true)
        expect(models["litellm-minimal"].capabilities?.supportsReasoning).toBe(false)

        const silent = await mockFetchForTesting(respondWith(litellmListing({})), () =>
            liteLlmModelSource.fetchModels({ apiKey: "k" }),
        )
        expect(silent["litellm-minimal"].capabilities?.supportsImages).toBe(false)
        expect(silent["litellm-minimal"].capabilities?.supportsReasoning).toBe(false)
    })

    it("OCA keeps an explicit boolean through both listing entry points", async () => {
        const listing = {
            data: [
                { litellm_params: { model: "oca/cache-on" }, model_info: { supports_caching: true } },
                { litellm_params: { model: "oca/cache-off" }, model_info: { supports_caching: false } },
                { litellm_params: { model: "oca/cache-string" }, model_info: { supports_caching: "true" } },
                { litellm_params: { model: "oca/cache-silent" }, model_info: {} },
            ],
        }

        const listed = await mockFetchForTesting(respondWith(listing), () => ocaModelSource.fetchModels({ apiKey: "k" }))
        const withExtras = await mockFetchForTesting(respondWith(listing), () =>
            ocaModelSource.fetchModelsWithExtras({ apiKey: "k" }),
        )

        for (const models of [listed, withExtras.models]) {
            expect(rawCache(models, "oca/cache-on")).toBe(true)
            expect(rawCache(models, "oca/cache-off")).toBe(false)
            expect(rawCache(models, "oca/cache-string")).toBeUndefined()
            expect(rawCache(models, "oca/cache-silent")).toBeUndefined()
        }
        expect(effectiveCache(withExtras.models, "oca/cache-off")).toBe(false)
        expect(effectiveCache(withExtras.models, "oca/cache-silent")).toBe(true)
    })

    it("Requesty keeps its existing tri-state reading", async () => {
        const models = await mockFetchForTesting(
            respondWith({
                data: [
                    { id: "req/cache-on", supports_caching: true },
                    { id: "req/cache-off", supports_caching: false },
                    { id: "req/cache-silent" },
                ],
            }),
            () => requestyModelSource.fetchModels({ apiKey: "k" }),
        )

        expect(rawCache(models, "req/cache-on")).toBe(true)
        expect(rawCache(models, "req/cache-off")).toBe(false)
        expect(rawCache(models, "req/cache-silent")).toBeUndefined()
        expect(effectiveCache(models, "req/cache-silent")).toBe(true)
    })
})

describe("Anthropic context_management aggregation", () => {
    async function cacheFor(contextManagement: unknown): Promise<boolean | undefined> {
        const source = new AnthropicModelSource()
        const models = await mockFetchForTesting(
            respondWith(anthropicListing({ capabilities: { context_management: contextManagement } })),
            () => source.fetchModels({ apiKey: "k" }),
        )
        return rawCache(models, "claude-fable-5-1")
    }

    it("leaves the capability unresolved for an empty block", async () => {
        expect(await cacheFor({})).toBeUndefined()
    })

    it("leaves the capability unresolved when no leaf states a boolean", async () => {
        expect(await cacheFor({ clear_thinking_20251015: {}, prompt_caching: "yes", other: null })).toBeUndefined()
    })

    it("denies the capability only when every stated leaf is false", async () => {
        expect(await cacheFor({ clear_thinking_20251015: { supported: false }, prompt_caching: { supported: false } })).toBe(
            false,
        )
    })

    it("grants the capability when one stated leaf is true", async () => {
        expect(await cacheFor({ clear_thinking_20251015: { supported: false }, prompt_caching: { supported: true } })).toBe(true)
    })
})

describe("a published price is not a capability", () => {
    it("Vercel keeps reading every rate without turning them into a flag", async () => {
        const models = await mockFetchForTesting(
            respondWith({
                data: [
                    {
                        id: "vendor/equal-rates",
                        pricing: {
                            input: "0.000002",
                            output: "0.000002",
                            input_cache_read: "0.000002",
                            input_cache_write: "0.000002",
                        },
                    },
                    {
                        id: "vendor/zero-rates",
                        pricing: { input: "0.000001", output: "0.000002", input_cache_read: "0", input_cache_write: "0" },
                    },
                    { id: "vendor/no-rates" },
                ],
            }),
            () => vercelAiGatewayModelSource.fetchModels({}),
        )

        const zero = models["vendor/zero-rates"].pricing?.strategy?.flat?.prices
        expect(readPriceSet(zero).inputPrice).toBeCloseTo(1, 6)
        // A published zero is a rate, not an absence, so it must survive as zero.
        expect(readPriceSet(zero).cacheReadPrice).toBe(0)
        expect(zero?.cacheReadPrice).toBe(0)
        expect(models["vendor/no-rates"].pricing).toBeUndefined()
        for (const modelId of ["vendor/equal-rates", "vendor/zero-rates", "vendor/no-rates"]) {
            expect(rawCache(models, modelId), modelId).toBeUndefined()
            expect(effectiveCache(models, modelId), modelId).toBe(true)
        }
    })

    it("AIhubmix keeps its cache prices without inferring support from them", async () => {
        const models = await mockFetchForTesting(
            respondWith(aiHubMixListing({ pricing: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } })),
            () => aiHubMixModelSource.fetchModels({}),
        )

        const prices = readPriceSet(models["hub/minimal"].pricing?.strategy?.flat?.prices)
        expect(prices.cacheReadPrice).toBe(0.3)
        expect(prices.cacheWritePrice).toBe(3.75)
        expect(rawCache(models, "hub/minimal")).toBeUndefined()
    })

    it("OpenRouter keeps its cache prices without inferring support from them", async () => {
        const models = await mockFetchForTesting(
            respondWith(
                openRouterListing({
                    pricing: {
                        prompt: "0.000003",
                        completion: "0.000015",
                        input_cache_read: "0.0000003",
                        input_cache_write: "0.00000375",
                    },
                }),
            ),
            () => openRouterModelSource.fetchModels({}),
        )

        const prices = readPriceSet(models["vendor/minimal"].pricing?.strategy?.flat?.prices)
        expect(prices.cacheReadPrice).toBeCloseTo(0.3, 6)
        expect(prices.cacheWritePrice).toBeCloseTo(3.75, 6)
        expect(rawCache(models, "vendor/minimal")).toBeUndefined()
    })
})

describe("the cache contract survives persistence and reload", () => {
    let registry: ModelRegistry
    let tempDir: string

    beforeEach(async () => {
        tempDir = path.join(
            process.env.TEMP || "/tmp",
            `cache-defaults-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        )
        await fs.mkdir(tempDir, { recursive: true })
        ;(ModelRegistry as unknown as { instance?: ModelRegistry }).instance = undefined
        registry = ModelRegistry.getInstance()
        Object.defineProperty(registry, "providersDir", { get: () => tempDir, configurable: true })
        Object.defineProperty(registry, "startWatch", { value: vi.fn(), configurable: true })
        await registry.initialize()
    })

    afterEach(async () => {
        await registry.dispose()
        ;(ModelRegistry as unknown as { instance?: ModelRegistry }).instance = undefined
        await fs.rm(tempDir, { recursive: true, force: true })
    })

    it("stores an unstated capability as absent and resolves it to true after reload", async () => {
        const models = await mockFetchForTesting(respondWith(openRouterListing({})), () => openRouterModelSource.fetchModels({}))

        await persistProviderCatalog({
            providerId: openRouterModelSource.providerId,
            providerName: openRouterModelSource.providerName,
            billingMode: openRouterModelSource.billingMode,
            models,
            reconciliationMode: openRouterModelSource.reconciliation,
        })

        const written = JSON.parse(await fs.readFile(path.join(tempDir, "openrouter.json"), "utf8"))
        expect(written.models["vendor/minimal"].capabilities).not.toHaveProperty("supportsPromptCache")

        const restored = registry.getProviderModels("openrouter")?.models["vendor/minimal"]
        expect(restored?.capabilities?.supportsPromptCache).toBeUndefined()
        expect(effectiveCache(registry.getProviderModels("openrouter")?.models ?? {}, "vendor/minimal")).toBe(true)
    })

    it("keeps an explicitly stored false when the listing is silent", async () => {
        await fs.writeFile(
            path.join(tempDir, "anthropic.json"),
            JSON.stringify({
                provider: "anthropic",
                providerName: "Anthropic",
                billingMode: "token",
                models: {
                    "claude-fable-5-1": {
                        id: "claude-fable-5-1",
                        name: "claude-fable-5-1",
                        capabilities: { contextWindow: 200_000, supportsPromptCache: false },
                    },
                },
            }),
        )
        await registry.reload()

        const source = new AnthropicModelSource()
        const models = await mockFetchForTesting(respondWith(anthropicListing({ capabilities: {} })), () =>
            source.fetchModels({ apiKey: "k" }),
        )
        expect(rawCache(models, "claude-fable-5-1")).toBeUndefined()

        await persistProviderCatalog({
            providerId: source.providerId,
            providerName: source.providerName,
            billingMode: source.billingMode,
            models,
            reconciliationMode: source.reconciliation,
        })

        const written = JSON.parse(await fs.readFile(path.join(tempDir, "anthropic.json"), "utf8"))
        expect(written.models["claude-fable-5-1"].capabilities.supportsPromptCache).toBe(false)

        const restored = registry.getProviderModels("anthropic")?.models ?? {}
        expect(restored["claude-fable-5-1"].capabilities?.supportsPromptCache).toBe(false)
        expect(effectiveCache(restored, "claude-fable-5-1")).toBe(false)
    })
})
