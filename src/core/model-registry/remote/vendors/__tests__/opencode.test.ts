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
import { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"
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

        expect(models["claude-sonnet-5-5"].apiFormats).toEqual([ApiFormat.OPENAI_CHAT, ApiFormat.OPENAI_RESPONSES])
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

        expect(models["gpt-6-luna"].apiFormats).toEqual([ApiFormat.OPENAI_CHAT, ApiFormat.OPENAI_RESPONSES])
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
        expect(models["beam-free"].capabilities?.supportsPromptCache).toBe(false)
    })

    it("keeps declared thinking controls and hosted tools on a model the ledger describes", async () => {
        const models = await fetchListing({ data: [openAiFamilyEntry()] })
        const capabilities = models["claude-sonnet-5-5"].capabilities

        // The listing reports only a reasoning flag; the effort levels it cannot
        // state come from the declaration.
        expect(capabilities?.thinking).toMatchObject({ supported: true, mode: "effort" })
        expect(capabilities?.tools).toEqual([ServerTool.WEB_SEARCH, ServerTool.WEB_FETCH])
    })

    it("leaves an unknown model usable with the listing's own facts and no declaration", async () => {
        const models = await fetchListing({ data: [openAiFamilyEntry({ id: "brand-new-model" })] })

        expect(models["brand-new-model"]).toBeDefined()
        expect(models["brand-new-model"].capabilities?.thinking).toBeUndefined()
        expect(models["brand-new-model"].capabilities?.tools).toBeUndefined()
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
