import { allProviderModels } from "@core/api/providers/models/index"
import {
    OPENCODE_CONSOLE_CATALOG,
    OPENCODE_GO_CATALOG,
    type OpenCodeMode,
    QWEN_MAINLAND_CATALOG,
    resolveCatalogProviderKey,
    ZAI_MAINLAND_CATALOG,
} from "@shared/providers/provider-catalog-key"
import type { ProviderModelsConfig } from "@shared/providers/types"
import { describe, expect, it } from "vitest"

const registry = allProviderModels as Record<string, ProviderModelsConfig>

describe("resolveCatalogProviderKey", () => {
    it("keeps every provider without a catalog-selecting option on its own catalog", () => {
        for (const config of Object.values(registry)) {
            expect(resolveCatalogProviderKey({ provider: config.provider })).toBe(config.provider)
        }
    })

    it.each([
        [undefined, OPENCODE_CONSOLE_CATALOG],
        ["console", OPENCODE_CONSOLE_CATALOG],
        ["go", OPENCODE_GO_CATALOG],
    ] as const)("maps the OpenCode %s mode to its catalog", (mode: OpenCodeMode | undefined, expected: string) => {
        expect(resolveCatalogProviderKey({ provider: OPENCODE_CONSOLE_CATALOG, opencodeMode: mode })).toBe(expected)
    })

    it("resolves both OpenCode catalogs to catalogs the provider declares", () => {
        // A key that resolves to no catalog would surface as an empty model list
        // rather than as an error, so the registry is the oracle here.
        const consoleKey = resolveCatalogProviderKey({ provider: "opencode", opencodeMode: "console" })
        const goKey = resolveCatalogProviderKey({ provider: "opencode", opencodeMode: "go" })

        expect(registry[consoleKey]?.provider).toBe(OPENCODE_CONSOLE_CATALOG)
        const goCatalog = registry[OPENCODE_CONSOLE_CATALOG]?.catalogs?.[goKey]
        expect(goCatalog, "the Go catalog must be declared by the OpenCode provider").toBeDefined()
        expect(Object.keys(goCatalog?.models ?? {}).length).toBeGreaterThan(0)
        // A second selectable provider would expose the same models under its own
        // base URL, which is exactly what declaring the catalog avoids.
        expect(registry[goKey]).toBeUndefined()
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
