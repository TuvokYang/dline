import * as cheerio from "cheerio"
import type { BrowserSearchPage, BrowserSearchPageLoader } from "./BrowserSearchPageLoader"
import type { LocalSearchProvider, LocalSearchRequest, LocalSearchResponse, LocalSearchResultItem } from "./LocalSearchProvider"

export interface BrowserSearchSelectors {
    readonly result: string
    readonly link: string
    readonly snippet: string
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function normalizeHttpUrl(value: string): string | undefined {
    try {
        const url = new URL(value)
        return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined
    } catch {
        return undefined
    }
}

function describeStatus(status: number): string {
    return status > 0 ? `HTTP ${status}` : "no HTTP status"
}

export abstract class BrowserHtmlSearchProvider implements LocalSearchProvider {
    abstract readonly descriptor: LocalSearchProvider["descriptor"]
    protected abstract readonly selectors: BrowserSearchSelectors

    constructor(private readonly pageLoader: BrowserSearchPageLoader) {}

    protected abstract buildSearchUrl(query: string): string

    protected transformResultUrl(url: string): string | undefined {
        return normalizeHttpUrl(url)
    }

    /**
     * Why the page is a refusal rather than an answer, or `undefined` when the
     * page is a real (possibly empty) result list.
     *
     * Only consulted when the page yields no result rows, so a rendered result
     * list is never rejected. Subclasses add the markers their engine serves to
     * a refused client; the base implementation covers statuses every engine
     * uses for that.
     */
    protected detectRefusal(page: BrowserSearchPage): string | undefined {
        if (page.status === 429) return `the engine rate-limited this client (${describeStatus(page.status)})`
        if (page.status === 403) return `the engine rejected this client (${describeStatus(page.status)})`
        return undefined
    }

    async search(request: LocalSearchRequest): Promise<LocalSearchResponse> {
        const query = request.query.trim()
        if (!query) {
            throw new Error(`${this.descriptor.label} search query must not be empty`)
        }

        try {
            const page = await this.pageLoader.load(this.buildSearchUrl(query))
            const $ = cheerio.load(page.html)
            const items: LocalSearchResultItem[] = []
            $(this.selectors.result).each((_index, element) => {
                const result = $(element)
                const link = result.find(this.selectors.link).first()
                const title = link.text().replace(/\s+/g, " ").trim()
                const rawUrl = link.attr("href")?.trim() ?? ""
                const url = this.transformResultUrl(rawUrl)
                if (!title || !url) {
                    return
                }
                const snippet = result.find(this.selectors.snippet).first().text().replace(/\s+/g, " ").trim()
                items.push({ title, url, ...(snippet ? { snippet } : {}) })
            })
            if (items.length === 0) {
                // A refused client is not a query without matches. Reporting it as
                // an empty result set hides an actionable failure from the caller.
                const refusal = this.detectRefusal(page)
                if (refusal) {
                    throw new Error(`refused by the engine: ${refusal}`)
                }
            }
            return { engineId: this.descriptor.id, query, items }
        } catch (error) {
            throw new Error(`${this.descriptor.label} search failed: ${errorMessage(error)}`, { cause: error })
        }
    }
}
