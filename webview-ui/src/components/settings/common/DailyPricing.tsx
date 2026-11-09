import type { TimeOfDayPricing } from "@shared/proto/dline/models/metadata"
import { resolvePricingDay } from "@shared/providers/pricing-schedule"
import { useEffect, useState } from "react"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { type DailyPricingWindow, dailyPricingRateGroups, dailyPricingWindows } from "./daily-pricing"
import { PricingTierEditor } from "./ModelTierEditor"
import { PriceSetFields } from "./PriceSetFields"
import { formatPricingClock, formatPricingOffset, PRICING_RATE_COLORS, PricingTimeline } from "./PricingTimeline"

function formatPeriods(windows: readonly DailyPricingWindow[]): string {
    return windows
        .map((window) => `${formatPricingClock(window.startMinute)} – ${formatPricingClock(window.endMinute)}`)
        .join(", ")
}

interface DailyPricingProps {
    time: TimeOfDayPricing
    currencySymbol: string
    showCachePrices: boolean
    /** A fixed preview instant; omitted in the live Provider view. */
    atMs?: number
}

/** Read-only seller-day rendering. Configuration edits never consume these projected intervals. */
export function DailyPricing({ time, currencySymbol, showCachePrices, atMs }: DailyPricingProps) {
    const { t } = useUiTranslation()
    const [now, setNow] = useState(Date.now)
    const day = time.schedule ? resolvePricingDay(time.schedule, atMs ?? now) : undefined
    const nextDayAtMs = day?.nextDayAtMs
    useEffect(() => {
        if (atMs !== undefined || nextDayAtMs === undefined) return
        const refresh = () => setNow(Date.now())
        const onVisibility = () => {
            if (document.visibilityState === "visible") refresh()
        }
        const timer = window.setTimeout(refresh, Math.max(0, nextDayAtMs - Date.now()))
        window.addEventListener("focus", refresh)
        document.addEventListener("visibilitychange", onVisibility)
        return () => {
            window.clearTimeout(timer)
            window.removeEventListener("focus", refresh)
            document.removeEventListener("visibilitychange", onVisibility)
        }
    }, [atMs, nextDayAtMs])

    if (!day || day.windowsApply === undefined) {
        return <p role="status">{t("settings.ui.dailyUnavailable")}</p>
    }
    const offset = formatPricingOffset(time.schedule!.timezoneOffsetMinutes)
    const windows = dailyPricingWindows(time, day.windowsApply)
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <p className="m-0 text-xs text-description">
                <time dateTime={day.localDay}>{day.localDay}</time> · {offset}
            </p>
            <PricingTimeline
                label={t("settings.ui.dailyChart", { day: day.localDay, offset })}
                peakOffPeakLabels
                windows={windows}
            />
            {(["peak", "offPeak"] as const).map((kind) => {
                const periods = windows.filter((window) => window.kind === kind)
                if (periods.length === 0) return null
                const title = t("settings.ui.ratePeriods", {
                    label: kind === "peak" ? t("settings.ui.peakWindow") : t("settings.ui.offPeakWindow"),
                    periods:
                        kind === "offPeak" && windows.some((window) => window.kind === "peak")
                            ? t("settings.ui.otherTimes")
                            : formatPeriods(periods),
                })
                const groups = dailyPricingRateGroups(periods)
                return (
                    <section
                        aria-label={title}
                        className="flex flex-col gap-2 rounded-xs border border-editor-widget-border p-2"
                        data-rate-group={kind}
                        key={kind}>
                        <h3 className="m-0 text-xs font-semibold" style={{ color: PRICING_RATE_COLORS[kind] }}>
                            {title}
                        </h3>
                        {groups.map((group) => {
                            const window = group[0]
                            return (
                                <div className="flex flex-col gap-2" key={window.startMinute}>
                                    {groups.length > 1 && (
                                        <p className="m-0 text-xs" style={{ color: PRICING_RATE_COLORS[kind] }}>
                                            {formatPeriods(group)}
                                        </p>
                                    )}
                                    {window.bands ? (
                                        <PricingTierEditor
                                            currencySymbol={currencySymbol}
                                            editable={false}
                                            ratesEditable={false}
                                            showCachePrices={showCachePrices}
                                            tiers={window.bands.bands}
                                        />
                                    ) : (
                                        <PriceSetFields
                                            currencySymbol={currencySymbol}
                                            prices={window.prices}
                                            readOnly
                                            showCachePrices={showCachePrices}
                                        />
                                    )}
                                </div>
                            )
                        })}
                    </section>
                )
            })}
        </div>
    )
}
