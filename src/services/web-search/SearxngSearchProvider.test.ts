import { describe, expect, it, vi } from "vitest"
import { SearxngSearchProvider } from "./SearxngSearchProvider"

describe("SearxngSearchProvider", () => {
    it("normalizes JSON results and sends the optional token only to the configured instance", async () => {
        const fetchImpl = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({
                        results: [{ title: "Dline", url: "https://example.com/dline", content: "Search summary" }],
                    }),
                    { status: 200, headers: { "Content-Type": "application/json" } },
                ),
        )
        const provider = new SearxngSearchProvider({
            baseUrl: "https://search.example.test/",
            apiToken: "secret-token",
            fetchImpl,
        })

        await expect(provider.search({ query: "Dline" })).resolves.toEqual({
            engineId: "searxng",
            query: "Dline",
            items: [{ title: "Dline", url: "https://example.com/dline", snippet: "Search summary" }],
        })
        expect(fetchImpl).toHaveBeenCalledWith(
            "https://search.example.test/search?q=Dline&format=json",
            expect.objectContaining({ headers: { Authorization: "Bearer secret-token", Accept: "application/json" } }),
        )
    })

    it("reports the selected engine and HTTP status without falling back", async () => {
        const provider = new SearxngSearchProvider({
            baseUrl: "https://search.example.test",
            fetchImpl: vi.fn(async () => new Response("blocked", { status: 429 })),
        })

        await expect(provider.search({ query: "Dline" })).rejects.toThrow("SearXNG search failed with HTTP 429")
    })
})
