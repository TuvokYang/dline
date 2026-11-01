import type { PricingSchedule } from "@shared/proto/dline/models/metadata"

/** A monetary amount. Currency travels with the amount because one account may mix currencies. */
export interface Money {
    readonly amount: number
    readonly currency: string
}

/**
 * Everything the price depends on besides the model's own pricing terms.
 *
 * Both inputs are optional because callers that cannot know them still need a
 * cost: see `resolvePrices` for what each absence means.
 */
export interface PricingFacts {
    /** Total input tokens for this request. Absent skips window-band lookup. */
    readonly totalInputTokens?: number
    /** Request start. Absent resolves to the peak rate. */
    readonly requestedAt?: Date
}

/** The price set that applies to one request. */
export interface ResolvedPrices {
    readonly inputPrice: number
    readonly outputPrice: number
    readonly cacheWritePrice: number
    readonly cacheReadPrice: number
    readonly thinkingOutputPrice?: number
    readonly currency: string
}

/** Why a request produced no cost. Keeps "covered by a plan" distinct from "no terms published". */
export type NonBillableReason = "subscription" | "free" | "unknown"

export type ResolvedBilling =
    | { readonly kind: "metered"; readonly prices: ResolvedPrices }
    | { readonly kind: "not-billable"; readonly reason: NonBillableReason }

/** Token counts already mapped onto price slots. */
export interface BillableTokens {
    readonly regularInput: number
    readonly output: number
    readonly cacheWrite: number
    readonly cacheRead: number
    readonly thinking: number
}

/** Token-counting convention a provider response follows. */
export type UsageProfile = "anthropic" | "openai" | "qwen"

/**
 * Raised when a model's published pricing terms are structurally invalid.
 *
 * This is a configuration defect in the bundled catalog, not a runtime condition
 * callers are expected to recover from: silently billing zero would hide a wrong
 * price for every request that model serves.
 */
export class BillingConfigurationError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "BillingConfigurationError"
    }
}

/** Absent `requestedAt`, schedule, or window means peak: over-charging is visible, under-charging is not. */
export const DEFAULT_PEAK_WHEN_UNKNOWN_TIME = true

/** Minutes in one day, the coordinate system `PricingSchedule` windows use. */
export const MINUTES_PER_DAY = 1440

/** Resolve a holiday calendar id to a day predicate, or null when the id is unknown. */
export type HolidayCalendarLookup = (calendarId: string) => ((localDay: string) => boolean) | null

export interface ScheduleEvaluation {
    readonly schedule: PricingSchedule
    readonly instant: Date | undefined
    readonly holidays: HolidayCalendarLookup
}
