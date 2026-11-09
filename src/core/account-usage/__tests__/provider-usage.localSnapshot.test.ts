import { ApiProfile } from "@shared/proto/dline/profile"
import { describe, expect, it } from "vitest"
import { decorateProviderAccountUsage } from "../provider-usage"

const profile = ApiProfile.create({ id: "profile-a", provider: "deepseek" })

describe("provider account usage projection", () => {
    it("preserves the provider's local snapshot and balance", () => {
        const local = { inputTokens: 900, outputTokens: 100, usageReported: true }
        const usage = decorateProviderAccountUsage(profile, { currency: "CNY", remainingBalance: 12.5, local })

        expect(usage?.local).toBe(local)
        expect(usage?.remainingBalance).toBe(12.5)
        expect(usage?.dailyInputTokens).toBeUndefined()
    })

    it("does not add a local snapshot to a provider response", () => {
        const usage = decorateProviderAccountUsage(profile, { currency: "CNY", remainingBalance: 12.5 })

        expect(usage?.local).toBeUndefined()
    })

    it("does not construct account usage without a provider response", () => {
        expect(decorateProviderAccountUsage(profile, undefined)).toBeUndefined()
    })
})
