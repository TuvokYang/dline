import type { AccountUsage } from "@core/api"
import { describe, expect, it } from "vitest"
import { applyLocalDailyTokens } from "../provider-usage"

/**
 * The regression this guards: a provider that reported a defined zero for the
 * day made the local ledger's real totals invisible, so the usage panel showed
 * "Today In: 0 / Today Out: 0" while Dline had clearly sent requests.
 */
const LEDGER = { inputTokens: 1_500, outputTokens: 80 }

function subscriptionUsage(overrides: Partial<AccountUsage> = {}): AccountUsage {
    return { planType: "pro", ...overrides } as AccountUsage
}

describe("applyLocalDailyTokens", () => {
    it("fills the counts when the provider reported nothing", () => {
        const filled = applyLocalDailyTokens(subscriptionUsage(), LEDGER)

        expect(filled.dailyInputTokens).toBe(1_500)
        expect(filled.dailyOutputTokens).toBe(80)
    })

    it("fills the counts when the provider reported only zeros", () => {
        // Zero is the shape a failed model match takes, not a report.
        const filled = applyLocalDailyTokens(subscriptionUsage({ dailyInputTokens: 0, dailyOutputTokens: 0 }), LEDGER)

        expect(filled.dailyInputTokens).toBe(1_500)
        expect(filled.dailyOutputTokens).toBe(80)
    })

    it("keeps a provider's non-zero counts instead of overwriting them", () => {
        const reported = subscriptionUsage({ dailyInputTokens: 42, dailyOutputTokens: 7 })

        expect(applyLocalDailyTokens(reported, LEDGER)).toEqual(reported)
    })

    it("keeps a partially reported day as the provider stated it", () => {
        // Any non-zero report is authoritative even when the other field is
        // absent: the ledger is a fallback for silence, not a correction pass.
        const reported = subscriptionUsage({ dailyInputTokens: 42 })

        expect(applyLocalDailyTokens(reported, LEDGER).dailyInputTokens).toBe(42)
    })

    it("leaves a balance provider untouched", () => {
        const balance = { remainingBalance: 10, currency: "CNY", dailyInputTokens: 0 } as AccountUsage

        expect(applyLocalDailyTokens(balance, LEDGER)).toEqual(balance)
    })

    it("leaves usage untouched when the ledger has no entry", () => {
        const usage = subscriptionUsage()

        expect(applyLocalDailyTokens(usage, undefined)).toEqual(usage)
    })
})
