export const LOCAL_SEARCH_ENGINE_IDS = ["duckduckgo", "bing", "searxng"] as const

export type LocalSearchEngineId = (typeof LOCAL_SEARCH_ENGINE_IDS)[number]

export const DEFAULT_LOCAL_SEARCH_ENGINE: LocalSearchEngineId = "duckduckgo"

export const LOCAL_SEARCH_ENGINE_LABELS: Readonly<Record<LocalSearchEngineId, string>> = {
    duckduckgo: "Browser / DuckDuckGo",
    bing: "Browser / Bing",
    searxng: "SearXNG",
}

export function isLocalSearchEngineId(value: string): value is LocalSearchEngineId {
    return LOCAL_SEARCH_ENGINE_IDS.some((engineId) => engineId === value)
}
