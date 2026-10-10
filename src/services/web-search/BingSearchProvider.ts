import { BrowserHtmlSearchProvider } from "./BrowserHtmlSearchProvider"
import { type BrowserSearchPageLoader, PuppeteerBrowserSearchPageLoader } from "./BrowserSearchPageLoader"

export class BingSearchProvider extends BrowserHtmlSearchProvider {
    readonly descriptor = {
        id: "bing" as const,
        label: "Browser / Bing",
        execution: "dline" as const,
    }
    protected readonly selectors = {
        result: "li.b_algo",
        link: "h2 a",
        snippet: ".b_caption p",
    }

    constructor(pageLoader: BrowserSearchPageLoader = new PuppeteerBrowserSearchPageLoader()) {
        super(pageLoader)
    }

    protected buildSearchUrl(query: string): string {
        const url = new URL("https://www.bing.com/search")
        url.searchParams.set("q", query)
        return url.toString()
    }
}
