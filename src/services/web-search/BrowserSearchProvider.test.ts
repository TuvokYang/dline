import { describe, expect, it, vi } from "vitest"
import { BingSearchProvider } from "./BingSearchProvider"
import type { BrowserSearchPage, BrowserSearchPageLoader } from "./BrowserSearchPageLoader"
import { DuckDuckGoSearchProvider } from "./DuckDuckGoSearchProvider"

function loader(html: string, status = 200): BrowserSearchPageLoader {
    return { load: vi.fn(async (): Promise<BrowserSearchPage> => ({ html, status })) }
}

/** The anomaly document DuckDuckGo serves to a refused client: HTTP 202, no result rows. */
const DUCKDUCKGO_CHALLENGE_HTML = `
	<html><body>
		<form id="challenge-form" action="//duckduckgo.com/anomaly.js?sv=html&cc=botnet&gk=d4cd0dab" method="POST"></form>
		<p class="feedback-instructions">error-lite+4458@duckduckgo.com</p>
		<label class="feedback-instructions">Code: 4458</label>
	</body></html>
`

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

    it("reports the DuckDuckGo bot challenge instead of an empty result set", async () => {
        const provider = new DuckDuckGoSearchProvider(loader(DUCKDUCKGO_CHALLENGE_HTML, 202))

        await expect(provider.search({ query: "Dline" })).rejects.toThrow(
            /bot challenge instead of results \(HTTP 202\).*Select another local search engine/,
        )
    })

    it("keeps a genuinely empty result page as a successful empty search", async () => {
        const provider = new DuckDuckGoSearchProvider(loader("<html><body><p>No results found</p></body></html>"))

        await expect(provider.search({ query: "Dline" })).resolves.toEqual({
            engineId: "duckduckgo",
            query: "Dline",
            items: [],
        })
    })

    it("reports a rate-limited response as a refusal rather than an empty search", async () => {
        const provider = new BingSearchProvider(loader("<html><body></body></html>", 429))

        await expect(provider.search({ query: "Dline" })).rejects.toThrow(/rate-limited this client \(HTTP 429\)/)
    })
})
