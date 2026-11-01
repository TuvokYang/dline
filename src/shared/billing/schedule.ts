import { PricingDayRule, type PricingSchedule, type TimeWindow } from "@shared/proto/dline/models/metadata"
import { type HolidayCalendarLookup, MINUTES_PER_DAY } from "./types"

const MILLISECONDS_PER_MINUTE = 60_000

/**
 * Only the weekday rule drops weekends.
 *
 * An unspecified rule keeps the schedule's windows unchanged, which is also what
 * an unknown day produces: peak rates are visible on a bill, a silent half-price
 * request is not.
 */
const WEEKEND_EXCLUDING_RULE: PricingDayRule = PricingDayRule.PRICING_DAY_RULE_WEEKDAYS

/** A local calendar day, formatted as `YYYY-MM-DD` so lookups are plain string membership. */
export function formatLocalDay(millisecondsSinceEpoch: number): string {
    const shifted = new Date(millisecondsSinceEpoch)
    const year = shifted.getUTCFullYear()
    const month = String(shifted.getUTCMonth() + 1).padStart(2, "0")
    const day = String(shifted.getUTCDate()).padStart(2, "0")
    return `${year}-${month}-${day}`
}

/** Minutes since local midnight for an instant expressed in the seller's fixed offset. */
function localMinuteOfDay(millisecondsSinceEpoch: number, offsetMinutes: number): number {
    const shiftedMinutes = Math.floor(millisecondsSinceEpoch / MILLISECONDS_PER_MINUTE) + offsetMinutes
    return ((shiftedMinutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
}

/**
 * Whether an instant falls on a weekend in the seller's fixed offset.
 *
 * @returns True for Saturday and Sunday.
 */
function isWeekend(millisecondsSinceEpoch: number, offsetMinutes: number): boolean {
    const shifted = new Date(millisecondsSinceEpoch + offsetMinutes * MILLISECONDS_PER_MINUTE)
    const weekday = shifted.getUTCDay()
    return weekday === 0 || weekday === 6
}

/**
 * The window an instant falls into, if any.
 *
 * Windows never overlap, so at most one can contain the minute. Returning the
 * window itself rather than a boolean is what lets every window carry its own
 * rate instead of forcing the caller into a fixed two-rate split.
 *
 * @returns The covering window, or undefined for an instant the default rate covers.
 */
function windowAt(windows: readonly TimeWindow[], minuteOfDay: number): TimeWindow | undefined {
    return windows.find((window) => minuteOfDay >= window.startMinute && minuteOfDay < window.endMinute)
}

/**
 * Whether public holidays bill at the default rate for this schedule.
 *
 * An unknown calendar id means the rule cannot apply, so the schedule keeps
 * evaluating by windows and weekends. Treating an unknown id as "every day is a
 * holiday" would silently drop every window rate.
 */
function isHolidayDefault(schedule: PricingSchedule, localDay: string, holidays: HolidayCalendarLookup): boolean {
    if (!schedule.defaultOnPublicHolidays || schedule.holidayCalendar.length === 0) {
        return false
    }
    const isHoliday = holidays(schedule.holidayCalendar)
    return isHoliday !== null && isHoliday(localDay)
}

/**
 * Pick the window rate that applies to a request.
 *
 * The order is fixed and each step has one owner: an unknown instant cannot be
 * placed on the clock and therefore cannot be given a window rate, then the
 * seller's clock decides the day, then the windows decide the minute.
 *
 * An instant that no window covers, or that falls on a day the schedule bills
 * at the default rate, returns undefined so the caller applies the default.
 *
 * @param instant Request start, or undefined when the caller does not know it.
 * @param schedule Day rules, or undefined for a model that publishes no schedule.
 * @param windows Non-overlapping windows of the time-of-day price.
 * @param holidays Calendar resolver for schedules that bill holidays at the default.
 * @returns The covering window, or undefined when the default rate applies.
 */
export function windowAtInstant(
    instant: Date | undefined,
    schedule: PricingSchedule | undefined,
    windows: readonly TimeWindow[],
    holidays: HolidayCalendarLookup,
): TimeWindow | undefined {
    if (!instant || !schedule) {
        return undefined
    }

    const milliseconds = instant.getTime()
    const offsetMinutes = schedule.timezoneOffsetMinutes
    const localDay = formatLocalDay(milliseconds + offsetMinutes * MILLISECONDS_PER_MINUTE)

    if (schedule.dayRule === WEEKEND_EXCLUDING_RULE && isWeekend(milliseconds, offsetMinutes)) {
        return undefined
    }
    if (isHolidayDefault(schedule, localDay, holidays)) {
        return undefined
    }
    return windowAt(windows, localMinuteOfDay(milliseconds, offsetMinutes))
}
