/** Standard token counts supplied by the caller for one calculation. */
export interface BillingTokens {
    readonly inputTokens: number
    /** Inclusive of thoughtsTokenCount, which is a subset rather than an increment. */
    readonly outputTokens: number
    readonly cacheWriteTokens?: number
    readonly cacheReadTokens?: number
    readonly thoughtsTokenCount?: number
}

/** A field-level problem safe to return from configuration and calculation boundaries. */
export interface PricingIssue {
    readonly path: string
    readonly code: string
    readonly message: string
}

/** One calculation's result; no request identity or settlement state is retained. */
export type BillingResult =
    | { readonly kind: "calculated"; readonly amount: number; readonly currency: string }
    | { readonly kind: "unavailable" }
    | { readonly kind: "invalid"; readonly issues: readonly PricingIssue[] }
