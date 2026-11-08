import type { TimeOfDayPricing } from "@shared/proto/dline/models/metadata"
import { resolvePricingDay } from "@shared/providers/pricing-schedule"
import { useEffect, useState } from "react"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { dailyPricingWindows } from "./daily-pricing"
import { PricingTierEditor } from "./ModelTierEditor"
import { PriceSetFields } from "./PriceSetFields"
import { formatPricingClock, formatPricingOffset, PricingTimeline } from "./PricingTimeline"

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
            {windows.map((window) => {
                const title = t("settings.ui.windowRange", {
                    label: window.kind === "peak" ? t("settings.ui.peakWindow") : t("settings.ui.offPeakWindow"),
                    start: formatPricingClock(window.startMinute),
                    end: formatPricingClock(window.endMinute),
                })
                return (
                    <section
                        aria-label={title}
                        className="flex flex-col gap-2 rounded-xs border border-editor-widget-border p-2"
                        key={`${window.startMinute}-${window.endMinute}`}>
                        <h3 className="m-0 text-xs font-semibold">{title}</h3>
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
                    </section>
                )
            })}
        </div>
    )
}
