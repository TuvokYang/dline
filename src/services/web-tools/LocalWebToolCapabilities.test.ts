import { LOCAL_SEARCH_ENGINE_IDS } from "@shared/web-search"
import { describe, expect, it } from "vitest"
import { BrowserWebFetchProvider } from "../web-fetch/LocalWebFetchProvider"
import { createLocalSearchRegistry, getLocalSearchProviderDescriptor } from "../web-search/createLocalSearchRegistry"
import { resolveLocalWebToolCapabilities } from "./LocalWebToolCapabilities"

describe("local Web tool capabilities", () => {
    it.each(LOCAL_SEARCH_ENGINE_IDS)("keeps %s retrieval-only in metadata and the runtime registry", (engineId) => {
        const registry = createLocalSearchRegistry({ searxngSearchUrl: "https://search.example.test" })
        expect(getLocalSearchProviderDescriptor(engineId).supportsPrompt).toBe(false)
        expect(registry.list().find((entry) => entry.id === engineId)?.supportsPrompt).toBe(false)
        const capabilities = resolveLocalWebToolCapabilities(engineId)
        expect(capabilities.search).toMatchObject({ id: engineId, supportsPrompt: false })
        expect(capabilities.fetch.supportsPrompt).toBe(false)
    })

    it("keeps the browser fetch executor retrieval-only", () => {
        expect(new BrowserWebFetchProvider().supportsPrompt).toBe(false)
    })
})
