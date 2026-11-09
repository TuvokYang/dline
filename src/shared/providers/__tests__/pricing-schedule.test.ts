import { PricingDayRule, type PricingSchedule } from "@shared/proto/dline/models/metadata"
import { resolvePricingDay } from "@shared/providers/pricing-schedule"
import { describe, expect, it } from "vitest"

const schedule: PricingSchedule = {
    timezoneOffsetMinutes: 480,
    dayRule: PricingDayRule.PRICING_DAY_RULE_WEEKDAYS,
    defaultOnPublicHolidays: true,
    holidayCalendar: "CN",
}

describe("shared seller-day schedule", () => {
    it.each([
        ["2026-11-06T15:59:59Z", "2026-11-06", true, "2026-11-06T16:00:00Z"],
        ["2026-11-06T16:00:00Z", "2026-11-07", false, "2026-11-07T16:00:00Z"],
        ["2026-11-08T15:59:59Z", "2026-11-08", false, "2026-11-08T16:00:00Z"],
        ["2026-11-08T16:00:00Z", "2026-11-09", true, "2026-11-09T16:00:00Z"],
        ["2026-10-01T02:00:00Z", "2026-10-01", false, "2026-10-01T16:00:00Z"],
    ])("resolves %s in seller time", (at, localDay, windowsApply, midnight) => {
        expect(resolvePricingDay(schedule, Date.parse(at))).toMatchObject({
            localDay,
            windowsApply,
            nextDayAtMs: Date.parse(midnight),
        })
    })

    it("keeps an all-days declaration applicable on a weekend", () => {
        expect(
            resolvePricingDay(
                { ...schedule, dayRule: PricingDayRule.PRICING_DAY_RULE_ALL_DAYS },
                Date.parse("2026-11-08T02:00:00Z"),
            )?.windowsApply,
        ).toBe(true)
    })
})
