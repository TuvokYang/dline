import { BingSearchProvider } from "./BingSearchProvider"
import { DuckDuckGoSearchProvider } from "./DuckDuckGoSearchProvider"
import { type LocalSearchProvider, LocalSearchRegistry } from "./LocalSearchProvider"
import { SearxngSearchProvider } from "./SearxngSearchProvider"

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
