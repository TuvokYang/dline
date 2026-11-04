type HolidayRange = readonly [start: string, end: string]

/**
 * Whole-day holiday closures, verified against official government notices on
 * 2026-11-03. Weekend make-up workdays do not change the seller's weekday rule.
 * 2025: https://www.kashi.gov.cn/ksdqxzgs/c115966/202411/e116097ae08f4324ae5802863f2a96ba.shtml
 * 2026: https://www.beijing.gov.cn/fuwu/bmfw/sy/jrts/202511/t20251104_4258838.html
 */
const CHINA_HOLIDAYS: Readonly<Record<number, readonly HolidayRange[]>> = {
    2025: [
        ["2025-01-01", "2025-01-01"],
        ["2025-01-28", "2025-02-04"],
        ["2025-04-04", "2025-04-06"],
        ["2025-05-01", "2025-05-05"],
        ["2025-05-31", "2025-06-02"],
        ["2025-10-01", "2025-10-08"],
    ],
    2026: [
        ["2026-01-01", "2026-01-03"],
        ["2026-02-15", "2026-02-23"],
        ["2026-04-04", "2026-04-06"],
        ["2026-05-01", "2026-05-05"],
        ["2026-06-19", "2026-06-21"],
        ["2026-09-25", "2026-09-27"],
        ["2026-10-01", "2026-10-07"],
    ],
}

export function supportsCalendar(id: string): boolean {
    return id === "CN"
}

/** Undefined is deliberately not a verified working day. */
export function isPublicHoliday(id: string, localDay: string): boolean | undefined {
    if (!supportsCalendar(id)) return undefined
    const ranges = CHINA_HOLIDAYS[Number(localDay.slice(0, 4))]
    return ranges?.some(([start, end]) => localDay >= start && localDay <= end)
}
