import type { HolidayCalendarLookup } from "./types"

/**
 * Mainland China statutory holidays, restricted to years this table covers.
 *
 * Only whole-day closures are listed. Adjusted make-up working days are ignored
 * because DeepSeek publishes holiday closure, not working-day swaps, and a wrong
 * "is a workday" answer would bill peak rates on a day the seller charges off-peak.
 *
 * Extend this table before the first year it does not cover. An uncovered day is
 * treated as a normal day, which means peak rates apply.
 */
const CHINA_HOLIDAYS: ReadonlySet<string> = new Set([
    // 2025
    "2025-01-01",
    "2025-01-28",
    "2025-01-29",
    "2025-01-30",
    "2025-01-31",
    "2025-02-01",
    "2025-02-02",
    "2025-02-03",
    "2025-02-04",
    "2025-04-04",
    "2025-04-05",
    "2025-04-06",
    "2025-05-01",
    "2025-05-02",
    "2025-05-03",
    "2025-05-04",
    "2025-05-05",
    "2025-05-31",
    "2025-06-01",
    "2025-06-02",
    "2025-10-01",
    "2025-10-02",
    "2025-10-03",
    "2025-10-04",
    "2025-10-05",
    "2025-10-06",
    "2025-10-07",
    "2025-10-08",
    // 2026
    "2026-01-01",
    "2026-01-02",
    "2026-01-03",
    "2026-02-15",
    "2026-02-16",
    "2026-02-17",
    "2026-02-18",
    "2026-02-19",
    "2026-02-20",
    "2026-02-21",
    "2026-04-04",
    "2026-04-05",
    "2026-04-06",
    "2026-05-01",
    "2026-05-02",
    "2026-05-03",
    "2026-05-04",
    "2026-05-05",
    "2026-06-19",
    "2026-06-20",
    "2026-06-21",
    "2026-09-25",
    "2026-09-26",
    "2026-09-27",
    "2026-10-01",
    "2026-10-02",
    "2026-10-03",
    "2026-10-04",
    "2026-10-05",
    "2026-10-06",
    "2026-10-07",
])

const CALENDARS: ReadonlyMap<string, (localDay: string) => boolean> = new Map([
    ["CN", (localDay: string) => CHINA_HOLIDAYS.has(localDay)],
])

/**
 * Resolve a calendar id to a day predicate.
 *
 * @param calendarId Calendar identifier declared by a pricing schedule, such as "CN".
 * @returns The predicate, or null when this build has no data for that id.
 */
export const lookupHolidayCalendar: HolidayCalendarLookup = (calendarId) => CALENDARS.get(calendarId) ?? null

/** Calendar ids this build can evaluate. Used by catalog authors and tests. */
export const HOLIDAY_CALENDAR_IDS: readonly string[] = [...CALENDARS.keys()]
