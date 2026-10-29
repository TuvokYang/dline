import type {
    ProviderAttemptAdapterIdentity,
    ProviderAttemptObserver,
    ProviderTelemetryRole,
} from "@shared/provider-attempt-observer"
import type { UsageFailureClass } from "@/services/telemetry/remote/contracts/usageBodySchema"
import type { UsageServedModel } from "../telemetry/UsageSettlement"
import type { UsageToolCall } from "../telemetry/UsageToolCalls"
import type { ApiRequestRoundHandle } from "./api-request-round-tracker"
import type { ApiRequestRoundRecord, ApiRequestRoundUsage } from "./api-request-round-types"
import type { ApiResponseExecutionRecord, ApiResponseExecutionToolSummary } from "./api-response-execution-types"

export interface ProviderRequestRoundAdmissionInput {
    readonly source: ProviderTelemetryRole
    readonly apiIndex?: number
    /** The provider and model serving the round, for observers that split usage by them. */
    readonly servedBy?: UsageServedModel
}

/** One revision of a real Provider send: its admission handle and the round record at that revision. */
export interface ProviderAttemptRevision {
    readonly handle: ApiRequestRoundHandle
    readonly record: ApiRequestRoundRecord
}

/** The settled logical execution of one logical request, bound to its final result-producing attempt. */
export interface ProviderLogicalExecution {
    readonly handle: ApiRequestRoundHandle
    readonly execution: ApiResponseExecutionRecord
    /** Name-safe tool outcomes belonging to that execution; never persisted in the execution metrics table. */
    readonly toolCalls?: readonly UsageToolCall[]
}

/**
 * Ordered facts of one Provider send. Token finalization and logical settlement
 * are independent: the consumer owns the finalization deadline, and a logical
 * execution never delays the Provider observation (usage-client-lifecycle §8).
 */
export type ProviderAttemptUsageEvent =
    | ({
          readonly kind: "terminal"
          /** Present exactly when the send failed; the error itself never crosses this port. */
          readonly failureClass?: UsageFailureClass
      } & ProviderAttemptRevision)
    | ({ readonly kind: "tokens" } & ProviderAttemptRevision)
    | { readonly kind: "tokens_final"; readonly roundId: string }
    | ({ readonly kind: "logical_execution" } & ProviderLogicalExecution)

export interface ProviderAttemptUsagePort {
    recordAttemptEvent(event: ProviderAttemptUsageEvent): void
}

export interface ProviderRequestRoundAdmission {
    createAttemptObserver(taskAttempt: number, adapter?: ProviderAttemptAdapterIdentity): ProviderAttemptObserver
    /** The send's accumulated exact usage, delivered once when its stream closes; it also finalizes the tokens. */
    attachExactUsage(usage: ApiRequestRoundUsage): void
    completeProviderOnly(): void
    completeTools(summary: ApiResponseExecutionToolSummary, toolCalls?: readonly UsageToolCall[]): void
    completeTurnEndAwaitingUser(summary: ApiResponseExecutionToolSummary, toolCalls?: readonly UsageToolCall[]): void
}
