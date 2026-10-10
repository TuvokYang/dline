import { describe, expect, it } from "vitest"
import { mockFetchForTesting } from "@/shared/net"
import { DeepSeekModelSource } from "../vendors/deepseek"

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
}

/** The documented listing shape: ids only, no capability or price metadata. */
function listing(...ids: string[]): unknown {
    return {
        object: "list",
        data: ids.map((id) => ({ id, object: "model", owned_by: "deepseek" })),
    }
}

async function captureRequest(
    source: DeepSeekModelSource,
    context: { apiKey?: string; baseUrl?: string },
    body: unknown = listing("deepseek-chat"),
): Promise<{ url: string; headers: Headers }> {
    const requests: Array<{ url: string; headers: Headers }> = []
    await mockFetchForTesting(
        async (input: RequestInfo | URL, init?: RequestInit) => {
            requests.push({ url: String(input), headers: new Headers(init?.headers) })
            return jsonResponse(body)
        },
        async () => {
            await source.fetchModels(context)
        },
    )
    expect(requests).toHaveLength(1)
    return requests[0]
}

describe("DeepSeekModelSource", () => {
    it("lists models from the documented endpoint without a version segment", async () => {
        const request = await captureRequest(new DeepSeekModelSource(), { apiKey: "secret-key" })

        expect(request.url).toBe("https://api.deepseek.com/models")
        expect(request.headers.get("authorization")).toBe("Bearer secret-key")
    })

    it("keeps a user-provided base url and appends only the listing path", async () => {
        const request = await captureRequest(new DeepSeekModelSource(), {
            apiKey: "secret-key",
            baseUrl: "https://proxy.example.com/deepseek",
        })

        expect(request.url).toBe("https://proxy.example.com/deepseek/models")
    })

    it("honours a base url that already carries a version segment", async () => {
        const request = await captureRequest(new DeepSeekModelSource(), {
            apiKey: "secret-key",
            baseUrl: "https://api.deepseek.com/v1",
        })

        expect(request.url).toBe("https://api.deepseek.com/v1/models")
    })

    it("reads every model id from the listing payload", async () => {
        const source = new DeepSeekModelSource()

        const models = await mockFetchForTesting(
            async () => jsonResponse(listing("deepseek-v4-flash", "deepseek-v4-pro")),
            async () => source.fetchModels({ apiKey: "secret-key" }),
        )

        expect(Object.keys(models).sort()).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"])
        expect(models["deepseek-v4-flash"].id).toBe("deepseek-v4-flash")
        expect(models["deepseek-v4-flash"].name).toBe("deepseek-v4-flash")
    })

    it("falls back to the documented platform limits the listing omits", async () => {
        const source = new DeepSeekModelSource()

        const models = await mockFetchForTesting(
            async () => jsonResponse(listing("deepseek-chat")),
            async () => source.fetchModels({ apiKey: "secret-key" }),
        )

        expect(models["deepseek-chat"].capabilities?.contextWindow).toBe(1_000_000)
        expect(models["deepseek-chat"].capabilities?.maxTokens).toBe(384_000)
    })

    it("never reports pricing so that stored prices survive the merge", async () => {
        const source = new DeepSeekModelSource()

        const models = await mockFetchForTesting(
            async () => jsonResponse(listing("deepseek-chat")),
            async () => source.fetchModels({ apiKey: "secret-key" }),
        )

        expect(models["deepseek-chat"].pricing).toBeUndefined()
    })

    it("skips the request entirely when no api key is available", async () => {
        const source = new DeepSeekModelSource()
        let calls = 0

        const models = await mockFetchForTesting(
            async () => {
                calls++
                return jsonResponse(listing("deepseek-chat"))
            },
            async () => source.fetchModels({}),
        )

        expect(calls).toBe(0)
        expect(models).toEqual({})
    })

    it("raises when the vendor answers with a non-success status", async () => {
        const source = new DeepSeekModelSource()

        await expect(
            mockFetchForTesting(
                async () => new Response("unauthorized", { status: 401 }),
                async () => source.fetchModels({ apiKey: "bad-key" }),
            ),
        ).rejects.toThrow(/401/)
    })
})
