import type { AccountUsage } from "@core/api"
import { ApiProfile } from "@shared/proto/dline/profile"
import { describe, expect, it } from "vitest"
import { decorateProviderAccountUsage } from "../provider-usage"

describe("provider daily token readings", () => {
    const profile = ApiProfile.create({ id: "subscription-a", provider: "claude-code" })

    it.each([
        { currency: "USD", planType: "pro" },
        { currency: "USD", planType: "pro", dailyInputTokens: 0, dailyOutputTokens: 0 },
        { currency: "USD", dailyInputTokens: 42 },
        { currency: "USD", dailyOutputTokens: 7 },
    ])("preserves the exact metrics reported by the provider: %j", (reported: AccountUsage) => {
        const usage = decorateProviderAccountUsage(profile, reported)

        expect(usage?.dailyInputTokens).toBe(reported.dailyInputTokens)
        expect(usage?.dailyOutputTokens).toBe(reported.dailyOutputTokens)
        expect(usage?.local).toBeUndefined()
    })
})
