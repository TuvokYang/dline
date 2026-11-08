import type { PricingTimeWindow, TimeOfDayPricing } from "@shared/proto/dline/models/metadata"
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
