import { BingSearchProvider } from "./BingSearchProvider"
import { DuckDuckGoSearchProvider } from "./DuckDuckGoSearchProvider"
import {
    type LocalSearchEngineId,
    type LocalSearchProvider,
    type LocalSearchProviderDescriptor,
    LocalSearchRegistry,
} from "./LocalSearchProvider"
import { SearxngSearchProvider } from "./SearxngSearchProvider"

/** Read provider-owned metadata without creating browser or network clients. */
export function getLocalSearchProviderDescriptor(engineId: LocalSearchEngineId): LocalSearchProviderDescriptor {
    switch (engineId) {
        case "duckduckgo":
            return DuckDuckGoSearchProvider.descriptor
        case "bing":
            return BingSearchProvider.descriptor
        case "searxng":
            return SearxngSearchProvider.descriptor
    }
}

export interface LocalSearchRegistryOptions {
    readonly searxngSearchUrl?: string
    readonly searxngSearchToken?: string
}

export function createLocalSearchRegistry(options: LocalSearchRegistryOptions = {}): LocalSearchRegistry {
    const providers: LocalSearchProvider[] = [new DuckDuckGoSearchProvider(), new BingSearchProvider()]
    if (options.searxngSearchUrl) {
        providers.push(
            new SearxngSearchProvider({
                baseUrl: options.searxngSearchUrl,
                ...(options.searxngSearchToken ? { apiToken: options.searxngSearchToken } : {}),
            }),
        )
    }
    return new LocalSearchRegistry(providers)
}
