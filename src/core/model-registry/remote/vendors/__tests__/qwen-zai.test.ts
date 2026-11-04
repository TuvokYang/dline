/**
 * Z AI and Qwen listing sources.
 *
 * Both gateways answer `GET {base}/models` with `{ object: "list", data: [...] }`
 * where each entry carries only an id, so these tests pin the two behaviours the
 * implementation actually owns: which URL is requested for each catalog key, and
 * that a listing without metadata does not erase the locally declared prices and
 * capabilities.
 */

import type { ProviderModelsConfig } from "@shared/providers/types"
import { describe, expect, it, vi } from "vitest"
import { mockFetchForTesting } from "@/shared/net"
import { reconcileProviderModels } from "../../../provider-model-reconciliation"
import { qwenModelSource } from "../qwen"
import { zAiModelSource } from "../zai"

/** The document both gateways were measured to return. */
const IDS_ONLY_LISTING = {
    object: "list",
    data: [
        { id: "glm-5.3", object: "model", created: 1, owned_by: "z-ai" },
        { id: "glm-5.3-flash", object: "model", created: 1, owned_by: "z-ai" },
        { id: "glm-4.5", object: "model", created: 1, owned_by: "z-ai" },
    ],
}

function respondWith(payload: unknown): typeof fetch {
    return (async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch
}

/** Capture the URLs a listing request actually went to. */
async function captureUrls(
    source: { fetchModels(context: { apiKey?: string; baseUrl?: string; catalogKey?: string }): Promise<unknown> },
    context: { apiKey?: string; baseUrl?: string; catalogKey?: string },
): Promise<string[]> {
    const urls: string[] = []
    await mockFetchForTesting(
        (async (url: string) => {
            urls.push(String(url))
            return new Response(JSON.stringify(IDS_ONLY_LISTING), { status: 200 })
        }) as unknown as typeof fetch,
        () => source.fetchModels(context),
    )
    return urls
}

describe("ZAiModelSource", () => {
    it("requests /models under the international v4 base by default", async () => {
        const urls = await captureUrls(zAiModelSource, { apiKey: "k" })

        expect(urls).toEqual(["https://api.z.ai/api/paas/v4/models"])
    })

    it("reads the mainland host when the catalog key selects it", async () => {
        const urls = await captureUrls(zAiModelSource, { apiKey: "k", catalogKey: "zai-cn" })

        expect(urls).toEqual(["https://open.bigmodel.cn/api/paas/v4/models"])
    })

    it("lets an explicit base URL win over the regional default", async () => {
        const urls = await captureUrls(zAiModelSource, {
            apiKey: "k",
            catalogKey: "zai-cn",
            baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
        })

        expect(urls).toEqual(["https://open.bigmodel.cn/api/coding/paas/v4/models"])
    })

    it("returns the ids the gateway listed", async () => {
        const models = await mockFetchForTesting(respondWith(IDS_ONLY_LISTING), () => zAiModelSource.fetchModels({ apiKey: "k" }))

        expect(Object.keys(models).sort()).toEqual(["glm-4.5", "glm-5.3", "glm-5.3-flash"])
    })

    it("declares overlay-remote so an id-only listing cannot erase stored metadata", async () => {
        expect(zAiModelSource.reconciliation).toBe("overlay-remote")

        const discovered = await mockFetchForTesting(respondWith(IDS_ONLY_LISTING), () =>
            zAiModelSource.fetchModels({ apiKey: "k" }),
        )
        // The stored document is what `persistProviderCatalog` passes as `stored`:
        // it holds the local price the id-only listing cannot restate.
        const stored = {
            provider: "zai",
            providerName: "Z AI",
            models: {
                "glm-5.3": {
                    id: "glm-5.3",
                    name: "glm-5.3",
                    capabilities: { contextWindow: 1_000_000, maxTokens: 128_000 },
                    pricing: {
                        currency: "USD",
                        strategy: {
                            flat: {
                                prices: { input: 1.4, output: 4.4, cacheRead: 0.26 },
                                unit: "per_million_tokens",
                            },
                        },
                    },
                },
            },
        } as unknown as ProviderModelsConfig

        const result = reconcileProviderModels({ ...stored, models: discovered }, stored, "overlay-remote")

        // The price survives because the listing stated none.
        expect(result.models["glm-5.3"].pricing?.strategy).toBeDefined()
        expect(result.models["glm-5.3"].capabilities?.maxTokens).toBe(128_000)
        // An id the local catalog never carried is added, marked as not user-owned.
        expect(result.models["glm-5.3-flash"].userDefined).toBe(false)
    })

    it("sends no request without a key", async () => {
        const urls = await captureUrls(zAiModelSource, {})

        expect(urls).toEqual([])
    })
})

describe("ZAiModelSource family inheritance", () => {
    /** The live document, which states no window, limit or capability at all. */
    const LISTED = {
        object: "list",
        data: [
            { id: "glm-5.3", object: "model", created: 1, owned_by: "z-ai" },
            { id: "glm-5.3-flash", object: "model", created: 1, owned_by: "z-ai" },
            { id: "glm-5.3-flashx", object: "model", created: 1, owned_by: "z-ai" },
            { id: "glm-5.3-flashx-legal", object: "model", created: 1, owned_by: "z-ai" },
            { id: "glm-5", object: "model", created: 1, owned_by: "z-ai" },
            { id: "glm-5-turbo", object: "model", created: 1, owned_by: "z-ai" },
        ],
    }

    async function list(): Promise<Record<string, { capabilities?: Record<string, unknown>; pricing?: unknown }>> {
        return (await mockFetchForTesting(respondWith(LISTED), () =>
            zAiModelSource.fetchModels({ apiKey: "k" }),
        )) as unknown as Record<string, { capabilities?: Record<string, unknown>; pricing?: unknown }>
    }

    it("gives a discovered variant its family window and output limit", async () => {
        const models = await list()

        expect(models["glm-5.3-flash"].capabilities?.contextWindow).toBe(1_000_000)
        expect(models["glm-5.3-flash"].capabilities?.maxTokens).toBe(128_000)
    })

    it("inherits from the longest matching family, not the shortest prefix", async () => {
        const models = await list()

        // glm-5.3 declares a 1M window while glm-5 declares 200K, so reading the
        // 200K value would prove glm-5 won the match.
        expect(models["glm-5.3-flashx"].capabilities?.contextWindow).toBe(1_000_000)
        expect(models["glm-5.3-flashx-legal"].capabilities?.contextWindow).toBe(1_000_000)
    })

    it("does not read glm-5 as an ancestor of glm-5.3", async () => {
        const models = await list()

        // Both ids are declared, so both must keep their own declarations.
        expect(models["glm-5"].capabilities?.contextWindow).toBe(200_000)
        expect(models["glm-5.3"].capabilities?.contextWindow).toBe(1_000_000)
    })

    it("carries the family thinking contract onto a discovered variant", async () => {
        const models = await list()

        expect(models["glm-5.3-flash"].capabilities?.thinking).toMatchObject({ supported: true, mode: "enabled" })
    })

    it("never invents pricing for a variant the catalog does not price", async () => {
        const models = await list()

        expect(models["glm-5.3-flash"].pricing).toBeUndefined()
    })

    it("leaves a family the build does not declare without inherited values", async () => {
        const unknown = {
            object: "list",
            data: [{ id: "glm-9.9-flash", object: "model", created: 1, owned_by: "z-ai" }],
        }
        const models = (await mockFetchForTesting(respondWith(unknown), () =>
            zAiModelSource.fetchModels({ apiKey: "k" }),
        )) as unknown as Record<string, { capabilities?: Record<string, unknown> }>

        expect(models["glm-9.9-flash"].capabilities?.contextWindow).toBeUndefined()
        expect(models["glm-9.9-flash"].capabilities?.maxTokens).toBeUndefined()
    })
})

describe("QwenModelSource", () => {
    it("requests /models under the international compatible-mode base by default", async () => {
        const urls = await captureUrls(qwenModelSource, { apiKey: "k" })

        expect(urls).toEqual(["https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models"])
    })

    it("reads the mainland host when the catalog key selects it", async () => {
        const urls = await captureUrls(qwenModelSource, { apiKey: "k", catalogKey: "qwen-cn" })

        expect(urls).toEqual(["https://dashscope.aliyuncs.com/compatible-mode/v1/models"])
    })

    it("accepts a data-centre host as an explicit base URL without adding another version segment", async () => {
        const urls = await captureUrls(qwenModelSource, {
            apiKey: "k",
            baseUrl: "https://ap-southeast-1.maas.qwencloudapi.com/compatible-mode/v1",
        })

        expect(urls).toEqual(["https://ap-southeast-1.maas.qwencloudapi.com/compatible-mode/v1/models"])
    })

    it("declares overlay-remote because the listing carries ids only", () => {
        expect(qwenModelSource.providerId).toBe("qwen")
        expect(qwenModelSource.reconciliation).toBe("overlay-remote")
    })
})

describe("listing source registration", () => {
    it("resolves the regional catalog keys to their owning provider source", async () => {
        const { getModelSource } = await import("../index")

        expect(getModelSource("zai")).toBe(zAiModelSource)
        expect(getModelSource("zai-cn")).toBe(zAiModelSource)
        expect(getModelSource("qwen")).toBe(qwenModelSource)
        expect(getModelSource("qwen-cn")).toBe(qwenModelSource)
    })
})

afterEach(() => {
    vi.restoreAllMocks()
})
