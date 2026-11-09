import { allProviderModels } from "@core/api/providers/models/index"
import {
    OPENCODE_CONSOLE_CATALOG,
    OPENCODE_GO_CATALOG,
    type OpenCodeMode,
    QWEN_MAINLAND_CATALOG,
    resolveCatalogProviderKey,
    resolvePrimaryCatalogKey,
    ZAI_MAINLAND_CATALOG,
} from "@shared/providers/provider-catalog-key"
import type { ProviderModelsConfig } from "@shared/providers/types"
import { describe, expect, it } from "vitest"

const registry = allProviderModels as Record<string, ProviderModelsConfig>

describe("resolveCatalogProviderKey", () => {
    it("keeps every provider without a catalog-selecting option on its primary catalog", () => {
        for (const config of Object.values(registry)) {
            expect(resolveCatalogProviderKey({ provider: config.provider })).toBe(resolvePrimaryCatalogKey(config.provider))
        }
    })

    it.each([
        [undefined, OPENCODE_CONSOLE_CATALOG],
        ["console", OPENCODE_CONSOLE_CATALOG],
        ["go", OPENCODE_GO_CATALOG],
    ] as const)("maps the OpenCode %s mode to its catalog", (mode: OpenCodeMode | undefined, expected: string) => {
        expect(resolveCatalogProviderKey({ provider: "opencode", opencodeMode: mode })).toBe(expected)
    })

    it("resolves both OpenCode catalogs to catalogs the provider declares", () => {
        // A key that resolves to no catalog would surface as an empty model list
        // rather than as an error, so the registry is the oracle here. The stored
        // provider identity stays "opencode"; only the catalog keys carry the plan.
        const consoleKey = resolveCatalogProviderKey({ provider: "opencode", opencodeMode: "console" })
        const goKey = resolveCatalogProviderKey({ provider: "opencode", opencodeMode: "go" })

        expect(consoleKey).toBe(OPENCODE_CONSOLE_CATALOG)
        expect(registry.opencode?.catalogs?.[goKey], "the Go catalog must be declared by the OpenCode provider").toBeDefined()
        // The Console catalog is the provider's own one, so the seed keeps it at the
        // top level rather than duplicating it under `catalogs`.
        expect(registry.opencode?.models, "the Console catalog must carry the built-in models").toBeDefined()
        // A second selectable provider would expose the same models under its own
        // base URL, which is exactly what declaring the catalog avoids.
        expect(registry[goKey]).toBeUndefined()
        expect(registry[consoleKey]).toBeUndefined()
    })

    it("maps a regional endpoint to the catalog that endpoint serves", () => {
        expect(resolveCatalogProviderKey({ provider: "qwen" })).toBe("qwen")
        expect(resolveCatalogProviderKey({ provider: "qwen", region: "mainland" })).toBe(QWEN_MAINLAND_CATALOG)
        expect(resolveCatalogProviderKey({ provider: "zai", region: "mainland" })).toBe(ZAI_MAINLAND_CATALOG)

        for (const [provider, catalogKey] of [
            ["qwen", QWEN_MAINLAND_CATALOG],
            ["zai", ZAI_MAINLAND_CATALOG],
        ] as const) {
            expect(registry[catalogKey], `${catalogKey} must not be a selectable provider`).toBeUndefined()
            expect(registry[provider]?.catalogs?.[catalogKey], `${catalogKey} must be declared`).toBeDefined()
        }
    })

    it("ignores a mode name it does not know instead of inventing a catalog", () => {
        // An unrecognized stored value can only come from data this build did not
        // write. Falling back keeps the Profile usable; guessing a third catalog
        // would resolve to a key nothing registers.
        expect(resolveCatalogProviderKey({ provider: "opencode", opencodeMode: "team" as unknown as OpenCodeMode })).toBe(
            OPENCODE_CONSOLE_CATALOG,
        )
    })
})

describe("resolvePrimaryCatalogKey", () => {
    it("answers with the provider id for a provider whose catalog is keyed by it", () => {
        expect(resolvePrimaryCatalogKey("qwen")).toBe("qwen")
        expect(resolvePrimaryCatalogKey("zai")).toBe("zai")
        expect(resolvePrimaryCatalogKey("anthropic")).toBe("anthropic")
    })

    it("answers with the declared primary catalog key for OpenCode", () => {
        // The provider identity and its default catalog are two different facts: a
        // Profile stores the identity, while the registry stores the catalog.
        expect(resolvePrimaryCatalogKey("opencode")).toBe(OPENCODE_CONSOLE_CATALOG)
        expect(resolvePrimaryCatalogKey("opencode-console")).toBe(OPENCODE_CONSOLE_CATALOG)
    })

    it("keeps a catalog key that is already a catalog key", () => {
        expect(resolvePrimaryCatalogKey(OPENCODE_GO_CATALOG)).toBe(OPENCODE_GO_CATALOG)
        expect(resolvePrimaryCatalogKey(QWEN_MAINLAND_CATALOG)).toBe(QWEN_MAINLAND_CATALOG)
    })
})
