import type { PricingSchedule, TimeWindow } from "@shared/proto/dline/models/metadata"
import { describe, expect, it } from "vitest"
import { lookupHolidayCalendar } from "../holidays"
import { formatLocalDay, windowAtInstant } from "../schedule"

const UTC8 = 480

/** 2026-03-02 is a Monday. */
const MONDAY_MORNING_WINDOW = new Date("2026-03-02T02:00:00Z")
const MONDAY_LUNCH = new Date("2026-03-02T04:00:00Z")
const MONDAY_AFTERNOON_WINDOW = new Date("2026-03-02T06:00:00Z")
const MONDAY_EVENING = new Date("2026-03-02T14:00:00Z")
const SATURDAY_MORNING = new Date("2026-03-07T02:00:00Z")
const HOLIDAY_MORNING = new Date("2026-10-01T02:00:00Z")

/** The two local windows DeepSeek bills above its default rate. */
const WINDOWS: readonly TimeWindow[] = [
    { startMinute: 540, endMinute: 720, prices: { inputPrice: 1, outputPrice: 2 } },
    { startMinute: 840, endMinute: 1080, prices: { inputPrice: 3, outputPrice: 6 } },
]

function schedule(overrides: Partial<PricingSchedule> = {}): PricingSchedule {
    return {
        timezoneOffsetMinutes: UTC8,
        dayRule: 1,
        defaultOnPublicHolidays: false,
        holidayCalendar: "",
        ...overrides,
    }
}

describe("windowAtInstant: window boundaries", () => {
    it("selects the window whose start minute matches", () => {
        expect(windowAtInstant(MONDAY_MORNING_WINDOW, schedule(), WINDOWS, lookupHolidayCalendar)).toBe(WINDOWS[0])
    })

    it("selects the minute before the end, which is still inside", () => {
        // 11:59 in UTC+8 is minute 719.
        const instant = new Date("2026-03-02T03:59:00Z")
        expect(windowAtInstant(instant, schedule(), WINDOWS, lookupHolidayCalendar)).toBe(WINDOWS[0])
    })

    it("selects nothing at the exclusive end minute", () => {
        // 12:00 in UTC+8 is minute 720, the exclusive bound.
        expect(windowAtInstant(MONDAY_LUNCH, schedule(), WINDOWS, lookupHolidayCalendar)).toBeUndefined()
    })

    it("selects nothing between two windows", () => {
        expect(windowAtInstant(MONDAY_LUNCH, schedule(), WINDOWS, lookupHolidayCalendar)).toBeUndefined()
    })

    it("selects the second window, not the first", () => {
        expect(windowAtInstant(MONDAY_AFTERNOON_WINDOW, schedule(), WINDOWS, lookupHolidayCalendar)).toBe(WINDOWS[1])
    })

    it("selects nothing outside every window", () => {
        expect(windowAtInstant(MONDAY_EVENING, schedule(), WINDOWS, lookupHolidayCalendar)).toBeUndefined()
    })
})

describe("windowAtInstant: unknown inputs", () => {
    it("selects nothing without a request instant, so the default rate applies", () => {
        expect(windowAtInstant(undefined, schedule(), WINDOWS, lookupHolidayCalendar)).toBeUndefined()
    })

    it("selects nothing without a schedule, so the default rate applies", () => {
        expect(windowAtInstant(MONDAY_MORNING_WINDOW, undefined, WINDOWS, lookupHolidayCalendar)).toBeUndefined()
    })

    it("selects nothing when the model declares no window", () => {
        expect(windowAtInstant(MONDAY_MORNING_WINDOW, schedule(), [], lookupHolidayCalendar)).toBeUndefined()
    })
})

describe("windowAtInstant: day rules", () => {
    it("selects nothing on a weekend under the weekday rule", () => {
        expect(windowAtInstant(SATURDAY_MORNING, schedule({ dayRule: 1 }), WINDOWS, lookupHolidayCalendar)).toBeUndefined()
    })

    it("selects the window on a weekend under the all-days rule", () => {
        expect(windowAtInstant(SATURDAY_MORNING, schedule({ dayRule: 2 }), WINDOWS, lookupHolidayCalendar)).toBe(WINDOWS[0])
    })
})

describe("windowAtInstant: public holidays", () => {
    it("selects the window on a holiday when the schedule ignores holidays", () => {
        expect(windowAtInstant(HOLIDAY_MORNING, schedule(), WINDOWS, lookupHolidayCalendar)).toBe(WINDOWS[0])
    })

    it("selects nothing on a holiday when the schedule bills holidays at the default", () => {
        const holidayDefault = schedule({ defaultOnPublicHolidays: true, holidayCalendar: "CN" })
        expect(windowAtInstant(HOLIDAY_MORNING, holidayDefault, WINDOWS, lookupHolidayCalendar)).toBeUndefined()
    })

    it("still selects the window on a normal weekday when holidays are excluded", () => {
        const holidayDefault = schedule({ defaultOnPublicHolidays: true, holidayCalendar: "CN" })
        expect(windowAtInstant(MONDAY_MORNING_WINDOW, holidayDefault, WINDOWS, lookupHolidayCalendar)).toBe(WINDOWS[0])
    })

    it("keeps evaluating windows when the calendar id is unknown", () => {
        const unknownCalendar = schedule({ defaultOnPublicHolidays: true, holidayCalendar: "XX" })
        expect(windowAtInstant(HOLIDAY_MORNING, unknownCalendar, WINDOWS, lookupHolidayCalendar)).toBe(WINDOWS[0])
        expect(windowAtInstant(MONDAY_EVENING, unknownCalendar, WINDOWS, lookupHolidayCalendar)).toBeUndefined()
    })
})

describe("formatLocalDay", () => {
    it("shifts a UTC instant into the seller's offset before formatting", () => {
        // 2026-03-01T16:30Z is 2026-03-02 00:30 in UTC+8.
        expect(formatLocalDay(new Date("2026-03-01T16:30:00Z").getTime() + UTC8 * 60_000)).toBe("2026-03-02")
    })
})

describe("lookupHolidayCalendar", () => {
    it("resolves the Chinese calendar", () => {
        const isHoliday = lookupHolidayCalendar("CN")
        expect(isHoliday).not.toBeNull()
        expect(isHoliday?.("2026-10-01")).toBe(true)
        expect(isHoliday?.("2026-03-02")).toBe(false)
    })

    it("returns null for an id this build does not carry", () => {
        expect(lookupHolidayCalendar("US")).toBeNull()
    })
})
