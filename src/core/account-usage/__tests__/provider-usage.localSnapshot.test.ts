import type { ApiProfile } from "@shared/proto/dline/profile"
import { describe, expect, it } from "vitest"
import { attachLocalUsageSnapshot, decorateProviderAccountUsage } from "../provider-usage"

function profile(): ApiProfile {
    return { id: "profile-a", name: "DeepSeek", provider: "deepseek", apiKey: "", enabled: true } as unknown as ApiProfile
}

/**
 * A balance-style provider reports no daily token counts at all, so the locally
 * measured total is the only number a user can act on. It must be present, and it
 * must not pretend the provider reported it.
 */
describe("attachLocalUsageSnapshot", () => {
    it("attaches the local record to a balance-style snapshot", () => {
        const decorated = decorateProviderAccountUsage(
            profile(),
            { currency: "CNY", remainingBalance: 12.5 },
            {
                inputTokens: 900,
                outputTokens: 100,
                usageReported: true,
                retrievedAt: "2026-11-04T00:00:00.000Z",
            },
        )

        expect(decorated?.local).toMatchObject({ inputTokens: 900, outputTokens: 100, usageReported: true })
        // The remote half is untouched: a local total never rewrites a balance.
        expect(decorated?.remainingBalance).toBe(12.5)
        expect(decorated?.dailyInputTokens).toBeUndefined()
    })

    // "The ledger recorded nothing today" is a real, measured fact: the snapshot
    // exists because the ledger was read, and a real zero is a report of zero.
    // Deriving the flag from a positive count conflated it with "never measured",
    // which hid a genuinely quiet day.
    it("marks an all-zero local snapshot as reported, because it was measured", () => {
        const snapshot = attachLocalUsageSnapshot(
            { currency: "CNY" },
            { inputTokens: 0, outputTokens: 0, returnedAt: "2026-11-04T00:00:00.000Z" },
        )

        expect(snapshot.local?.usageReported).toBe(true)
        expect(snapshot.local?.inputTokens).toBe(0)
        expect(snapshot.local?.retrievedAt).toBe("2026-11-04T00:00:00.000Z")
    })

    // Absent local input must not invent a snapshot: nothing measured is different
    // from measuring zero.
    it("leaves the snapshot without local when no local input was supplied", () => {
        const decorated = decorateProviderAccountUsage(profile(), { currency: "CNY" })

        expect(decorated?.local).toBeUndefined()
    })
})
