import { describe, expect, it } from "vitest"
import { mockFetchForTesting } from "@/shared/net"
import { ClineModelSource } from "../vendors/cline"

function listingResponse(): Response {
    return new Response(
        JSON.stringify({
            data: [
                {
                    id: "vendor/chat-model",
                    context_length: 32_000,
                    supported_parameters: ["tools"],
                    pricing: { prompt: "0.000001", completion: "0.000002" },
                },
            ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
    )
}

async function captureListingRequest(baseUrl?: string): Promise<{ url: string; headers: Headers }> {
    const requests: Array<{ url: string; headers: Headers }> = []
    const source = new ClineModelSource()

    const models = await mockFetchForTesting(
        async (input: RequestInfo | URL, init?: RequestInit) => {
            requests.push({ url: String(input), headers: new Headers(init?.headers) })
            return listingResponse()
        },
        () => source.fetchModels({ apiKey: "profile-secret", baseUrl }),
    )

    expect(Object.keys(models)).toEqual(["vendor/chat-model"])
    expect(requests).toHaveLength(1)
    return requests[0]
}

describe("ClineModelSource", () => {
    it("lists from the Cline Provider endpoint with the Profile credential", async () => {
        const request = await captureListingRequest()

        expect(request.url).toBe("https://api.cline.bot/api/v1/ai/cline/models")
        expect(request.headers.get("authorization")).toBe("Bearer profile-secret")
    })

    it("uses the Profile base URL for model discovery", async () => {
        const request = await captureListingRequest("https://proxy.example.test/cline///")

        expect(request.url).toBe("https://proxy.example.test/cline/api/v1/ai/cline/models")
    })
})
