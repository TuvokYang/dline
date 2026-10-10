import { BrowserHtmlSearchProvider } from "./BrowserHtmlSearchProvider"
import { type BrowserSearchPageLoader, PuppeteerBrowserSearchPageLoader } from "./BrowserSearchPageLoader"

function resolveDuckDuckGoUrl(value: string): string {
    try {
        const url = new URL(value, "https://html.duckduckgo.com")
        if (url.hostname.endsWith("duckduckgo.com")) {
            const target = url.searchParams.get("uddg")
            if (target) {
                return target
            }
        }
        return url.toString()
    } catch {
        return value
    }
}

export class DuckDuckGoSearchProvider extends BrowserHtmlSearchProvider {
    readonly descriptor = {
        id: "duckduckgo" as const,
        label: "Browser / DuckDuckGo",
        execution: "dline" as const,
    }
    protected readonly selectors = {
        result: ".result",
        link: ".result__a",
        snippet: ".result__snippet",
    }

    constructor(pageLoader: BrowserSearchPageLoader = new PuppeteerBrowserSearchPageLoader()) {
        super(pageLoader)
    }

    protected buildSearchUrl(query: string): string {
        const url = new URL("https://html.duckduckgo.com/html/")
        url.searchParams.set("q", query)
        return url.toString()
    }

    protected override transformResultUrl(url: string): string | undefined {
        return super.transformResultUrl(resolveDuckDuckGoUrl(url))
    }
}
