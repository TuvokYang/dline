/**
 * Why a model generation ran. These four values are the whole purpose
 * vocabulary of the remote usage catalog; a new kind of generation is reported
 * as `other` until the catalog grows.
 */
export const USAGE_PURPOSES = ["task", "subagent", "compaction", "other"] as const
export type UsagePurpose = (typeof USAGE_PURPOSES)[number]

export const USAGE_OUTCOMES = ["completed", "cancelled", "failed"] as const
export type UsageOutcome = (typeof USAGE_OUTCOMES)[number]

import { PROVIDER_FAILURE_CLASSES, type ProviderFailureClass } from "@core/api/observability/provider-failure"

/**
 * Why a provider attempt failed. The service accepts exactly these values; a
 * failure that fits none of them is `other`, never a new value. The provider
 * domain owns the vocabulary because it classifies the errors.
 */
export const USAGE_ERROR_CLASSES = PROVIDER_FAILURE_CLASSES
export type UsageErrorClass = ProviderFailureClass

/** The provider and model that served a request, as its handler reported them. */
export interface UsageServedModel {
    /** The Profile's provider ID, such as `anthropic` or `lmstudio`. */
    readonly provider: string
    /** The model ID the request was sent with. */
    readonly model: string
    /**
     * The Profile runs a free-form model ID ("Use custom model ID", or Bedrock's "Custom"
     * model). The model is still reported under its ID, marked custom beside it.
     */
    readonly custom?: boolean
}

/** Streaming timing of the attempt that produced the result; absent for a request that never streamed. */
export interface UsageStreamTiming {
    /** From sending the request to the first content or reasoning chunk. */
    readonly ttftMs: number
    /** From the first chunk to the end of the stream. */
    readonly generationMs: number
}

import type { ChecklistChange } from "./ChecklistDiff"
import type { UsageToolCall } from "./UsageToolCalls"

/** Attempts that failed before the request settled, all served by the same provider. */
export interface UsageRetries {
    /** The backoff waited before each retry, in order. */
    readonly waitsMs: readonly number[]
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
    /** The reasoning share of `outputTokens`; absent when the provider does not report it. */
    readonly reasoningTokens?: number
    /** The attempt that produced the result only: earlier failed attempts and backoff are not included. */
    readonly durationMs: number
    readonly streamTiming?: UsageStreamTiming
    readonly retries?: UsageRetries
    /** Why the request failed; read only when `outcome` is `failed`. */
    readonly failureClass?: UsageErrorClass
    /** Read when the request opens; absent when the serving handler could not say. */
    readonly servedBy?: UsageServedModel
    /**
     * The tool calls this request's turn settled, for the per-tool breakdown.
     *
     * Absent when the reading surface cannot resolve them; the request still
     * reports its own outcome totals, so only the breakdown is lost.
     */
    readonly toolCalls?: readonly UsageToolCall[]
    /**
     * Checklist changes this request's turn reported, in the order they happened.
     *
     * Absent when the surface has no checklist; an empty list also stays absent so
     * "not reported" and "nothing changed" are never confused at the wire.
     */
    readonly checklistChanges?: readonly ChecklistChange[]
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
