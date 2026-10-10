export const API_REQUEST_ROUND_SCHEMA_VERSION = 1 as const

export type ApiRequestRoundStatus = "completed" | "failed" | "cancelled" | "aborted"
export type ApiRequestRoundUsageQuality = "none" | "estimated" | "exact" | "legacy"

export interface ApiRequestRoundRecord {
    readonly schemaVersion: typeof API_REQUEST_ROUND_SCHEMA_VERSION
    readonly taskId: string
    readonly roundId: string
    readonly revision: number
    readonly logicalRequestId: string
    readonly apiIndex: number
    readonly taskAttempt: number
    readonly providerAttempt: number
    readonly startedAtMs: number
    readonly completedAtMs: number
    readonly providerDurationMs?: number
    readonly status: ApiRequestRoundStatus
    readonly inputTokens?: number
    readonly outputTokens?: number
    readonly thoughtsTokens?: number
    readonly cacheWriteTokens?: number
    readonly cacheReadTokens?: number
    readonly cacheUsageReported: boolean
    readonly totalCost?: number
    readonly currency?: string
    readonly usageQuality: ApiRequestRoundUsageQuality
}

export interface ApiRequestRoundUsage {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly thoughtsTokens?: number
    readonly cacheWriteTokens?: number
    readonly cacheReadTokens?: number
    readonly cacheUsageReported: boolean
    readonly totalCost?: number
    readonly currency?: string
}

export interface ApiRequestRoundRangeQuery {
    readonly startMs: number
    readonly endMs: number
    readonly maxPoints: number
}

export interface ApiRequestRoundRangeSnapshotQuery {
    readonly startMs: number
    readonly endMs: number
    readonly pageSize: number
}

export interface ApiRequestRoundCumulativeUsage {
    readonly degraded: boolean
    readonly inputTokens?: number
    readonly outputTokens?: number
    readonly cacheWriteTokens?: number
    readonly cacheReadTokens?: number
    readonly cacheNumerator: number
    readonly cacheDenominator: number
    readonly totalCost?: number
    readonly currency?: string
}

export interface ApiRequestRoundRepository {
    append(records: readonly ApiRequestRoundRecord[]): Promise<void>
    readRecent(limit?: number): Promise<ApiRequestRoundRecord[]>
    readRange(query: ApiRequestRoundRangeQuery): Promise<ApiRequestRoundRecord[]>
    readRangeSnapshot(query: ApiRequestRoundRangeSnapshotQuery): Promise<ApiRequestRoundRecord[]>
    readRecentHistory(limit?: number): Promise<ApiRequestRoundRecord[]>
    readRangeHistorySnapshot(query: ApiRequestRoundRangeSnapshotQuery): Promise<ApiRequestRoundRecord[]>
    readCumulativeUsage(): Promise<ApiRequestRoundCumulativeUsage>
    isDegraded(): boolean
    waitForWrites(): Promise<void>
    close(): Promise<void>
}
