import { describe, expect, it, vi } from "vitest"
import {
    DEFAULT_LOCAL_SEARCH_ENGINE,
    type LocalSearchProvider,
    LocalSearchRegistry,
    type LocalSearchRequest,
} from "./LocalSearchProvider"

function provider(id: "duckduckgo" | "bing" | "searxng"): LocalSearchProvider {
    return {
        descriptor: { id, label: id, execution: "dline" },
        search: vi.fn(async (request: LocalSearchRequest) => ({
            engineId: id,
            query: request.query,
            items: [{ title: `${id} result`, url: `https://example.com/${id}` }],
        })),
    }
}

describe("LocalSearchRegistry", () => {
    it("defaults to DuckDuckGo and exposes no Cline Cloud engine", () => {
        const registry = new LocalSearchRegistry([provider("duckduckgo"), provider("bing"), provider("searxng")])

        expect(DEFAULT_LOCAL_SEARCH_ENGINE).toBe("duckduckgo")
        expect(registry.list().map((entry) => entry.id)).toEqual(["duckduckgo", "bing", "searxng"])
        expect(registry.list().some((entry) => entry.id.includes("cline"))).toBe(false)
    })

    it("executes only the explicitly selected engine without fallback", async () => {
        const duckduckgo = provider("duckduckgo")
        const bing = provider("bing")
        const registry = new LocalSearchRegistry([duckduckgo, bing, provider("searxng")])

        await expect(registry.search("bing", { query: "Dline" })).resolves.toMatchObject({
            engineId: "bing",
            query: "Dline",
        })
        expect(bing.search).toHaveBeenCalledOnce()
        expect(duckduckgo.search).not.toHaveBeenCalled()
    })

    it("rejects an unknown engine instead of silently changing the destination", async () => {
        const registry = new LocalSearchRegistry([provider("duckduckgo")])

        await expect(registry.search("unknown" as "duckduckgo", { query: "Dline" })).rejects.toThrow(
            'Local web search engine "unknown" is not configured',
        )
    })
})
