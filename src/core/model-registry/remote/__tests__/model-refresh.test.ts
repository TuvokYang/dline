import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { discoverProviderModels } from "../model-refresh"

const mocks = vi.hoisted(() => ({ registry: {}, fetchModels: vi.fn(), persist: vi.fn() }))
vi.mock("../../ModelRegistry", () => ({ ModelRegistry: { getInstance: () => mocks.registry } }))
vi.mock("../../provider-catalog-storage", () => ({ persistProviderCatalog: mocks.persist }))
vi.mock("../vendors", () => ({
    getModelSource: () => ({
        providerId: "opencode",
        providerName: "OpenCode",
        billingMode: "token",
        requiresApiKey: false,
        fetchModels: mocks.fetchModels,
    }),
}))

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(0)
    mocks.registry = {}
    mocks.fetchModels.mockReset().mockResolvedValue({ "model-a": { id: "model-a" } })
    mocks.persist.mockReset().mockResolvedValue(undefined)
})
afterEach(() => {
    vi.useRealTimers()
})

describe("remote catalog fetch TTL", () => {
    it("reuses one fetch for 30 minutes and fetches again exactly at expiry", async () => {
        expect(await discoverProviderModels("opencode-console", {})).toHaveProperty("model-a")
        vi.setSystemTime(30 * 60 * 1000 - 1)
        await discoverProviderModels("opencode-console", {})
        expect(mocks.fetchModels).toHaveBeenCalledTimes(1)
        mocks.fetchModels.mockResolvedValue({ "model-b": { id: "model-b" } })
        vi.setSystemTime(30 * 60 * 1000)
        expect(await discoverProviderModels("opencode-console", {})).toEqual({ "model-b": { id: "model-b" } })
        expect(mocks.fetchModels).toHaveBeenCalledTimes(2)
    })

    it("shares the in-flight fetch between preview and persist without losing persistence", async () => {
        let release!: (models: Record<string, { id: string }>) => void
        mocks.fetchModels.mockReturnValue(
            new Promise((resolve) => {
                release = resolve
            }),
        )
        const preview = discoverProviderModels("opencode-console", {})
        const persisted = discoverProviderModels("opencode-console", {}, { persist: true })
        release({ "model-a": { id: "model-a" } })
        await Promise.all([preview, persisted])
        expect(mocks.fetchModels).toHaveBeenCalledTimes(1)
        expect(mocks.persist).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                providerId: "opencode-console",
                models: { "model-a": { id: "model-a" } },
            }),
        )
        expect(await discoverProviderModels("opencode", {})).toHaveProperty("model-a")
        expect(mocks.fetchModels).toHaveBeenCalledTimes(1)
    })

    it("keeps Console and Go catalogs separate", async () => {
        await discoverProviderModels("opencode-console", {})
        await discoverProviderModels("opencode-go", {})
        expect(mocks.fetchModels.mock.calls.map(([context]) => context.catalogKey)).toEqual(["opencode-console", "opencode-go"])
    })

    it.each(["profileId", "baseUrl", "apiKey"])("does not reuse a catalog after %s changes", async (field) => {
        await discoverProviderModels("opencode-console", { [field]: "first" })
        await discoverProviderModels("opencode-console", { [field]: "second" })
        expect(mocks.fetchModels).toHaveBeenCalledTimes(2)
    })

    it("does not repeatedly fetch a failed listing inside the TTL and preserves each caller's error policy", async () => {
        mocks.fetchModels.mockRejectedValue(new Error("Listing unavailable"))
        await expect(discoverProviderModels("opencode-console", {}, { throwOnError: true })).rejects.toThrow(
            "Listing unavailable",
        )
        expect(await discoverProviderModels("opencode-console", {})).toEqual({})
        expect(mocks.fetchModels).toHaveBeenCalledTimes(1)
        vi.setSystemTime(30 * 60 * 1000)
        await discoverProviderModels("opencode-console", {})
        expect(mocks.fetchModels).toHaveBeenCalledTimes(2)
    })

    it("starts a new cache when the registry owner is replaced", async () => {
        await discoverProviderModels("opencode-console", {})
        mocks.registry = {}
        await discoverProviderModels("opencode-console", {})
        expect(mocks.fetchModels).toHaveBeenCalledTimes(2)
    })
})
