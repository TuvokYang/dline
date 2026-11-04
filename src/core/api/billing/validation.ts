import {
    type ContextWindowPricing,
    type ModelPricing,
    type PriceSet,
    PricingDayRule,
    type PricingSchedule,
    type TimeOfDayPricing,
} from "@shared/proto/dline/models/metadata"
import { supportsCalendar } from "./calendars"
import type { BillingTokens, PricingIssue } from "./types"

const present = (value: unknown): boolean => value !== undefined && value !== null
const countPresent = (...values: unknown[]): number => values.filter(present).length

/** Validate the complete declaration, including rates that do not match the current time. */
export function validateModelPricing(
    pricing: ModelPricing | undefined,
    options: { allowUnknown?: boolean } = {},
): PricingIssue[] {
    const issues: PricingIssue[] = []
    const issue = (path: string, message: string) => issues.push({ path, code: "invalid-pricing", message })
    if (!pricing) {
        if (options.allowUnknown === false) issue("pricing", "A complete pricing declaration is required.")
        return issues
    }
    const { currency, strategy } = pricing
    if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency))
        issue("currency", "Use a three-letter uppercase currency code.")
    if (!strategy || countPresent(strategy.flat, strategy.contextWindow, strategy.timeOfDay) !== 1) {
        issue("strategy", "Exactly one pricing strategy is required.")
        return issues
    }
    if (strategy.flat) validatePrices(strategy.flat.prices, "strategy.flat.prices", issue)
    if (strategy.contextWindow) validateBands(strategy.contextWindow, "strategy.contextWindow", issue)
    if (strategy.timeOfDay) validateTimeOfDay(strategy.timeOfDay, "strategy.timeOfDay", issue)
    return issues
}

type AddIssue = (path: string, message: string) => void

function validatePrices(prices: PriceSet | undefined, path: string, issue: AddIssue): void {
    if (!prices) {
        issue(path, "A complete price set is required.")
        return
    }
    for (const key of ["inputPrice", "outputPrice", "cacheWritePrice", "cacheReadPrice", "thinkingOutputPrice"] as const) {
        const value = prices[key]
        if (value === undefined && key !== "inputPrice" && key !== "outputPrice") continue
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
            issue(`${path}.${key}`, "Unit prices must be finite non-negative numbers.")
        }
    }
}

function validateBands(banded: ContextWindowPricing, path: string, issue: AddIssue): void {
    const bands = banded.bands ?? []
    if (bands.length === 0) {
        issue(`${path}.bands`, "At least one price band is required.")
        return
    }
    let previous = 0
    for (const [index, band] of bands.entries()) {
        const at = `${path}.bands[${index}]`
        const bound = band.maxInputTokens
        if (index === bands.length - 1) {
            if (bound !== undefined) issue(`${at}.maxInputTokens`, "The final price band must be unbounded.")
        } else if (bound === undefined || !Number.isSafeInteger(bound) || bound <= previous) {
            issue(`${at}.maxInputTokens`, "Finite band limits must be positive, strictly increasing safe integers.")
        }
        if (bound !== undefined) previous = bound
        validatePrices(band.prices, `${at}.prices`, issue)
    }
}

function validateRate(
    prices: PriceSet | undefined,
    bands: ContextWindowPricing | undefined,
    path: string,
    issue: AddIssue,
): void {
    if (countPresent(prices, bands) !== 1) {
        issue(path, "Exactly one price set or band list is required for each rate.")
        return
    }
    if (prices) validatePrices(prices, `${path}.prices`, issue)
    if (bands) validateBands(bands, `${path}.bands`, issue)
}

function validateSchedule(schedule: PricingSchedule | undefined, path: string, issue: AddIssue): void {
    if (!schedule) {
        issue(path, "A seller-time schedule is required.")
        return
    }
    const offset = schedule.timezoneOffsetMinutes
    if (!Number.isInteger(offset) || offset < -840 || offset > 840) {
        issue(`${path}.timezoneOffsetMinutes`, "The UTC offset must be an integer between -840 and 840 minutes.")
    }
    if (
        schedule.dayRule !== PricingDayRule.PRICING_DAY_RULE_WEEKDAYS &&
        schedule.dayRule !== PricingDayRule.PRICING_DAY_RULE_ALL_DAYS
    ) {
        issue(`${path}.dayRule`, "Choose weekdays or all days explicitly.")
    }
    if (schedule.defaultOnPublicHolidays && !supportsCalendar(schedule.holidayCalendar)) {
        issue(`${path}.holidayCalendar`, "Choose a supported holiday calendar when holiday default pricing is enabled.")
    }
}

function validateTimeOfDay(time: TimeOfDayPricing, path: string, issue: AddIssue): void {
    validateSchedule(time.schedule, `${path}.schedule`, issue)
    validateRate(time.defaultPrices, time.defaultBands, `${path}.defaultRate`, issue)
    const windows = time.timeWindows ?? []
    for (const [index, window] of windows.entries()) {
        const at = `${path}.timeWindows[${index}]`
        if (
            !Number.isInteger(window.startMinute) ||
            !Number.isInteger(window.endMinute) ||
            window.startMinute < 0 ||
            window.startMinute >= window.endMinute ||
            window.endMinute > 1440
        ) {
            issue(at, "Time windows must have integer bounds satisfying 0 <= start < end <= 1440.")
        }
        validateRate(window.prices, window.bands, at, issue)
    }
    const ordered = windows.map((window, index) => ({ ...window, index })).sort((a, b) => a.startMinute - b.startMinute)
    for (let index = 1; index < ordered.length; index += 1) {
        if (ordered[index].startMinute < ordered[index - 1].endMinute) {
            issue(`${path}.timeWindows[${ordered[index].index}]`, "Time windows must not overlap.")
        }
    }
}

/** Validate supplied standard counts without changing their protocol meaning. */
export function validateTokens(tokens: BillingTokens): PricingIssue[] {
    const issues: PricingIssue[] = []
    for (const key of ["inputTokens", "outputTokens", "cacheWriteTokens", "cacheReadTokens", "thoughtsTokenCount"] as const) {
        const value = tokens[key] ?? (key === "inputTokens" || key === "outputTokens" ? Number.NaN : 0)
        if (!Number.isSafeInteger(value) || value < 0) {
            issues.push({
                path: `tokens.${key}`,
                code: "invalid-usage",
                message: "Token counts must be non-negative safe integers.",
            })
        }
    }
    if ((tokens.thoughtsTokenCount ?? 0) > tokens.outputTokens) {
        issues.push({
            path: "tokens.thoughtsTokenCount",
            code: "invalid-usage",
            message: "Thoughts must be a subset of inclusive output.",
        })
    }
    if (!Number.isSafeInteger(tokens.inputTokens + (tokens.cacheWriteTokens ?? 0) + (tokens.cacheReadTokens ?? 0))) {
        issues.push({
            path: "tokens.inputTokens",
            code: "invalid-usage",
            message: "The total input count exceeds the supported integer range.",
        })
    }
    return issues
}

export function validateInstant(sentAtMs: number): PricingIssue[] {
    return Number.isFinite(sentAtMs) && !Number.isNaN(new Date(sentAtMs).getTime())
        ? []
        : [
              {
                  path: "sentAtMs",
                  code: "invalid-time",
                  message: "Supply the API send time as an absolute timestamp in milliseconds.",
              },
          ]
}
