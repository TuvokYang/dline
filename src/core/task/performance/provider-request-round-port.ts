import type { UsageServedModel } from "../telemetry/UsageSettlement"
import type { ApiRequestRoundUsage } from "./api-request-round-types"
import type { ApiResponseExecutionToolSummary } from "./api-response-execution-types"

export type ProviderRequestRoundSource = "ordinary" | "compaction" | "subagent"

export interface ProviderRequestRoundAdmissionInput {
    readonly source: ProviderRequestRoundSource
    readonly apiIndex?: number
    /** The provider and model serving the round, for observers that split usage by them. */
    readonly servedBy?: UsageServedModel
}

export interface ProviderRequestRoundAdmission {
    bindAttempt<T>(stream: AsyncIterable<T>, taskAttempt: number): AsyncIterable<T>
    attachExactUsage(usage: ApiRequestRoundUsage): void
    completeProviderOnly(): void
    completeTools(summary: ApiResponseExecutionToolSummary): void
    completeTurnEndAwaitingUser(summary: ApiResponseExecutionToolSummary): void
}

/** Task-owned boundary for admitting one logical request and observing all of its actual Provider sends. */
export interface ProviderRequestRoundPort {
    admit(input: ProviderRequestRoundAdmissionInput): ProviderRequestRoundAdmission
}
