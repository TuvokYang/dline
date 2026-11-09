import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ApiHandler } from "@core/api/ApiHandler"
import type { Controller } from "@core/controller"
import { ModelRegistry } from "@core/model-registry/ModelRegistry"
import { resetAllStores } from "@core/storage/secrets"
import { ModelPricing, PricingDayRule } from "@shared/proto/dline/models/metadata"
import { ApiProfile } from "@shared/proto/dline/profile"
import { flatMeteredPricing } from "@shared/providers/pricing-shape"
import { resolveProfileModelInfo, resolveProfileOverrides } from "@shared/providers/profile-model-info"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readApiProfiles, writeApiProfilesToFile } from "../getApiProfiles"
import { updateApiProfiles } from "../updateApiProfiles"

// Exercise real catalog transactions and disk round-trips, not OS watch events.
// The runtime singleton has no disposal port; use its existing watch option so
// temporary-directory cleanup cannot leave a live Windows watcher behind.
vi.mock("@core/profiles/ProfileCatalogRepository", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@core/profiles/ProfileCatalogRepository")>()
    return {
        ...actual,
        ProfileCatalogRepository: class extends actual.ProfileCatalogRepository {
            constructor(options: import("@core/profiles/ProfileCatalogRepository").ProfileCatalogRepositoryOptions) {
                super({ ...options, watch: false })
            }
        },
    }
})

const { calculateUsageCost } = ApiHandler
const catalog = { "pricing-test-model": { id: "pricing-test-model", pricing: flatMeteredPricing(1, 2) } }
const contextPricing: ModelPricing = {
    currency: "USD",
    strategy: {
        contextWindow: {
            bands: [
                { maxInputTokens: 100, prices: { inputPrice: 3, outputPrice: 4 } },
                { prices: { inputPrice: 5, outputPrice: 6, cacheReadPrice: 0 } },
            ],
        },
    },
}
const timePricing: ModelPricing = {
    currency: "CNY",
    strategy: {
        timeOfDay: {
            schedule: {
                timezoneOffsetMinutes: 480,
                dayRule: PricingDayRule.PRICING_DAY_RULE_ALL_DAYS,
                defaultOnPublicHolidays: false,
                holidayCalendar: "",
            },
            defaultPrices: { inputPrice: 7, outputPrice: 8 },
            timeWindows: [
                { startMinute: 540, endMinute: 720, bands: { bands: [{ prices: { inputPrice: 9, outputPrice: 10 } }] } },
            ],
        },
    },
}
const protoJson = (pricing: ModelPricing | undefined) => (pricing ? ModelPricing.toJSON(pricing) : undefined)
function configured(profile: ApiProfile, pricing: ModelPricing | undefined): ApiProfile {
    return ApiProfile.create({ ...profile, [profile.provider]: { pricing } })
}

let temp: string
let controller: Controller
const filePath = () => path.join(process.env.DLINE_DIR!, "data", "settings", "api_profiles.json")
beforeEach(async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "dline-profile-pricing-"))
    vi.stubEnv("DLINE_DIR", path.join(temp, "state"))
    vi.stubEnv("DLINE_HOME_DIR", path.join(temp, "home"))
    vi.stubEnv("DLINE_DOCS_DIR", path.join(temp, "docs"))
    ;(ModelRegistry as unknown as { instance?: ModelRegistry }).instance = undefined
    resetAllStores()
    controller = { postStateToWebview: vi.fn().mockResolvedValue(undefined) } as unknown as Controller
})
afterEach(async () => {
    resetAllStores()
    ;(ModelRegistry as unknown as { instance?: ModelRegistry }).instance = undefined
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const save = (profiles: ApiProfile[]) => updateApiProfiles(controller, { profiles, clearApiKeyProfileIds: [] })
const profile = (provider: string, id = "edited") =>
    ApiProfile.create({ id, provider, name: id, modelId: "pricing-test-model", enabled: true })

it("upgrades legacy envelopes on disk once and writes only canonical prices on reopen", async () => {
    const legacyPricing = { metered: { currency: "CNY", strategy: timePricing.strategy } }
    const original = ApiProfile.toJSON(profile("deepseek")) as Record<string, unknown>
    await fs.mkdir(path.dirname(filePath()), { recursive: true })
    await fs.writeFile(
        filePath(),
        JSON.stringify([{ ...original, schemaVersion: 4, deepseek: { pricing: ModelPricing.toJSON(legacyPricing) } }]),
    )
    const restored = readApiProfiles()[0]
    expect(protoJson(resolveProfileOverrides(restored).pricing)).toEqual(protoJson(timePricing))
    await writeApiProfilesToFile(filePath(), [restored])
    const stored = JSON.parse(await fs.readFile(filePath(), "utf8"))[0]
    expect(stored.deepseek.pricing.currency).toBe("CNY")
    expect(stored.deepseek.pricing).not.toHaveProperty("metered")
    expect(stored.deepseek.pricing).not.toHaveProperty("subscription")
    expect(stored.deepseek.pricing).not.toHaveProperty("free")
    const beforeReopen = await fs.readFile(filePath(), "utf8")
    expect(protoJson(resolveProfileOverrides(readApiProfiles()[0]).pricing)).toEqual(protoJson(timePricing))
    await writeApiProfilesToFile(filePath(), readApiProfiles())
    expect(await fs.readFile(filePath(), "utf8")).toBe(beforeReopen)
})

describe.each(["openai", "anthropic", "deepseek"])("%s Profile-owned pricing persistence", (provider) => {
    it("round-trips full strategies, replaces oneofs, isolates other Profiles and resets to inheritance", async () => {
        const other = profile(provider, "untouched")
        await save([configured(profile(provider), contextPricing), other])
        let restored = readApiProfiles().find((entry) => entry.id === "edited")!
        expect(protoJson(resolveProfileOverrides(restored).pricing)).toEqual(protoJson(contextPricing))
        let info = resolveProfileModelInfo(restored, { models: catalog })
        expect(calculateUsageCost(info.pricing, { inputTokens: 101, outputTokens: 0 }, 0)).toEqual({
            kind: "calculated",
            amount: 505 / 1_000_000,
            currency: "USD",
        })

        await save([configured(restored, timePricing), other])
        restored = readApiProfiles().find((entry) => entry.id === "edited")!
        expect(protoJson(resolveProfileOverrides(restored).pricing)).toEqual(protoJson(timePricing))
        expect(resolveProfileOverrides(restored).pricing?.strategy?.contextWindow).toBeUndefined()
        info = resolveProfileModelInfo(restored, { models: catalog })
        expect(
            calculateUsageCost(info.pricing, { inputTokens: 1_000_000, outputTokens: 0 }, Date.parse("2026-11-03T01:00:00Z")),
        ).toEqual({ kind: "calculated", amount: 9, currency: "CNY" })
        expect(resolveProfileOverrides(readApiProfiles().find((entry) => entry.id === "untouched")!).pricing).toBeUndefined()

        await save([configured(restored, undefined), other])
        restored = readApiProfiles().find((entry) => entry.id === "edited")!
        expect(resolveProfileOverrides(restored).pricing).toBeUndefined()
        expect(resolveProfileModelInfo(restored, { models: catalog }).pricing).toEqual(catalog["pricing-test-model"].pricing)
    })
})

describe("pricing save validation", () => {
    it("rejects an edited invalid declaration before changing disk, then accepts a corrected zero price", async () => {
        const original = configured(profile("openai"), contextPricing)
        await save([original])
        const before = await fs.readFile(filePath(), "utf8")
        const invalid = structuredClone(contextPricing)
        invalid.strategy!.flat = { prices: { inputPrice: 0, outputPrice: 0 } }
        await expect(save([configured(original, invalid)])).rejects.toBeInstanceOf(Error)
        expect(await fs.readFile(filePath(), "utf8")).toBe(before)
        await save([configured(original, flatMeteredPricing(0, 0))])
        expect(resolveProfileOverrides(readApiProfiles()[0]).pricing?.strategy?.flat?.prices?.inputPrice).toBe(0)
    })

    it("does not block unrelated edits on an unchanged legacy declaration and allows Reset", async () => {
        const legacy = configured(profile("anthropic"), {
            currency: "USD",
            strategy: { contextWindow: { bands: [{ maxInputTokens: 100, prices: { inputPrice: 1, outputPrice: 2 } }] } },
        })
        await fs.mkdir(path.dirname(filePath()), { recursive: true })
        await writeApiProfilesToFile(filePath(), [legacy])
        const restored = readApiProfiles()[0]
        await save([{ ...restored, name: "Renamed without editing pricing" }])
        expect(protoJson(resolveProfileOverrides(readApiProfiles()[0]).pricing)).toEqual(protoJson(legacy.anthropic?.pricing))
        await save([configured(readApiProfiles()[0], undefined)])
        expect(resolveProfileOverrides(readApiProfiles()[0]).pricing).toBeUndefined()
    })
})
