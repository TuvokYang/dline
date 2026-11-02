import { allProviderModels } from "@core/api/providers/models/index"
import { getProviderLabel, PROVIDER_OPTIONS } from "@shared/providers/providers"
import type { ProviderModelsConfig } from "@shared/providers/types"
import { describe, expect, it } from "vitest"

const registry = allProviderModels as Record<string, ProviderModelsConfig>

function tierOf(providerId: string): string {
    return registry[providerId]?.tier ?? "standard"
}

describe("provider selector options", () => {
    it("derives every option from the model registry", () => {
        for (const option of PROVIDER_OPTIONS) {
            const config = registry[option.value]
            expect(config, `${option.value} must exist in the registry`).toBeDefined()
            expect(option.label).toBe(config.providerName)
        }
    })

    it("offers every registered provider exactly once", () => {
        const expected = Object.values(registry).map((config) => config.provider)

        expect([...PROVIDER_OPTIONS].map((option) => option.value as string).sort()).toEqual([...expected].sort())
    })

    // An alternative catalog belongs to the provider that serves it, so it can
    // never surface as a second selectable provider with its own base URL.
    it("offers alternative catalogs only through the provider that serves them", () => {
        const owners = Object.values(registry).filter((config) => Object.keys(config.catalogs ?? {}).length > 0)
        expect(owners.length).toBeGreaterThan(0)

        for (const owner of owners) {
            expect(PROVIDER_OPTIONS.some((option) => (option.value as string) === owner.provider)).toBe(true)
            for (const [catalogKey, catalog] of Object.entries(owner.catalogs ?? {})) {
                // Never selectable on its own, whatever it holds. A catalog whose
                // models come from a gateway listing starts empty by design.
                expect(PROVIDER_OPTIONS.some((option) => (option.value as string) === catalogKey)).toBe(false)
                expect(catalog.models).toBeDefined()
            }
        }
    })

    it("groups frontier providers first, then aggregators, then the rest", () => {
        const order = ["frontier", "aggregator", "standard"]
        const positions = PROVIDER_OPTIONS.map((option) => order.indexOf(tierOf(option.value)))

        expect(positions).toEqual([...positions].sort((left, right) => left - right))
    })

    it("orders frontier providers by their curated rank", () => {
        const ranks = PROVIDER_OPTIONS.filter((option) => tierOf(option.value) === "frontier").map(
            (option) => registry[option.value].frontierRank ?? Number.MAX_SAFE_INTEGER,
        )

        expect(ranks).toEqual([...ranks].sort((left, right) => left - right))
    })

    it("sorts the non-frontier groups alphabetically", () => {
        for (const tier of ["aggregator", "standard"]) {
            const labels = PROVIDER_OPTIONS.filter((option) => tierOf(option.value) === tier).map((option) => option.label)

            expect(labels, `${tier} group must be alphabetical`).toEqual(
                [...labels].sort((left, right) => left.localeCompare(right)),
            )
        }
    })
})

describe("getProviderLabel", () => {
    it("reads the display name from the registry", () => {
        expect(getProviderLabel("anthropic")).toBe(registry.anthropic.providerName)
    })

    it("falls back to the identifier for an unregistered provider", () => {
        expect(getProviderLabel("not-a-provider" as never)).toBe("not-a-provider")
    })
})
