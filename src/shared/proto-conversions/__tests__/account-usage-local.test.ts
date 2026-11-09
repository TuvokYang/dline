import { describe, expect, it } from "vitest"
import type { AccountUsageData } from "../../ExtensionMessage"
import { accountUsageToProto, protoToAccountUsage } from "../account-usage-conversion"

/**
 * A round trip is the only property that matters here: the Webview reads what the
 * extension wrote, through a generated Proto projection, so a field that survives one
 * direction and not the other is a field the user never sees.
 */
describe("AccountUsage local round trip", () => {
    function base(): AccountUsageData {
        return {
            profileId: "profile-a",
            providerId: "deepseek",
            currency: "CNY",
            remainingBalance: 12.5,
        }
    }

    it("keeps locally measured usage through both directions", () => {
        const local = {
            inputTokens: 900,
            outputTokens: 100,
            thoughtsTokens: 20,
            cacheWriteTokens: 30,
            cacheReadTokens: 40,
            cacheHitTokens: 40,
            cacheMissTokens: 860,
            usageReported: true,
            legacyInputTokens: 500,
            legacyPartial: true,
            degraded: true,
            retrievedAt: "2026-11-04T10:00:00.000Z",
        }
        const roundTripped = protoToAccountUsage(accountUsageToProto({ ...base(), local }))

        expect(roundTripped?.local).toEqual(local)
    })

    // "The provider told us nothing" and "the provider told us zero" are different
    // facts. Collapsing them would let a surface draw a zero it never measured.
    it("keeps an absent local snapshot absent", () => {
        const roundTripped = protoToAccountUsage(accountUsageToProto(base()))

        expect(roundTripped?.local).toBeUndefined()
    })

    it("keeps a measured zero distinguishable from an absent snapshot", () => {
        const roundTripped = protoToAccountUsage(
            accountUsageToProto({
                ...base(),
                local: { inputTokens: 0, outputTokens: 0, usageReported: false },
            }),
        )

        // A reported-zero snapshot exists and says usage was not reported.
        expect(roundTripped?.local).toBeDefined()
        expect(roundTripped?.local?.inputTokens).toBe(0)
        expect(roundTripped?.local?.usageReported).toBe(false)
        // Optional detail that was never set stays absent instead of becoming 0.
        expect(roundTripped?.local?.cacheHitTokens).toBeUndefined()
        expect(roundTripped?.local?.legacyPartial).toBeUndefined()
        expect(roundTripped?.local?.degraded).toBeUndefined()
    })

    // The remote balance half must not change because a local snapshot was added.
    it("leaves the remote balance fields untouched", () => {
        const roundTripped = protoToAccountUsage(
            accountUsageToProto({
                ...base(),
                local: { inputTokens: 1, outputTokens: 2, usageReported: true },
            }),
        )

        expect(roundTripped?.currency).toBe("CNY")
        expect(roundTripped?.remainingBalance).toBe(12.5)
        expect(roundTripped?.isAvailable).toBeUndefined()
    })
})
