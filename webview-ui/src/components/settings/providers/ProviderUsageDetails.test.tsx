import type { AccountUsageQuotaData } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { formatUsageRetrievedAt, isReadableUsageQuota, usageRemainingPercent } from "./ProviderUsageDetails"

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
