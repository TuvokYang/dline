/**
 * DeepSeek's time-of-day pricing windows.
 *
 * DeepSeek bills off-peak requests at half the peak rate. Peak hours are
 * published in UTC as 01:00-04:00 and 06:00-10:00, Monday through Friday,
 * excluding Chinese public holidays:
 *
 * @see https://api-docs.deepseek.com/quick_start/pricing
 *
 * Those UTC bands are 09:00-12:00 and 14:00-18:00 in China Standard Time, which
 * is the frame the same document uses for its weekday and holiday rule. The
 * schedule is therefore evaluated entirely in China Standard Time: deriving the
 * weekday from UTC would misclassify the hours where the two calendars disagree,
 * such as Sunday 22:00 UTC, which is already Monday 06:00 in Beijing.
 */

/** China Standard Time is UTC+8 with no daylight saving. */
const CHINA_STANDARD_TIME_OFFSET_MS = 8 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

/** Half-open hour ranges in China Standard Time that bill at the peak rate. */
export const DEEP_SEEK_PEAK_HOURS: readonly { readonly startHour: number; readonly endHour: number }[] = [
    { startHour: 9, endHour: 12 },
    { startHour: 14, endHour: 18 },
]

/**
 * Which published rule a seller uses.
 *
 * DeepSeek's own API excludes Chinese public holidays from peak billing. The
 * OpenCode gateway resells the same two models under its Go plan and states only
 * that weekends are off-peak, with no holiday exclusion. Reading the two rules
 * as one would either over-charge holiday requests on the gateway or under-charge
 * them on DeepSeek, so the variant is explicit at every call site.
 */
export type DeepSeekRateRule = "deepseek-direct" | "opencode-go"

export const DEEP_SEEK_RATE_RULES: Readonly<Record<DeepSeekRateRule, { readonly excludesChineseHolidays: boolean }>> = {
    "deepseek-direct": { excludesChineseHolidays: true },
    "opencode-go": { excludesChineseHolidays: false },
}

/**
 * Decide whether a moment bills at the off-peak rate.
 *
 * @param isHoliday Chinese public holiday calendar. The published rule excludes
 *   these days entirely, and Dline does not embed a holiday table: the calendar
 *   changes every year and is a data source, not a pricing rule.
 */
export function isDeepSeekOffPeak(
    instant: Date,
    isHoliday: (chinaStandardDay: string) => boolean = () => false,
    rule: DeepSeekRateRule = "deepseek-direct",
): boolean {
    const chinaStandard = new Date(instant.getTime() + CHINA_STANDARD_TIME_OFFSET_MS)
    // getUTC* reads the shifted instant, which already carries China's wall clock.
    const weekday = chinaStandard.getUTCDay()
    if (weekday === 0 || weekday === 6) return true
    if (DEEP_SEEK_RATE_RULES[rule].excludesChineseHolidays && isHoliday(formatChinaStandardDay(chinaStandard))) return true

    const hour = chinaStandard.getUTCHours()
    const peak = DEEP_SEEK_PEAK_HOURS.some((range) => hour >= range.startHour && hour < range.endHour)
    return !peak
}

/**
 * The `YYYY-MM-DD` China Standard calendar day of an instant.
 *
 * The holiday calendar is keyed by this value, so it is also the identity a
 * caller stores per day.
 */
export function formatChinaStandardDay(instant: Date): string {
    const chinaStandard = new Date(instant.getTime() + CHINA_STANDARD_TIME_OFFSET_MS)
    const month = String(chinaStandard.getUTCMonth() + 1).padStart(2, "0")
    const day = String(chinaStandard.getUTCDate()).padStart(2, "0")
    return `${chinaStandard.getUTCFullYear()}-${month}-${day}`
}

/** One 30-minute segment of the schedule, already resolved for display. */
export interface DeepSeekScheduleSegment {
    /** Local hour the segment starts at, plus 0 or 30 minutes. */
    readonly hour: number
    readonly minute: 0 | 30
    readonly offPeak: boolean
}

/**
 * Resolve one local day of the schedule for the timeline.
 *
 * Segments are half-hourly so a peak window edge that falls on a half hour in
 * the user's own zone still renders where it actually applies. The caller
 * supplies local midnight so the result follows the viewer's clock, not the
 * machine's.
 */
export function buildDeepSeekSchedule(
    localDayStart: Date,
    isHoliday: (chinaStandardDay: string) => boolean = () => false,
    rule: DeepSeekRateRule = "deepseek-direct",
): readonly DeepSeekScheduleSegment[] {
    const segments: DeepSeekScheduleSegment[] = []
    for (let hour = 0; hour < 24; hour++) {
        for (const minute of [0, 30] as const) {
            const instant = new Date(localDayStart.getFullYear(), localDayStart.getMonth(), localDayStart.getDate(), hour, minute)
            segments.push({ hour, minute, offPeak: isDeepSeekOffPeak(instant, isHoliday, rule) })
        }
    }
    return segments
}

/** Where the clock sits relative to the schedule, for the summary line. */
export interface DeepSeekRateState {
    readonly offPeak: boolean
    /** Milliseconds until the next rate change, or undefined when it never changes. */
    readonly nextChangeMs?: number
    /** Whether the next change enters the peak rate. */
    readonly nextChangeEntersPeak?: boolean
    /** China Standard calendar day is a weekday holiday, when the caller knows it. */
    readonly holiday: boolean
}

/**
 * Describe the current rate and when it changes.
 *
 * A user deciding whether to send a request now cares about the next boundary,
 * so the countdown is bounded by the end of the current segment rather than by
 * the end of the day.
 */
export function resolveDeepSeekRateState(
    now: Date,
    isHoliday: (chinaStandardDay: string) => boolean = () => false,
    rule: DeepSeekRateRule = "deepseek-direct",
): DeepSeekRateState {
    const offPeak = isDeepSeekOffPeak(now, isHoliday, rule)
    const chinaStandard = new Date(now.getTime() + CHINA_STANDARD_TIME_OFFSET_MS)
    const weekdayHoliday = chinaStandard.getUTCDay() !== 0 && chinaStandard.getUTCDay() !== 6
    const holiday =
        DEEP_SEEK_RATE_RULES[rule].excludesChineseHolidays && weekdayHoliday && isHoliday(formatChinaStandardDay(chinaStandard))

    // Walk forward in half-hour steps: the published boundaries are whole hours,
    // and a half-hour probe finds any of them without arithmetic on the ranges.
    for (let step = 1; step <= 48 * 7; step++) {
        const candidate = new Date(now.getTime() + step * (HOUR_MS / 2))
        if (isDeepSeekOffPeak(candidate, isHoliday, rule) !== offPeak) {
            return {
                offPeak,
                nextChangeMs: candidate.getTime() - now.getTime(),
                nextChangeEntersPeak: offPeak,
                holiday,
            }
        }
    }
    return { offPeak, holiday }
}

/** Render a peak range as the wall-clock text a user recognises. */
export function formatPeakRange(range: { readonly startHour: number; readonly endHour: number }): string {
    return `${String(range.startHour).padStart(2, "0")}:00–${String(range.endHour).padStart(2, "0")}:00`
}
