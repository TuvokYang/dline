import { MoonIcon, SunIcon } from "lucide-react"
import { useMemo } from "react"
import {
    buildDeepSeekSchedule,
    DEEP_SEEK_PEAK_HOURS,
    DEEP_SEEK_RATE_RULES,
    type DeepSeekRateRule,
    formatPeakRange,
    resolveDeepSeekRateState,
} from "./deepseekPricingSchedule"

/**
 * A model's published prices for both rates.
 *
 * The card shows the peak figure from the registry and derives the off-peak
 * figure from the documented half-rate rule, so a registry update to peak
 * pricing cannot silently leave a stale off-peak number behind.
 */
export interface DeepSeekPricedModel {
    readonly modelId: string
    readonly inputPeak: number
    readonly outputPeak: number
    readonly cachedInputPeak: number
    readonly currency: string
}

export interface DeepSeekOffPeakPricingProps {
    /**
     * The one model the Profile selected. Only its prices are shown: a Profile
     * bills against a single model, and listing the whole catalog turned a
     * summary into a rate sheet the user has to search.
     */
    readonly model: DeepSeekPricedModel
    /** Instant the card renders its current rate for. Injected so stories are stable. */
    readonly now: Date
    /** China Standard calendar day is a public holiday, when the caller knows it. */
    readonly isHoliday?: (chinaStandardDay: string) => boolean
    /**
     * Whose published rule applies. DeepSeek excludes Chinese public holidays
     * from peak billing; the OpenCode gateway resells the same models without
     * that exclusion, so the card must not present one rule for the other.
     */
    readonly rule?: DeepSeekRateRule
}

/** Published off-peak rates are half the peak rates. */
const OFF_PEAK_MULTIPLIER = 0.5

/**
 * DeepSeek time-of-day pricing card.
 *
 * DeepSeek bills 01:00-04:00 and 06:00-10:00 UTC on weekdays at twice the
 * off-peak rate. The card states the viewer's own local peak windows, the
 * current rate, and how long it lasts, because a user deciding when to send an
 * expensive request needs the boundary in their own clock rather than UTC.
 */
export function DeepSeekOffPeakPricing({ model, now, isHoliday, rule = "deepseek-direct" }: DeepSeekOffPeakPricingProps) {
    const holidayCalendar = isHoliday ?? (() => false)
    const rate = useMemo(() => resolveDeepSeekRateState(now, holidayCalendar, rule), [now, holidayCalendar, rule])
    const schedule = useMemo(
        () => buildDeepSeekSchedule(new Date(now.getFullYear(), now.getMonth(), now.getDate()), holidayCalendar, rule),
        [now, holidayCalendar, rule],
    )
    const excludesHolidays = DEEP_SEEK_RATE_RULES[rule].excludesChineseHolidays

    return (
        <div className="flex w-full min-w-0 flex-col gap-3 border-t border-editor-widget-border/50 pt-3">
            <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-foreground">Time-of-day pricing</span>
                <RateBadge offPeak={rate.offPeak} />
            </div>

            <p className="text-xs leading-normal text-description">{formatRateSentence(rate, now, excludesHolidays)}</p>

            <ScheduleTimeline schedule={schedule} />

            <ModelPriceRows model={model} />

            <p className="text-[11px] leading-normal text-description">
                Off-peak rates are half the peak rates. Peak hours are {DEEP_SEEK_PEAK_HOURS.map(formatPeakRange).join(" and ")}{" "}
                UTC on weekdays{excludesHolidays ? ", excluding Chinese public holidays" : ""}. Prices are per 1M tokens.
            </p>
        </div>
    )
}

/** The two rate colours live here so the badge, the timeline and the price cells cannot drift apart. */
const PEAK_COLOR = "var(--vscode-charts-orange, #f59e0b)"
const OFF_PEAK_COLOR = "var(--vscode-charts-green, #22c55e)"

function RateBadge({ offPeak }: { readonly offPeak: boolean }) {
    const Icon = offPeak ? MoonIcon : SunIcon
    const rateColor = offPeak ? OFF_PEAK_COLOR : PEAK_COLOR
    return (
        <span
            className="flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
            data-rate={offPeak ? "off-peak" : "peak"}
            // The badge, the timeline and the price cells all describe the same
            // two rates, so they share one colour each: a badge that stayed
            // neutral grey made the current rate read as undifferentiated chrome.
            style={{
                backgroundColor: `color-mix(in srgb, ${rateColor} 18%, transparent)`,
                color: rateColor,
            }}>
            <Icon aria-hidden className="size-3" />
            {offPeak ? "Off-peak" : "Peak"}
        </span>
    )
}

/**
 * Draw one half-hourly day of the schedule.
 *
 * The bar is the whole day rather than the next few hours: a user planning when
 * to run a long task needs to see where today's windows actually are, and a
 * countdown alone cannot show that.
 */
function ScheduleTimeline({ schedule }: { readonly schedule: ReturnType<typeof buildDeepSeekSchedule> }) {
    const labels = useMemo(
        () =>
            schedule.map((segment, index) => {
                const isHourStart = segment.minute === 0
                // Only every third hour earns a tick, otherwise the axis is denser
                // than a 380px card can render without the labels colliding.
                if (!isHourStart || segment.hour % 3 !== 0) return ""
                return index === 0 || segment.hour === 0 ? "00" : String(segment.hour).padStart(2, "0")
            }),
        [schedule],
    )

    return (
        <div className="flex flex-col gap-1">
            <div
                aria-label="DeepSeek pricing windows for today"
                className="flex h-3 w-full overflow-hidden rounded-xs"
                role="img">
                {schedule.map((segment) => (
                    <span
                        className="h-full flex-1"
                        data-off-peak={segment.offPeak}
                        key={`${segment.hour}:${segment.minute}`}
                        style={{
                            backgroundColor: `color-mix(in srgb, ${segment.offPeak ? OFF_PEAK_COLOR : PEAK_COLOR} ${
                                segment.offPeak ? 45 : 70
                            }%, transparent)`,
                        }}
                    />
                ))}
            </div>
            <div className="flex w-full text-[10px] text-description" dir="ltr">
                {labels.map((label, index) => (
                    <span className="flex-1 text-left" key={index}>
                        {label}
                    </span>
                ))}
            </div>
        </div>
    )
}

function ModelPriceRows({ model }: { readonly model: DeepSeekPricedModel }) {
    return (
        <div className="flex flex-col gap-1 rounded-xs bg-toolbar-hover/20 px-2 py-1.5">
            <span className="text-xs font-medium text-foreground">{model.modelId}</span>
            <div className="grid grid-cols-3 gap-x-3 gap-y-0.5 text-[11px]">
                <span className="text-description" />
                <span className="text-right text-description">Peak</span>
                <span className="text-right text-description">Off-peak</span>

                <span className="text-description">Input</span>
                <PriceCell currency={model.currency} peak price={model.inputPeak} />
                <PriceCell currency={model.currency} price={model.inputPeak * OFF_PEAK_MULTIPLIER} />

                <span className="text-description">Cached input</span>
                <PriceCell currency={model.currency} peak price={model.cachedInputPeak} />
                <PriceCell currency={model.currency} price={model.cachedInputPeak * OFF_PEAK_MULTIPLIER} />

                <span className="text-description">Output</span>
                <PriceCell currency={model.currency} peak price={model.outputPeak} />
                <PriceCell currency={model.currency} price={model.outputPeak * OFF_PEAK_MULTIPLIER} />
            </div>
        </div>
    )
}

function PriceCell({
    currency,
    price,
    peak = false,
}: {
    readonly currency: string
    readonly price: number
    readonly peak?: boolean
}) {
    return (
        <span
            className={`text-right ${peak ? "font-medium" : "text-description"}`}
            data-price-tone={peak ? "peak" : "off-peak"}
            // Peak is the expensive rate, so it carries the same warning colour the
            // usage bar uses for a nearly exhausted window.
            style={peak ? { color: PEAK_COLOR } : undefined}>
            {formatPrice(price, currency)}
        </span>
    )
}

/** Keep the published three decimals for cached reads, where sub-cent values matter. */
function formatPrice(price: number, currency: string): string {
    const symbol = currency === "CNY" ? "¥" : currency === "USD" ? "$" : ""
    const value = price < 0.1 ? price.toFixed(3) : price.toFixed(2)
    return `${symbol}${value}`
}

/**
 * State the current rate and the next boundary.
 *
 * A holiday is named explicitly, because on a weekday holiday the card shows
 * off-peak pricing while the timeline's weekday shape still looks like it has a
 * peak window, and the sentence is what explains the difference.
 */
function formatRateSentence(rate: ReturnType<typeof resolveDeepSeekRateState>, now: Date, excludesHolidays: boolean): string {
    if (rate.holiday) {
        return "Today is a Chinese public holiday, so every request bills at the off-peak rate."
    }
    const weekday = now.getDay()
    if (weekday === 0 || weekday === 6) {
        return "Weekends bill at the off-peak rate all day."
    }
    if (rate.nextChangeMs === undefined) {
        return rate.offPeak ? "Requests bill at the off-peak rate." : "Requests bill at the peak rate."
    }
    const minutes = Math.max(1, Math.round(rate.nextChangeMs / 60_000))
    const countdown = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`
    const suffix = excludesHolidays ? "" : " Chinese public holidays still bill at the peak rate here."
    if (rate.offPeak) {
        return `Off-peak now. The peak rate starts in ${countdown}.${suffix}`
    }
    return `Peak now. The off-peak rate starts in ${countdown}.`
}

/** Whether the instant falls on a weekday holiday, for callers that pre-resolve the calendar. */
export function isDeepSeekHoliday(now: Date, isHoliday: (chinaStandardDay: string) => boolean): boolean {
    return resolveDeepSeekRateState(now, isHoliday).holiday
}
