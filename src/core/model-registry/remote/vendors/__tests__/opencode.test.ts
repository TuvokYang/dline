/**
 * OpenCode model listing.
 *
 * The listing is the authority for the model set, the limits, the capabilities,
 * the prices and which family a model is served on. These tests pin the
 * decisions this source makes on top of that data: which protocols a family
 * yields, and what the listing cannot state.
 *
 * Prices are asserted at their published magnitude because the listing already
 * quotes per-million-token amounts; a scaling mistake there is invisible in a
 * shape-only test and multiplies every bill by a million.
 */
import { ApiFormat } from "@shared/proto/dline/models/metadata"
import { describe, expect, it } from "vitest"
import { mockFetchForTesting } from "@/shared/net"
import { OPENCODE_BASE_URL, OpenCodeModelSource } from "../opencode"

const LISTING_URL = `${OPENCODE_BASE_URL}/v1/models`

/** One OpenAI-family entry as the gateway publishes it. */
function openAiFamilyEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: "claude-sonnet-5-5",
        name: "Claude Sonnet 5.5",
        type: "chat",
        description: "A reasoning model.",
        limit: { context: 200_000, output: 64_000 },
        modalities: { input: ["text", "image/png"], output: ["text"] },
        capabilities: {
            tools: { supported: true },
            reasoning: { supported: true },
            cache: { explicit: { ttl: ["5m"] } },
        },
        cost: {
            text: {
                input: { price: 3, cache: { read: 0.3, write: 3.75 } },
                output: { price: 15 },
            },
        },
        api: {
            "chat-completions": { base_url: `${OPENCODE_BASE_URL}/openai/v1` },
        },
        ...overrides,
    }
}

/** An entry the gateway serves through the Anthropic family. */
function anthropicFamilyEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return openAiFamilyEntry({
        id: "kimi-k3",
        name: "Kimi K3",
        api: { messages: { base_url: `${OPENCODE_BASE_URL}/anthropic/v1` } },
        ...overrides,
    })
}

/** Serve one listing payload to a single `fetchModels` call. */
function fetchListing(payload: unknown, context: Record<string, unknown> = {}) {
    return mockFetchForTesting((async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch, () =>
        new OpenCodeModelSource().fetchModels({ apiKey: "", ...context }),
    )
}

describe("OpenCodeModelSource", () => {
    it("offers both OpenAI protocols for a model the listing serves on the OpenAI family", async () => {
        const models = await fetchListing({ data: [openAiFamilyEntry()] })

        // Responses leads because the default resolver takes the first entry, and
        // the gateway publishes Responses as the native OpenAI protocol.
        expect(models["claude-sonnet-5-5"].apiFormats).toEqual([ApiFormat.OPENAI_RESPONSES, ApiFormat.OPENAI_CHAT])
    })

    it("derives the family from the base URL, not from the protocol name", async () => {
        // The listing names one protocol per model, but both OpenAI protocols
        // share one base. Reading the name alone would report a single protocol.
        const models = await fetchListing({
            data: [
                openAiFamilyEntry({
                    id: "gpt-6-luna",
                    api: { responses: { base_url: `${OPENCODE_BASE_URL}/openai/v1` } },
                }),
            ],
        })

        expect(models["gpt-6-luna"].apiFormats).toEqual([ApiFormat.OPENAI_RESPONSES, ApiFormat.OPENAI_CHAT])
    })

    it("offers the same protocols for a model the Go endpoint serves", async () => {
        // The Go endpoint nests the same family under a `/go` segment. The
        // protocol follows the family, not the plan endpoint.
        const models = await fetchListing({
            data: [
                openAiFamilyEntry({
                    id: "deepseek-v4.1-flash",
                    api: { "chat-completions": { base_url: `${OPENCODE_BASE_URL}/go/openai/v1` } },
                }),
            ],
        })

        expect(models["deepseek-v4.1-flash"].apiFormats).toEqual([ApiFormat.OPENAI_RESPONSES, ApiFormat.OPENAI_CHAT])
    })

    it("offers only Anthropic Messages for a model served on the Anthropic family", async () => {
        const models = await fetchListing({ data: [anthropicFamilyEntry()] })

        expect(models["kimi-k3"].apiFormats).toEqual([ApiFormat.ANTHROPIC_CHAT])
    })

    it("skips a model whose family this build cannot carry, instead of offering an unusable entry", async () => {
        const models = await fetchListing({
            data: [
                openAiFamilyEntry(),
                openAiFamilyEntry({
                    id: "gemini-4.0-pro",
                    api: { "generate-content": { base_url: `${OPENCODE_BASE_URL}/google/v1beta` } },
                }),
            ],
        })

        expect(Object.keys(models)).toEqual(["claude-sonnet-5-5"])
        expect(models["gemini-4.0-pro"]).toBeUndefined()
    })

    it("reads the limits, capabilities and prices the listing publishes", async () => {
        const models = await fetchListing({ data: [openAiFamilyEntry()] })
        const entry = models["claude-sonnet-5-5"]

        expect(entry.name).toBe("Claude Sonnet 5.5")
        expect(entry.capabilities?.contextWindow).toBe(200_000)
        expect(entry.capabilities?.maxTokens).toBe(64_000)
        expect(entry.capabilities?.supportsTools).toBe(true)
        expect(entry.capabilities?.supportsReasoning).toBe(true)
        expect(entry.capabilities?.supportsImages).toBe(true)
    })

    it("stores the published per-million price without scaling it again", async () => {
        const models = await fetchListing({ data: [openAiFamilyEntry()] })
        const prices = models["claude-sonnet-5-5"].pricing?.metered?.strategy?.flat?.prices

        expect(prices?.inputPrice).toBe(3)
        expect(prices?.outputPrice).toBe(15)
        expect(prices?.cacheReadPrice).toBe(0.3)
        expect(prices?.cacheWritePrice).toBe(3.75)
    })

    it("keeps the published zero price in memory instead of dropping the price set", async () => {
        const models = await fetchListing({
            data: [openAiFamilyEntry({ id: "big-pickle", cost: { text: { input: { price: 0 }, output: { price: 0 } } } })],
        })
        const prices = models["big-pickle"].pricing?.metered?.strategy?.flat?.prices

        // The listing states a public rate of zero. Treating it as missing would
        // leave every free model without a price set, which the usage surface
        // cannot tell apart from "the seller publishes no terms".
        expect(prices).toBeDefined()
        expect(prices?.inputPrice).toBe(0)
        expect(prices?.outputPrice).toBe(0)
    })

    it("reads the cache flag the listing states, not the cached price", async () => {
        const models = await fetchListing({
            data: [
                openAiFamilyEntry(),
                // A free model publishes a zero cache rate but declares no cache.
                openAiFamilyEntry({
                    id: "beam-free",
                    capabilities: { tools: { supported: true }, reasoning: { supported: true } },
                    cost: { text: { input: { price: 0, cache: { read: 0 } }, output: { price: 0 } } },
                }),
            ],
        })

        expect(models["claude-sonnet-5-5"].capabilities?.supportsPromptCache).toBe(true)
        // `beam-free` declares no `capabilities.cache` block at all. Caching is a
        // property of the gateway, so an absent block still means enabled.
        expect(models["beam-free"].capabilities?.supportsPromptCache).toBe(true)
    })

    it("keeps a flag-only reasoning declaration without completing it from the local ledger", async () => {
        const models = await fetchListing({ data: [openAiFamilyEntry()] })
        const capabilities = models["claude-sonnet-5-5"].capabilities

        // The listing states only a reasoning flag. This build declares no model
        // of its own, so the declaration must be exactly what the listing said:
        // no effort levels, no default effort and no locked switch invented here.
        expect(capabilities?.thinking).toEqual({ supported: true })
    })

    it("declares no thinking control for a ledger model whose listing omits reasoning", async () => {
        const models = await fetchListing({
            data: [openAiFamilyEntry({ capabilities: { tools: { supported: true } } })],
        })

        // Falling back to the local declaration here would bring back a default
        // effort and a forced-on switch the gateway never published, and the
        // settings page would send an effort level this model may not accept.
        expect(models["claude-sonnet-5-5"].capabilities?.thinking).toBeUndefined()
    })

    it("declares no thinking control for a ledger model whose listing refuses reasoning", async () => {
        const models = await fetchListing({
            data: [openAiFamilyEntry({ capabilities: { tools: { supported: true }, reasoning: { supported: false } } })],
        })

        const capabilities = models["claude-sonnet-5-5"].capabilities
        expect(capabilities?.supportsReasoning).toBe(false)
        expect(capabilities?.thinking).toBeUndefined()
    })

    it("builds the thinking levels from the effort array the listing publishes", async () => {
        const models = await fetchListing({
            data: [
                openAiFamilyEntry({
                    id: "deepseek-v4.1-flash",
                    capabilities: {
                        tools: { supported: true },
                        reasoning: { supported: true, toggle: true, effort: ["low", "high", "max"] },
                        cache: { implicit: true },
                    },
                }),
            ],
        })
        const thinking = models["deepseek-v4.1-flash"].capabilities?.thinking

        expect(thinking?.mode).toBe("effort")
        expect(thinking?.effortLevels).toEqual(["low", "high", "max"])
        // Neither a default level, automatic activation, nor a forced-on control
        // is published, so none may be invented.
        expect(thinking).not.toHaveProperty("defaultEffort")
        expect(thinking).not.toHaveProperty("defaultEnabled")
        expect(thinking).not.toHaveProperty("canDisable")
    })

    it("keeps a budget model usable when the listing states no bounds", async () => {
        const models = await fetchListing({
            data: [
                openAiFamilyEntry({
                    id: "kimi-k3.1-pro",
                    capabilities: { tools: { supported: true }, reasoning: { supported: true, budget: {} } },
                }),
            ],
        })
        const thinking = models["kimi-k3.1-pro"].capabilities?.thinking

        expect(thinking?.mode).toBe("budget")
        expect(thinking).not.toHaveProperty("minBudget")
        expect(thinking).not.toHaveProperty("maxBudget")
    })

    it("carries the input MIME types the listing publishes", async () => {
        const models = await fetchListing({
            data: [
                openAiFamilyEntry({
                    id: "gpt-6-astra",
                    modalities: { input: ["text", "image/png", "application/pdf"], output: ["text"] },
                }),
            ],
        })
        const capabilities = models["gpt-6-astra"].capabilities

        expect(capabilities?.inputMediaTypes).toEqual(["image/png", "application/pdf"])
        expect(capabilities?.supportsImages).toBe(true)
    })

    it("leaves an unknown model usable with the listing's own facts and no declaration", async () => {
        const models = await fetchListing({ data: [openAiFamilyEntry({ id: "brand-new-model" })] })

        expect(models["brand-new-model"]).toBeDefined()
        // The fixture publishes a reasoning flag, so a flag-only declaration is
        // carried; it has no levels and no local declaration supplies any.
        expect(models["brand-new-model"].capabilities?.thinking).toEqual({ supported: true })
        expect(models["brand-new-model"].capabilities?.tools).toBeUndefined()
    })

    it("reads every field of a real anthropic-family entry that declares explicit caching", async () => {
        // Verbatim shape of `claude-fable-5` from GET /inference/v1/models.
        const models = await fetchListing({
            data: [
                {
                    id: "claude-fable-5",
                    object: "model",
                    name: "Claude Fable 5",
                    type: "chat",
                    modalities: {
                        input: ["text", "image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"],
                        output: ["text"],
                    },
                    capabilities: {
                        tools: { supported: true },
                        reasoning: { supported: true, effort: ["low", "medium", "high", "xhigh", "max"] },
                        cache: {
                            explicit: {
                                ttl: ["5m", "1h"],
                                max_breakpoints: 4,
                                targets: ["tools", "system", "messages"],
                                min_tokens: 512,
                            },
                        },
                        temperature: false,
                    },
                    limit: { context: 1_000_000, output: 128_000 },
                    cost: { text: { input: { price: 10, cache: { read: 1, write: 12.5 } }, output: { price: 50 } } },
                    api: { messages: { base_url: `${OPENCODE_BASE_URL}/anthropic/v1` } },
                },
            ],
        })
        const entry = models["claude-fable-5"]

        expect(entry.capabilities?.contextWindow).toBe(1_000_000)
        expect(entry.capabilities?.maxTokens).toBe(128_000)
        expect(entry.capabilities?.supportsPromptCache).toBe(true)
        expect(entry.capabilities?.supportsImages).toBe(true)
        expect(entry.capabilities?.supportsTools).toBe(true)
        expect(entry.capabilities?.thinking).toEqual({
            supported: true,
            mode: "effort",
            effortLevels: ["low", "medium", "high", "xhigh", "max"],
        })
        expect(entry.apiFormats).toEqual([ApiFormat.ANTHROPIC_CHAT])

        const prices = entry.pricing?.metered?.strategy?.flat?.prices
        expect(prices?.inputPrice).toBe(10)
        expect(prices?.outputPrice).toBe(50)
        expect(prices?.cacheReadPrice).toBe(1)
        expect(prices?.cacheWritePrice).toBe(12.5)
    })

    it("reads a real responses-family entry that declares implicit caching", async () => {
        // Verbatim shape of `gpt-6-astra`, including the `limit.input` companion
        // key and the implicit cache declaration the OpenAI family publishes.
        const models = await fetchListing({
            data: [
                {
                    id: "gpt-6-astra",
                    object: "model",
                    name: "GPT-6 Astra",
                    type: "chat",
                    modalities: {
                        input: ["text", "image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"],
                        output: ["text"],
                    },
                    capabilities: {
                        tools: { supported: true },
                        reasoning: { supported: true, effort: ["low", "medium", "high", "xhigh", "max"] },
                        cache: { implicit: true },
                        structured_output: true,
                        temperature: false,
                    },
                    limit: { context: 1_050_000, input: 922_000, output: 128_000 },
                    cost: {
                        text: {
                            input: {
                                price: 10,
                                cache: { read: 1, write: 12.5 },
                                overrides: [{ when: { context: { gt: 272_000 } }, price: 20 }],
                            },
                            output: { price: 50 },
                        },
                    },
                    api: { responses: { base_url: `${OPENCODE_BASE_URL}/openai/v1` } },
                },
            ],
        })
        const entry = models["gpt-6-astra"]

        // `limit.input` is the request ceiling, so it wins over the larger
        // `limit.context` total the entry also publishes.
        expect(entry.capabilities?.contextWindow).toBe(922_000)
        expect(entry.capabilities?.maxTokens).toBe(128_000)
        expect(entry.capabilities?.supportsPromptCache).toBe(true)
        expect(entry.capabilities?.thinking?.effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"])
        // The listing names `responses`, but the base URL is the shared OpenAI
        // family root, so the model accepts both OpenAI protocols.
        expect(entry.apiFormats).toEqual([ApiFormat.OPENAI_RESPONSES, ApiFormat.OPENAI_CHAT])
    })

    it("reads a real free entry that publishes a zero rate and declares no cache", async () => {
        // Verbatim shape of `big-pickle`: `price: 0` everywhere and no
        // `capabilities.cache` key at all.
        const models = await fetchListing({
            data: [
                {
                    id: "big-pickle",
                    object: "model",
                    name: "Big Pickle",
                    type: "chat",
                    modalities: { input: ["text"], output: ["text"] },
                    capabilities: {
                        tools: { supported: true },
                        reasoning: { supported: true },
                        structured_output: true,
                        temperature: true,
                    },
                    limit: { context: 200_000, input: 160_000, output: 32_000 },
                    cost: { text: { input: { price: 0, cache: { read: 0, write: 0 } }, output: { price: 0 } } },
                    api: { "chat-completions": { base_url: `${OPENCODE_BASE_URL}/openai/v1` } },
                },
            ],
        })
        const entry = models["big-pickle"]

        // `limit.input` (160k) is the request ceiling inside a 200k context.
        expect(entry.capabilities?.contextWindow).toBe(160_000)
        expect(entry.capabilities?.maxTokens).toBe(32_000)
        // No `capabilities.cache` key: the gateway caches for every model it
        // serves, so the flag stays on regardless of the block's absence.
        expect(entry.capabilities?.supportsPromptCache).toBe(true)
        expect(entry.capabilities?.inputMediaTypes).toBeUndefined()
        expect(entry.capabilities?.supportsImages).toBe(false)

        const prices = entry.pricing?.metered?.strategy?.flat?.prices
        expect(prices?.inputPrice).toBe(0)
        expect(prices?.outputPrice).toBe(0)
    })

    it("reads a real entry that publishes only a toggle reasoning flag", async () => {
        // Verbatim shape of `kimi-k3`: `toggle: true` beside effort levels, and
        // the `kimi` families carry video input under modalities.
        const models = await fetchListing({
            data: [
                {
                    id: "kimi-k3",
                    object: "model",
                    name: "Kimi K3",
                    type: "chat",
                    modalities: { input: ["text", "image/png", "video/mp4"], output: ["text"] },
                    capabilities: {
                        tools: { supported: true },
                        reasoning: { supported: true, toggle: true, effort: ["low", "high", "max"] },
                        cache: { implicit: true },
                        structured_output: true,
                    },
                    limit: { context: 1_048_576, output: 131_072 },
                    cost: { text: { input: { price: 3, cache: { read: 0.3, write: 3 } }, output: { price: 15 } } },
                    api: { "chat-completions": { base_url: `${OPENCODE_BASE_URL}/openai/v1` } },
                },
            ],
        })
        const entry = models["kimi-k3"]

        expect(entry.capabilities?.contextWindow).toBe(1_048_576)
        expect(entry.capabilities?.maxTokens).toBe(131_072)
        expect(entry.capabilities?.supportsPromptCache).toBe(true)
        expect(entry.capabilities?.thinking?.effortLevels).toEqual(["low", "high", "max"])
        // `toggle` is a separate declaration; it must not be reported as
        // `canDisable`, which only an explicit false can state.
        expect(entry.capabilities?.thinking).not.toHaveProperty("canDisable")
        expect(entry.capabilities?.inputMediaTypes).toEqual(["image/png", "video/mp4"])
    })

    it("keeps caching on for a free model that quotes no cache cost", async () => {
        // Verbatim shape of `deepseek-v4.1-flash-free`: no `capabilities.cache`,
        // and `cost.text.input.cache.read` published as 0 with no write rate. The
        // zero is what makes the cache free, not what makes it absent.
        const models = await fetchListing({
            data: [
                {
                    id: "deepseek-v4.1-flash-free",
                    object: "model",
                    name: "DeepSeek V4.1 Flash Free",
                    type: "chat",
                    modalities: { input: ["text", "image/jpeg", "image/png"], output: ["text"] },
                    capabilities: {
                        tools: { supported: true },
                        reasoning: { supported: true, toggle: true, effort: ["low", "high", "max"] },
                        structured_output: true,
                    },
                    limit: { context: 200_000, output: 32_000 },
                    cost: { text: { input: { price: 0, cache: { read: 0 } }, output: { price: 0 } } },
                    api: { "chat-completions": { base_url: `${OPENCODE_BASE_URL}/openai/v1` } },
                },
            ],
        })
        const entry = models["deepseek-v4.1-flash-free"]

        expect(entry.capabilities?.contextWindow).toBe(200_000)
        expect(entry.capabilities?.maxTokens).toBe(32_000)
        expect(entry.capabilities?.supportsPromptCache).toBe(true)
        expect(entry.apiFormats).toEqual([ApiFormat.OPENAI_RESPONSES, ApiFormat.OPENAI_CHAT])

        const prices = entry.pricing?.metered?.strategy?.flat?.prices
        expect(prices?.inputPrice).toBe(0)
        expect(prices?.outputPrice).toBe(0)
        // `cache.read` is published as a real zero, so it must survive as a rate
        // rather than be dropped for being falsy. No `cache.write` key exists, so
        // that side stays absent instead of being filled with a zero the listing
        // never quoted.
        expect(prices?.cacheReadPrice).toBe(0)
        expect(prices?.cacheWritePrice).toBeUndefined()
    })

    it("reads caching from a published cache rate when the listing omits the capability block", async () => {
        // Verbatim shape of `grok-4.5`: `capabilities` has no `cache` object at
        // all, yet `cost.text.input.cache.read` is 0.3. A model the gateway bills
        // for cache reads does cache, so reading the capability block alone would
        // report it as uncached.
        const models = await fetchListing({
            data: [
                {
                    id: "grok-4.5",
                    object: "model",
                    name: "Grok 4.5",
                    type: "chat",
                    modalities: { input: ["text", "image/jpeg", "image/png"], output: ["text"] },
                    capabilities: {
                        tools: { supported: true },
                        reasoning: { supported: true, effort: ["low", "medium", "high"] },
                        structured_output: true,
                    },
                    limit: { context: 500_000, output: 500_000 },
                    cost: { text: { input: { price: 2, cache: { read: 0.3 } }, output: { price: 6 } } },
                    api: { responses: { base_url: `${OPENCODE_BASE_URL}/openai/v1` } },
                },
            ],
        })
        const entry = models["grok-4.5"]

        expect(entry.capabilities?.supportsPromptCache).toBe(true)
        const prices = entry.pricing?.metered?.strategy?.flat?.prices
        expect(prices?.cacheReadPrice).toBe(0.3)
        expect(prices?.cacheWritePrice).toBeUndefined()
    })

    it("keeps the tiered rates a long request triggers instead of only the headline price", async () => {
        // Verbatim shape of `claude-haiku-5-5`: every rate doubles or more past
        // 100k input tokens. Reading only the base rate would understate a long
        // request by five times.
        const models = await fetchListing({
            data: [
                {
                    id: "claude-haiku-5-5",
                    object: "model",
                    name: "Claude Haiku 5.5",
                    type: "chat",
                    modalities: { input: ["text"], output: ["text"] },
                    capabilities: {
                        tools: { supported: true },
                        reasoning: { supported: true, effort: ["low", "medium"] },
                        cache: { explicit: { ttl: ["5m", "1h"] } },
                    },
                    limit: { context: 1_000_000, output: 128_000 },
                    cost: {
                        text: {
                            input: {
                                price: 0.1,
                                cache: { read: 0.01, write: 0.125 },
                                overrides: [
                                    { when: { context: { gt: 100_000 } }, price: 0.5, cache: { read: 0.05, write: 0.625 } },
                                ],
                            },
                            output: { price: 0.5, overrides: [{ when: { context: { gt: 100_000 } }, price: 2.5 }] },
                        },
                    },
                    api: { messages: { base_url: `${OPENCODE_BASE_URL}/anthropic/v1` } },
                },
            ],
        })
        const entry = models["claude-haiku-5-5"]

        // `limit.input` is absent here, so the context total is the ceiling.
        expect(entry.capabilities?.contextWindow).toBe(1_000_000)

        const bands = entry.pricing?.metered?.strategy?.contextWindow?.bands ?? []
        expect(bands).toHaveLength(2)
        expect(bands[0].maxInputTokens).toBe(100_000)
        expect(bands[0].prices?.inputPrice).toBe(0.1)
        expect(bands[0].prices?.outputPrice).toBe(0.5)
        expect(bands[0].prices?.cacheReadPrice).toBe(0.01)
        expect(bands[0].prices?.cacheWritePrice).toBe(0.125)
        expect(bands[1].prices?.inputPrice).toBe(0.5)
        expect(bands[1].prices?.outputPrice).toBe(2.5)
        expect(bands[1].prices?.cacheReadPrice).toBe(0.05)
        expect(bands[1].prices?.cacheWritePrice).toBe(0.625)
    })

    it("lists from the gateway root even when the Profile carries a protocol base URL", async () => {
        const requested: string[] = []
        await mockFetchForTesting(
            (async (input: RequestInfo | URL) => {
                requested.push(String(input))
                return new Response(JSON.stringify({ data: [] }), { status: 200 })
            }) as typeof fetch,
            () =>
                new OpenCodeModelSource().fetchModels({
                    apiKey: "",
                    baseUrl: `${OPENCODE_BASE_URL}/openai/v1`,
                }),
        )

        expect(requested).toEqual([LISTING_URL])
    })
})
