import type { ApiRequestRoundStatus } from "./api-request-round-types"

export const API_RESPONSE_EXECUTION_SCHEMA_VERSION = 1 as const

export type ApiResponseExecutionStatus = ApiRequestRoundStatus
export type ApiResponseExecutionTerminalKind = "provider_only" | "tools_settled" | "turn_end_awaiting_user"

export interface ApiResponseExecutionToolSummary {
    readonly toolCount: number
    readonly completedToolCount: number
    readonly failedToolCount: number
    readonly cancelledToolCount: number
}

export interface ApiResponseExecutionRecord extends ApiResponseExecutionToolSummary {
    readonly schemaVersion: typeof API_RESPONSE_EXECUTION_SCHEMA_VERSION
    readonly taskId: string
    readonly executionId: string
    readonly revision: number
    readonly roundId: string
    readonly logicalRequestId: string
    readonly apiIndex: number
    readonly taskAttempt: number
    readonly providerAttempt: number
    readonly startedAtMs: number
    readonly providerCompletedAtMs: number
    readonly completedAtMs: number
    readonly providerDurationMs: number
    readonly executionDurationMs: number
    readonly status: ApiResponseExecutionStatus
    readonly terminalKind: ApiResponseExecutionTerminalKind
}

export interface ApiResponseExecutionSnapshot {
    readonly requestsPerMinute?: number
    readonly rpmBasis: "execution_duration" | "unavailable"
    readonly executionCount: number
    readonly executionDurationMs?: number
    readonly degraded: boolean
}

export interface ApiResponseExecutionRangeQuery {
    readonly startMs: number
    readonly endMs: number
    readonly maxPoints: number
}

export interface ApiResponseExecutionRangeSnapshotQuery {
    readonly startMs: number
    readonly endMs: number
    readonly pageSize: number
}

export interface ApiResponseExecutionRepository {
    append(records: readonly ApiResponseExecutionRecord[]): Promise<void>
    readRecent(limit?: number): Promise<ApiResponseExecutionRecord[]>
    readRange(query: ApiResponseExecutionRangeQuery): Promise<ApiResponseExecutionRecord[]>
    readRangeSnapshot(query: ApiResponseExecutionRangeSnapshotQuery): Promise<ApiResponseExecutionRecord[]>
    waitForWrites(): Promise<void>
    close(): Promise<void>
}
