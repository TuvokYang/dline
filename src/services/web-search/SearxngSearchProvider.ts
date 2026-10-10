import type { LocalSearchProvider, LocalSearchRequest, LocalSearchResponse, LocalSearchResultItem } from "./LocalSearchProvider"

interface SearxngResult {
    readonly title: string
    readonly url: string
    readonly content?: string
}

interface SearxngResponse {
    readonly results: readonly SearxngResult[]
}

export interface SearxngSearchProviderOptions {
    readonly baseUrl: string
    readonly apiToken?: string
    readonly fetchImpl?: typeof fetch
}

function parseResponse(value: unknown): SearxngResponse {
    if (!value || typeof value !== "object" || !("results" in value) || !Array.isArray(value.results)) {
        throw new Error("SearXNG search returned an invalid JSON response")
    }

    const results = value.results.flatMap((entry): SearxngResult[] => {
        if (!entry || typeof entry !== "object") {
            return []
        }
        const title = "title" in entry && typeof entry.title === "string" ? entry.title.trim() : ""
        const url = "url" in entry && typeof entry.url === "string" ? entry.url.trim() : ""
        if (!title || !url) {
            return []
        }
        const content = "content" in entry && typeof entry.content === "string" ? entry.content.trim() : undefined
        return [{ title, url, ...(content ? { content } : {}) }]
    })

    return { results }
}

function buildSearchUrl(baseUrl: string, query: string): string {
    const parsedBaseUrl = new URL(baseUrl)
    if (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:") {
        throw new Error("SearXNG URL must use HTTP or HTTPS")
    }
    const normalizedBaseUrl = new URL(parsedBaseUrl.toString())
    normalizedBaseUrl.pathname = `${normalizedBaseUrl.pathname.replace(/\/$/, "")}/search`
    normalizedBaseUrl.search = ""
    normalizedBaseUrl.hash = ""
    normalizedBaseUrl.searchParams.set("q", query)
    normalizedBaseUrl.searchParams.set("format", "json")
    return normalizedBaseUrl.toString()
}

export class SearxngSearchProvider implements LocalSearchProvider {
    readonly descriptor = {
        id: "searxng" as const,
        label: "SearXNG",
        execution: "dline" as const,
    }

    private readonly fetchImpl: typeof fetch

    constructor(private readonly options: SearxngSearchProviderOptions) {
        this.fetchImpl = options.fetchImpl ?? fetch
    }

    async search(request: LocalSearchRequest): Promise<LocalSearchResponse> {
        const query = request.query.trim()
        if (!query) {
            throw new Error("SearXNG search query must not be empty")
        }

        const headers: Record<string, string> = { Accept: "application/json" }
        if (this.options.apiToken) {
            headers.Authorization = `Bearer ${this.options.apiToken}`
        }

        const response = await this.fetchImpl(buildSearchUrl(this.options.baseUrl, query), { headers })
        if (!response.ok) {
            throw new Error(`SearXNG search failed with HTTP ${response.status}`)
        }

        let payload: unknown
        try {
            payload = await response.json()
        } catch (error) {
            throw new Error("SearXNG search returned invalid JSON", { cause: error })
        }
        const parsed = parseResponse(payload)
        const items: LocalSearchResultItem[] = parsed.results.map((result) => ({
            title: result.title,
            url: result.url,
            ...(result.content ? { snippet: result.content } : {}),
        }))

        return { engineId: "searxng", query, items }
    }
}
