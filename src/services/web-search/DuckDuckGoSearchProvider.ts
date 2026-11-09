import { BrowserHtmlSearchProvider } from "./BrowserHtmlSearchProvider"
import { type BrowserSearchPage, type BrowserSearchPageLoader, PuppeteerBrowserSearchPageLoader } from "./BrowserSearchPageLoader"

/**
 * Markers DuckDuckGo serves instead of a result list when it refuses the client.
 *
 * The refused response is not an HTTP error: DuckDuckGo answers HTTP 202 with an
 * anomaly document whose form posts to `anomaly.js` and whose id is
 * `challenge-form`. Neither marker can appear on a real result page.
 */
const REFUSAL_MARKERS = ["anomaly.js", 'id="challenge-form"'] as const

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
    static readonly descriptor = {
        id: "duckduckgo" as const,
        label: "Browser / DuckDuckGo",
        execution: "dline" as const,
        supportsPrompt: false,
    }
    readonly descriptor = DuckDuckGoSearchProvider.descriptor
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

    protected override detectRefusal(page: BrowserSearchPage): string | undefined {
        const statusRefusal = super.detectRefusal(page)
        if (statusRefusal) return statusRefusal
        if (REFUSAL_MARKERS.some((marker) => page.html.includes(marker))) {
            const status = page.status > 0 ? `HTTP ${page.status}` : "no HTTP status"
            return `DuckDuckGo answered with its bot challenge instead of results (${status}); its HTML endpoint refused this client. Select another local search engine in settings.`
        }
        return undefined
    }
}
