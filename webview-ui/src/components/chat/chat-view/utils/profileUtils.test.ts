import type { ApiConfiguration } from "@shared/api"
import { ApiProfile } from "@shared/proto/dline/profile"
import { describe, expect, it } from "vitest"
import { resolveActiveProfile, resolveTaskCurrency } from "./profileUtils"

describe("resolveActiveProfile", () => {
    it("prefers the mode profile name over stale usedFor metadata", () => {
        const staleProfile = ApiProfile.create({
            enabled: true,
            id: "profile-stale",
            modelId: "stale-model",
            name: "stale-profile",
            provider: "anthropic",
            usedFor: ["act"],
        })
        const selectedProfile = ApiProfile.create({
            enabled: true,
            id: "profile-selected",
            modelId: "deepseek-v4-pro",
            name: "deepseek-selected",
            provider: "deepseek",
            usedFor: [],
        })
        const apiConfiguration: ApiConfiguration = {
            actModeProfile: "deepseek-selected",
            planModeProfile: "stale-profile",
        }

        const result = resolveActiveProfile([staleProfile, selectedProfile], apiConfiguration, "act")

        expect(result?.id).to.equal("profile-selected")
    })
})

describe("resolveTaskCurrency", () => {
    it("uses the active profile currency before API metrics are available", () => {
        expect(resolveTaskCurrency(undefined, "CNY")).to.equal("CNY")
        expect(resolveTaskCurrency("", "CNY")).to.equal("CNY")
    })

    it("prefers the currency reported by API metrics", () => {
        expect(resolveTaskCurrency("USD", "CNY")).to.equal("USD")
    })
})
