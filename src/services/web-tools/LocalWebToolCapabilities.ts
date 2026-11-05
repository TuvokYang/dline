import { DEFAULT_LOCAL_SEARCH_ENGINE, type LocalSearchEngineId } from "@shared/web-search"
import { BrowserWebFetchProvider, type LocalWebFetchProvider } from "../web-fetch/LocalWebFetchProvider"
import { getLocalSearchProviderDescriptor } from "../web-search/createLocalSearchRegistry"
import type { LocalSearchProviderDescriptor } from "../web-search/LocalSearchProvider"

/** Prompt assembly consumes capabilities declared by the selected local executors. */
export interface LocalWebToolCapabilities {
    readonly search: Pick<LocalSearchProviderDescriptor, "supportsPrompt">
    readonly fetch: Pick<LocalWebFetchProvider, "supportsPrompt">
}

/** Read metadata only; no executor is instantiated and no retrieval is performed. */
export function resolveLocalWebToolCapabilities(
    searchEngine: LocalSearchEngineId = DEFAULT_LOCAL_SEARCH_ENGINE,
): LocalWebToolCapabilities {
    return {
        search: getLocalSearchProviderDescriptor(searchEngine),
        fetch: { supportsPrompt: BrowserWebFetchProvider.supportsPrompt },
    }
}
