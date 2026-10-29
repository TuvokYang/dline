import * as cheerio from "cheerio"
import type { BrowserSearchPageLoader } from "./BrowserSearchPageLoader"
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

export abstract class BrowserHtmlSearchProvider implements LocalSearchProvider {
    abstract readonly descriptor: LocalSearchProvider["descriptor"]
    protected abstract readonly selectors: BrowserSearchSelectors

    constructor(private readonly pageLoader: BrowserSearchPageLoader) {}

    protected abstract buildSearchUrl(query: string): string

    protected transformResultUrl(url: string): string | undefined {
        return normalizeHttpUrl(url)
    }

    async search(request: LocalSearchRequest): Promise<LocalSearchResponse> {
        const query = request.query.trim()
        if (!query) {
            throw new Error(`${this.descriptor.label} search query must not be empty`)
        }

        try {
            const html = await this.pageLoader.load(this.buildSearchUrl(query))
            const $ = cheerio.load(html)
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
            return { engineId: this.descriptor.id, query, items }
        } catch (error) {
            throw new Error(`${this.descriptor.label} search failed: ${errorMessage(error)}`, { cause: error })
        }
    }
}
