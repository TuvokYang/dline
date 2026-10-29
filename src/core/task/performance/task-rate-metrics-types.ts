import type { ApiRateMetricsResolution, ApiRateTokenQuality } from "./api-rate-metrics-types"
import type { ApiRequestRoundStatus, ApiRequestRoundUsageQuality } from "./api-request-round-types"

export type TaskRateMetricsResolution = "round" | ApiRateMetricsResolution
export type TaskRateRpmBasis = "execution_duration" | "provider_duration" | "legacy_active_seconds" | "unavailable"
export type TaskRateUsageQuality = ApiRequestRoundUsageQuality | "mixed"

export interface TaskRateMetricPoint {
    bucketStartMs: number
    bucketEndMs: number
    activeSeconds?: number
    requestCount?: number
    tokenCount?: number
    requestsPerMinute?: number
    tokensPerMinute?: number
    tokenQuality?: ApiRateTokenQuality
    provisional?: boolean
    inputTokens?: number
    outputTokens?: number
    thoughtsTokens?: number
    cacheWriteTokens?: number
    cacheReadTokens?: number
    cacheHitRate?: number
    cacheUsageAvailable: boolean
    usageAvailable: boolean
    providerDurationMs?: number
    executionDurationMs?: number
    executionCount?: number
    completedExecutionCount?: number
    failedExecutionCount?: number
    cancelledExecutionCount?: number
    abortedExecutionCount?: number
    providerRoundCount: number
    completedRoundCount: number
    failedRoundCount: number
    cancelledRoundCount: number
    abortedRoundCount: number
    rpmBasis: TaskRateRpmBasis
    usageQuality: TaskRateUsageQuality
    status?: ApiRequestRoundStatus
    roundId?: string
    logicalRequestId?: string
    apiIndex?: number
    taskAttempt?: number
    providerAttempt?: number
    startedAtMs?: number
    completedAtMs?: number
    totalCost?: number
    currency?: string
}

export interface TaskRateMetricsQuery {
    resolution: TaskRateMetricsResolution
    startMs: number
    endMs: number
    maxPoints?: number
}

export interface TaskRateMetricsQueryResult {
    points: TaskRateMetricPoint[]
    degraded: boolean
    truncated: boolean
    retentionStartMs?: number
}
