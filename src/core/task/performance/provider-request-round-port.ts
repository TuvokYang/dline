import type {
    ProviderAttemptAdapterIdentity,
    ProviderAttemptObserver,
    ProviderTelemetryRole,
} from "@shared/provider-attempt-observer"
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

export interface UsageModelCatalogPort {
    getProviderModels(
        providerId: string,
    ): { readonly models: Readonly<Record<string, { readonly id: string; readonly userDefined?: boolean }>> } | undefined
}

const USAGE_CATALOG_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9_.:/-]{0,95}$/u

/** Project a final wire model through the trusted catalog without ever returning its private raw identifier. */
export function projectProviderUsageModelId(catalog: UsageModelCatalogPort, provider: string, wireModelId: string): string {
    const model = catalog.getProviderModels(provider)?.models[wireModelId]
    if (!model) return "state:unknown"
    if (model.userDefined === true) return "state:private"
    if (model.userDefined !== false || !USAGE_CATALOG_MODEL_ID_PATTERN.test(model.id)) return "state:unknown"
    return `catalog:${model.id}`
}

export interface FinalizedProviderAttempt {
    readonly handle: ApiRequestRoundHandle
    readonly record: ApiRequestRoundRecord
    /** Present only on the final result-producing attempt of one logical request. */
    readonly logicalExecution?: ApiResponseExecutionRecord
    /** Name-safe tool outcomes belonging to that logical execution; never persisted in the execution metrics table. */
    readonly logicalToolCalls?: readonly UsageToolCall[]
}

/** Receives exactly one highest-revision terminal projection for each real Provider send. */
export interface FinalizedProviderAttemptPort {
    recordFinalizedAttempt(attempt: FinalizedProviderAttempt): void
}

export interface ProviderRequestRoundAdmission {
    createAttemptObserver(taskAttempt: number, adapter?: ProviderAttemptAdapterIdentity): ProviderAttemptObserver
    attachExactUsage(usage: ApiRequestRoundUsage): void
    completeProviderOnly(): void
    completeTools(summary: ApiResponseExecutionToolSummary, toolCalls?: readonly UsageToolCall[]): void
    completeTurnEndAwaitingUser(summary: ApiResponseExecutionToolSummary, toolCalls?: readonly UsageToolCall[]): void
}
