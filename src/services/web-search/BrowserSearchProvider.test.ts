import { describe, expect, it, vi } from "vitest"
import { BingSearchProvider } from "./BingSearchProvider"
import type { BrowserSearchPageLoader } from "./BrowserSearchPageLoader"
import { DuckDuckGoSearchProvider } from "./DuckDuckGoSearchProvider"

function loader(html: string): BrowserSearchPageLoader {
    return { load: vi.fn(async () => html) }
}

describe("browser local search providers", () => {
    it("normalizes DuckDuckGo HTML results", async () => {
        const pageLoader = loader(`
			<div class="result">
				<a class="result__a" href="https://example.test/dline">Dline</a>
				<a class="result__snippet">DuckDuckGo summary</a>
			</div>
		`)
        const provider = new DuckDuckGoSearchProvider(pageLoader)

        await expect(provider.search({ query: "Dline search" })).resolves.toEqual({
            engineId: "duckduckgo",
            query: "Dline search",
            items: [{ title: "Dline", url: "https://example.test/dline", snippet: "DuckDuckGo summary" }],
        })
        expect(pageLoader.load).toHaveBeenCalledWith("https://html.duckduckgo.com/html/?q=Dline+search")
    })

    it("normalizes Bing HTML results", async () => {
        const pageLoader = loader(`
			<li class="b_algo">
				<h2><a href="https://example.test/dline">Dline</a></h2>
				<div class="b_caption"><p>Bing summary</p></div>
			</li>
		`)
        const provider = new BingSearchProvider(pageLoader)

        await expect(provider.search({ query: "Dline search" })).resolves.toEqual({
            engineId: "bing",
            query: "Dline search",
            items: [{ title: "Dline", url: "https://example.test/dline", snippet: "Bing summary" }],
        })
        expect(pageLoader.load).toHaveBeenCalledWith("https://www.bing.com/search?q=Dline+search")
    })

    it("reports the selected browser engine failure without trying another engine", async () => {
        const pageLoader: BrowserSearchPageLoader = {
            load: vi.fn(async () => {
                throw new Error("browser blocked")
            }),
        }
        const provider = new DuckDuckGoSearchProvider(pageLoader)

        await expect(provider.search({ query: "Dline" })).rejects.toThrow("DuckDuckGo search failed: browser blocked")
        expect(pageLoader.load).toHaveBeenCalledOnce()
    })
})
