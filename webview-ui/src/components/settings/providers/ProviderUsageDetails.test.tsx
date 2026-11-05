import type { AccountUsageData, AccountUsageLocalData, AccountUsageQuotaData } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import {
    formatUsageRetrievedAt,
    isReadableUsageQuota,
    localCacheHitRate,
    localTodayInput,
    localUsageNotes,
    usageRemainingPercent,
} from "./ProviderUsageDetails"

/**
 * Both provider subscriptions are read once and then held until the user
 * refreshes, so every surface that shows the numbers also states their age.
 * Without it an hours-old reading is indistinguishable from a live one.
 */
describe("formatUsageRetrievedAt", () => {
    const now = Date.parse("2026-09-23T12:00:00.000Z")

    it("reports a reading taken moments ago", () => {
        expect(formatUsageRetrievedAt("2026-09-23T11:59:30.000Z", now)).toBe("Updated just now")
    })

    it("reports minutes, hours, and days as the reading ages", () => {
        expect(formatUsageRetrievedAt("2026-09-23T11:45:00.000Z", now)).toBe("Updated 15m ago")
        expect(formatUsageRetrievedAt("2026-09-23T09:00:00.000Z", now)).toBe("Updated 3h ago")
        expect(formatUsageRetrievedAt("2026-09-21T12:00:00.000Z", now)).toBe("Updated 2d ago")
    })

    it("says nothing when no usable read time was recorded", () => {
        // A provider that predates the field, or sends something unparsable,
        // must not render "Updated NaN ago" next to real numbers.
        expect(formatUsageRetrievedAt(undefined, now)).toBeUndefined()
        expect(formatUsageRetrievedAt("not a timestamp", now)).toBeUndefined()
    })
})

/**
 * `usageRemainingPercent` clamps to 0 for an unusable reading, so a quota that
 * reaches a renderer unfiltered is displayed as "0% remaining" and claims the
 * window is exhausted. The filter is what keeps missing data from becoming a
 * definite state.
 */
describe("isReadableUsageQuota", () => {
    function quota(overrides: Partial<AccountUsageQuotaData>): AccountUsageQuotaData {
        return { type: "weekly", label: "7 day", used: 10, limit: 100, ...overrides }
    }

    it("accepts a quota with a usable bound and reading", () => {
        expect(isReadableUsageQuota(quota({}))).toBe(true)
    })

    it("rejects a quota whose bound or reading cannot be used", () => {
        expect(isReadableUsageQuota(quota({ limit: 0 }))).toBe(false)
        expect(isReadableUsageQuota(quota({ limit: Number.NaN }))).toBe(false)
        expect(isReadableUsageQuota(quota({ used: Number.NaN }))).toBe(false)
    })

    it("shows why an unfiltered quota would misreport the account", () => {
        expect(usageRemainingPercent(quota({ used: Number.NaN }))).toBe(0)
    })
})

/** The local day total, which is this installation's own committed usage. */
function localUsage(overrides: Partial<AccountUsageLocalData> = {}): AccountUsageData {
    return {
        profileId: "profile-a",
        providerId: "deepseek",
        currency: "",
        local: { inputTokens: 100, outputTokens: 20, usageReported: true, ...overrides },
    }
}

describe("localTodayInput", () => {
    it("separates fresh input from cache traffic and adds the inclusive legacy total", () => {
        const usage = localUsage({ inputTokens: 100, cacheReadTokens: 900, legacyInputTokens: 50 })

        // Cache traffic is input the account paid for but reported apart from fresh
        // input, so the day total has to include it: 100 fresh + 900 cache read + 50
        // legacy. The legacy total is inclusive and only counts while it is still marked.
        expect(localTodayInput(usage)).toBe(1050)
    })

    it("adds cache writes to the fresh input as well", () => {
        expect(localTodayInput(localUsage({ inputTokens: 10, cacheWriteTokens: 5 }))).toBe(15)
    })

    it("reports nothing when this installation recorded no usage at all", () => {
        // A snapshot with no reported usage is an unmeasured day, not a zero day.
        expect(localTodayInput(localUsage({ inputTokens: 0, outputTokens: 0, usageReported: false }))).toBeUndefined()
    })

    it("keeps an explicit zero distinguishable from a missing record", () => {
        expect(localTodayInput(localUsage({ inputTokens: 0, outputTokens: 0, usageReported: true }))).toBe(0)
        expect(localTodayInput({ profileId: "p", providerId: "deepseek", currency: "" })).toBeUndefined()
    })

    it("counts a legacy baseline even when this session reported no fresh usage", () => {
        expect(localTodayInput(localUsage({ inputTokens: 0, usageReported: false, legacyInputTokens: 40 }))).toBe(40)
    })
})

describe("localCacheHitRate", () => {
    it("computes the rate from the reported hit and miss counts", () => {
        expect(localCacheHitRate(localUsage({ cacheHitTokens: 30, cacheMissTokens: 70 }))).toBe(30)
    })

    it("reports nothing when the provider did not split cache hits", () => {
        // Rendering 0% would state that every cached token missed, which the
        // provider never said; absence is not a zero rate.
        expect(localCacheHitRate(localUsage())).toBeUndefined()
        expect(localCacheHitRate(localUsage({ cacheHitTokens: 0, cacheMissTokens: 0 }))).toBeUndefined()
    })
})

describe("localUsageNotes", () => {
    it("says when a legacy total is inclusive and whether it can be split", () => {
        expect(localUsageNotes(localUsage({ legacyInputTokens: 10, legacyPartial: true }))).toEqual([
            "Includes an earlier day total that cannot be split by model",
        ])
        expect(localUsageNotes(localUsage({ legacyInputTokens: 10 }))).toEqual(["Includes an earlier day total"])
    })

    it("says when the numbers are incomplete", () => {
        expect(localUsageNotes(localUsage({ degraded: true }))).toEqual(["Local usage is incomplete"])
    })

    it("says nothing about a complete, fresh record", () => {
        expect(localUsageNotes(localUsage())).toEqual([])
    })
})
