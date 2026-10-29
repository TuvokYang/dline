import type { LocalSearchEngineId } from "@shared/web-search"

export { DEFAULT_LOCAL_SEARCH_ENGINE, LOCAL_SEARCH_ENGINE_IDS, type LocalSearchEngineId } from "@shared/web-search"

export interface LocalSearchProviderDescriptor {
    readonly id: LocalSearchEngineId
    readonly label: string
    readonly execution: "dline"
}

export interface LocalSearchRequest {
    readonly query: string
}

export interface LocalSearchResultItem {
    readonly title: string
    readonly url: string
    readonly snippet?: string
}

export interface LocalSearchResponse {
    readonly engineId: LocalSearchEngineId
    readonly query: string
    readonly items: readonly LocalSearchResultItem[]
}

export interface LocalSearchProvider {
    readonly descriptor: LocalSearchProviderDescriptor
    search(request: LocalSearchRequest): Promise<LocalSearchResponse>
}

/** Resolve one explicitly selected local search engine without hidden fallback. */
export class LocalSearchRegistry {
    private readonly providers: ReadonlyMap<LocalSearchEngineId, LocalSearchProvider>

    constructor(providers: readonly LocalSearchProvider[]) {
        const entries = providers.map((provider) => [provider.descriptor.id, provider] as const)
        this.providers = new Map(entries)
    }

    list(): readonly LocalSearchProviderDescriptor[] {
        return Array.from(this.providers.values(), (provider) => provider.descriptor)
    }

    async search(engineId: LocalSearchEngineId, request: LocalSearchRequest): Promise<LocalSearchResponse> {
        const provider = this.providers.get(engineId)
        if (!provider) {
            throw new Error(`Local web search engine "${engineId}" is not configured`)
        }
        return provider.search(request)
    }
}
