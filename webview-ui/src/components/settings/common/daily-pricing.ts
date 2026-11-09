import { PricingTimeWindow, type TimeOfDayPricing } from "@shared/proto/dline/models/metadata"
import { PRICING_DAY_MINUTES } from "@shared/providers/pricing-schedule"

export interface DailyPricingWindow extends PricingTimeWindow {
    readonly kind: "peak" | "offPeak"
}

/** Fill the applicable day's gaps without changing or merging the stored declaration. */
export function dailyPricingWindows(time: TimeOfDayPricing, windowsApply: boolean): readonly DailyPricingWindow[] {
    const fallback = { prices: time.defaultPrices, bands: time.defaultBands }
    const windows: DailyPricingWindow[] = []
    let start = 0
    for (const window of windowsApply ? [...time.timeWindows].sort((a, b) => a.startMinute - b.startMinute) : []) {
        if (start < window.startMinute) {
            windows.push({ ...fallback, startMinute: start, endMinute: window.startMinute, kind: "offPeak" })
        }
        windows.push({ ...window, kind: "peak" })
        start = window.endMinute
    }
    if (start < PRICING_DAY_MINUTES) {
        windows.push({ ...fallback, startMinute: start, endMinute: PRICING_DAY_MINUTES, kind: "offPeak" })
    }
    return windows
}

/** Group identical rates for display only, preserving every interval and distinct price set. */
export function dailyPricingRateGroups(windows: readonly DailyPricingWindow[]): readonly (readonly DailyPricingWindow[])[] {
    const groups = new Map<string, DailyPricingWindow[]>()
    for (const window of windows) {
        const rates = PricingTimeWindow.toJSON({ ...window, startMinute: 0, endMinute: 0 })
        const key = JSON.stringify(rates)
        const group = groups.get(key)
        if (group) group.push(window)
        else groups.set(key, [window])
    }
    return [...groups.values()]
}
