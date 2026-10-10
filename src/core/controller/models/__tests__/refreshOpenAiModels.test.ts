import { OpenAiModelsRequest } from "@shared/proto/dline/models"
import { describe, expect, it } from "vitest"
import { mockFetchForTesting } from "@/shared/net"
import type { Controller } from "../.."
import { refreshOpenAiModels } from "../refreshOpenAiModels"

interface CapturedRequest {
    url: string
    headers: Headers
}

async function captureListingRequest(
    request: OpenAiModelsRequest,
    body: unknown = { data: [{ id: "gpt-e2e" }] },
): Promise<{ captured: CapturedRequest[]; values: string[] }> {
    const captured: CapturedRequest[] = []

    const response = await mockFetchForTesting(
        async (input: RequestInfo | URL, init?: RequestInit) => {
            captured.push({ url: String(input), headers: new Headers(init?.headers) })
            return new Response(JSON.stringify(body), {
                status: 200,
                headers: { "content-type": "application/json" },
            })
        },
        async () => refreshOpenAiModels({} as Controller, request),
    )

    return { captured, values: response.values }
}

describe("refreshOpenAiModels", () => {
    it("requests baseUrl/v1/models when the configured URL has no API version", async () => {
        const { captured } = await captureListingRequest(
            OpenAiModelsRequest.create({ baseUrl: "https://gateway.example.test", apiKey: "secret" }),
        )

        expect(captured).toHaveLength(1)
        expect(captured[0].url).toBe("https://gateway.example.test/v1/models")
        expect(captured[0].headers.get("authorization")).toBe("Bearer secret")
    })

    it("does not duplicate v1 when the configured URL already includes it", async () => {
        const { captured } = await captureListingRequest(
            OpenAiModelsRequest.create({ baseUrl: "https://gateway.example.test/v1/", apiKey: "secret" }),
        )

        expect(captured).toHaveLength(1)
        expect(captured[0].url).toBe("https://gateway.example.test/v1/models")
    })

    it("returns the listed model ids", async () => {
        const { values } = await captureListingRequest(
            OpenAiModelsRequest.create({ baseUrl: "https://gateway.example.test", apiKey: "secret" }),
            { data: [{ id: "gpt-e2e" }, { id: "gpt-other" }] },
        )

        expect(values).toEqual(["gpt-e2e", "gpt-other"])
    })

    it("lists an unauthenticated gateway without sending an authorization header", async () => {
        const { captured, values } = await captureListingRequest(
            OpenAiModelsRequest.create({ baseUrl: "https://gateway.example.test" }),
        )

        expect(captured[0].headers.get("authorization")).toBeNull()
        expect(values).toEqual(["gpt-e2e"])
    })

    it("returns nothing when no base URL is configured", async () => {
        const { captured, values } = await captureListingRequest(OpenAiModelsRequest.create({ apiKey: "secret" }))

        expect(captured).toHaveLength(0)
        expect(values).toEqual([])
    })

    it("returns nothing when the gateway rejects the request", async () => {
        const captured: CapturedRequest[] = []

        const response = await mockFetchForTesting(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                captured.push({ url: String(input), headers: new Headers(init?.headers) })
                return new Response("unauthorized", { status: 401 })
            },
            async () =>
                refreshOpenAiModels(
                    {} as Controller,
                    OpenAiModelsRequest.create({ baseUrl: "https://gateway.example.test", apiKey: "bad" }),
                ),
        )

        expect(captured).toHaveLength(1)
        expect(response.values).toEqual([])
    })
})
