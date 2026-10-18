/**
 * Why a model generation ran. These four values are the whole purpose
 * vocabulary of the remote usage catalog; a new kind of generation is reported
 * as `other` until the catalog grows.
 */
export const USAGE_PURPOSES = ["task", "subagent", "compaction", "other"] as const
export type UsagePurpose = (typeof USAGE_PURPOSES)[number]

export const USAGE_OUTCOMES = ["completed", "cancelled", "failed"] as const
export type UsageOutcome = (typeof USAGE_OUTCOMES)[number]

/** The provider and model that served a request, as its handler reported them. */
export interface UsageServedModel {
    /** The Profile's provider ID, such as `anthropic` or `openai-compatible`. */
    readonly provider: string
    /** The model ID the request was sent with. */
    readonly model: string
}

/** What one logical provider request consumed, settled exactly once when it ends. */
export interface UsageSettlement {
    /** Fixed when the request opens; the sink treats a repeated ID as the same request. */
    readonly observationId: string
    readonly purpose: UsagePurpose
    readonly outcome: UsageOutcome
    /** Fresh input, excluding cache reads and writes. */
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens: number
    readonly cacheWriteTokens: number
    /** Millionths of a US dollar; absent when the request was not priced in dollars. */
    readonly costMicroUsd?: number
    readonly durationMs: number
    /** Read when the request opens; absent when the serving handler could not say. */
    readonly servedBy?: UsageServedModel
}

/**
 * The single entry point for authoritative request usage.
 *
 * Recording is synchronous and never throws into the caller: the sink queues,
 * persists and accounts for its own losses, so a telemetry fault can neither
 * delay nor fail the request it describes.
 */
export interface UsageSettlementPort {
    record(settlement: UsageSettlement): void
}
