import {
    type ContextWindowPricing,
    type ModelPricing,
    type PriceSet,
    PricingDayRule,
    type TimeOfDayPricing,
} from "@shared/proto/dline/models/metadata"
import { isPublicHoliday } from "./calendars"
import type { PricingIssue } from "./types"

export const MINUTE_MS = 60_000
export const DAY_MS = 1440 * MINUTE_MS

interface Rate {
    readonly prices?: PriceSet
    readonly bands?: ContextWindowPricing
}

export type SelectedRate =
    | { readonly kind: "rate"; readonly id: string; readonly rate: Rate }
    | { readonly kind: "invalid"; readonly issues: readonly PricingIssue[] }

/** All inputs have already passed the declaration and instant validators. */
export function rateAtInstant(time: TimeOfDayPricing, atMs: number): SelectedRate {
    const schedule = time.schedule!
    const local = new Date(atMs + schedule.timezoneOffsetMinutes * MINUTE_MS)
    if (Number.isNaN(local.getTime())) {
        return {
            kind: "invalid",
            issues: [
                {
                    path: "sentAtMs",
                    code: "invalid-time",
                    message: "The supplied instant exceeds the seller-local date range.",
                },
            ],
        }
    }
    const fallback: SelectedRate = {
        kind: "rate",
        id: "default",
        rate: { prices: time.defaultPrices, bands: time.defaultBands },
    }
    const weekday = local.getUTCDay()
    if (schedule.dayRule === PricingDayRule.PRICING_DAY_RULE_WEEKDAYS && (weekday === 0 || weekday === 6)) {
        return fallback
    }
    if (schedule.defaultOnPublicHolidays) {
        const holiday = isPublicHoliday(schedule.holidayCalendar, local.toISOString().slice(0, 10))
        if (holiday === undefined) {
            return {
                kind: "invalid",
                issues: [
                    {
                        path: "strategy.timeOfDay.schedule.holidayCalendar",
                        code: "calendar-unavailable",
                        message: "The holiday calendar does not cover the supplied seller-local date.",
                    },
                ],
            }
        }
        if (holiday) return fallback
    }
    const minute = local.getUTCHours() * 60 + local.getUTCMinutes()
    const windows = time.timeWindows ?? []
    const index = windows.findIndex((window) => minute >= window.startMinute && minute < window.endMinute)
    if (index < 0) return fallback
    const window = windows[index]
    return { kind: "rate", id: `window:${index}`, rate: { prices: window.prices, bands: window.bands } }
}

export function selectPrices(
    pricing: ModelPricing,
    totalInputTokens: number,
    atMs: number,
): { kind: "prices"; prices: PriceSet } | Extract<SelectedRate, { kind: "invalid" }> {
    const strategy = pricing.strategy!
    if (strategy.flat) return { kind: "prices", prices: strategy.flat.prices! }
    if (strategy.contextWindow) return { kind: "prices", prices: bandPrices(strategy.contextWindow, totalInputTokens) }
    const selected = rateAtInstant(strategy.timeOfDay!, atMs)
    if (selected.kind === "invalid") return selected
    return { kind: "prices", prices: selected.rate.prices ?? bandPrices(selected.rate.bands!, totalInputTokens) }
}

function bandPrices(banded: ContextWindowPricing, totalInputTokens: number): PriceSet {
    // The validator guarantees ascending inclusive bounds and one unbounded final band.
    return banded.bands.find((band) => band.maxInputTokens === undefined || totalInputTokens <= band.maxInputTokens)!.prices!
}
