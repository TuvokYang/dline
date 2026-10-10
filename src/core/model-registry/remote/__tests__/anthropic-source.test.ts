import { describe, expect, it } from "vitest"
import { mockFetchForTesting } from "@/shared/net"
import { AnthropicModelSource } from "../vendors/anthropic"

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
}

function modelEntry(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        type: "model",
        id,
        display_name: `Display ${id}`,
        max_input_tokens: 1_000_000,
        max_tokens: 128_000,
        ...overrides,
    }
}

describe("AnthropicModelSource", () => {
    it("sends the api key header and the pinned api version", async () => {
        const source = new AnthropicModelSource()
        const requests: Array<{ url: string; headers: Headers }> = []

        await mockFetchForTesting(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                requests.push({ url: String(input), headers: new Headers(init?.headers) })
                return jsonResponse({ data: [modelEntry("claude-fable-5-1")], has_more: false })
            },
            async () => {
                await source.fetchModels({ apiKey: "secret-key" })
            },
        )

        expect(requests).toHaveLength(1)
        expect(requests[0].headers.get("x-api-key")).toBe("secret-key")
        expect(requests[0].headers.get("anthropic-version")).toBe("2023-06-01")
        expect(requests[0].url).toContain("/v1/models")
    })

    it("follows the cursor until has_more turns false", async () => {
        const source = new AnthropicModelSource()
        const urls: string[] = []

        const models = await mockFetchForTesting(
            async (input: RequestInfo | URL) => {
                const url = String(input)
                urls.push(url)
                if (!url.includes("after_id")) {
                    return jsonResponse({ data: [modelEntry("model-1")], has_more: true, last_id: "model-1" })
                }
                return jsonResponse({ data: [modelEntry("model-2")], has_more: false })
            },
            async () => source.fetchModels({ apiKey: "secret-key" }),
        )

        expect(urls).toHaveLength(2)
        expect(urls[1]).toContain("after_id=model-1")
        expect(Object.keys(models).sort()).toEqual(["model-1", "model-2"])
    })

    it("stops paginating when the cursor repeats itself", async () => {
        const source = new AnthropicModelSource()
        let calls = 0

        await mockFetchForTesting(
            async () => {
                calls++
                return jsonResponse({ data: [modelEntry("model-1")], has_more: true, last_id: undefined })
            },
            async () => {
                await source.fetchModels({ apiKey: "secret-key" })
            },
        )

        expect(calls).toBe(1)
    })

    it("reads the capability tree through indexed lookups", async () => {
        const source = new AnthropicModelSource()

        const models = await mockFetchForTesting(
            async () =>
                jsonResponse({
                    data: [
                        modelEntry("claude-fable-5-1", {
                            capabilities: {
                                image_input: { supported: true },
                                thinking: { supported: true },
                                context_management: { clear_thinking_20251015: { supported: true } },
                                structured_outputs: { supported: false },
                            },
                        }),
                    ],
                    has_more: false,
                }),
            async () => source.fetchModels({ apiKey: "secret-key" }),
        )

        const capabilities = models["claude-fable-5-1"].capabilities
        expect(capabilities?.supportsImages).toBe(true)
        expect(capabilities?.supportsReasoning).toBe(true)
        expect(capabilities?.supportsPromptCache).toBe(true)
        expect(capabilities?.contextWindow).toBe(1_000_000)
        expect(capabilities?.maxTokens).toBe(128_000)
    })

    it("never reports pricing so that stored prices survive the merge", async () => {
        const source = new AnthropicModelSource()

        const models = await mockFetchForTesting(
            async () => jsonResponse({ data: [modelEntry("claude-fable-5-1")], has_more: false }),
            async () => source.fetchModels({ apiKey: "secret-key" }),
        )

        expect(models["claude-fable-5-1"].pricing).toBeUndefined()
        expect(models["claude-fable-5-1"].description).toBe("Display claude-fable-5-1")
    })

    it("skips the request entirely when no api key is available", async () => {
        const source = new AnthropicModelSource()
        let calls = 0

        const models = await mockFetchForTesting(
            async () => {
                calls++
                return jsonResponse({ data: [], has_more: false })
            },
            async () => source.fetchModels({}),
        )

        expect(calls).toBe(0)
        expect(models).toEqual({})
    })

    it("raises when the vendor answers with a non-success status", async () => {
        const source = new AnthropicModelSource()

        await expect(
            mockFetchForTesting(
                async () => new Response("unauthorized", { status: 401 }),
                async () => source.fetchModels({ apiKey: "bad-key" }),
            ),
        ).rejects.toThrow(/401/)
    })
})
