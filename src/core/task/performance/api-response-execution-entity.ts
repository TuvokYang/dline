import { column, defineEntity } from "@core/storage/backend/api/EntitySchema"
import {
    API_RESPONSE_EXECUTION_SCHEMA_VERSION,
    type ApiResponseExecutionRecord,
    type ApiResponseExecutionStatus,
    type ApiResponseExecutionTerminalKind,
} from "./api-response-execution-types"

export interface ApiResponseExecutionEntityValues {
    executionId: string
    revision: number
    schemaVersion: number
    taskId: string
    roundId: string
    logicalRequestId: string
    apiIndex: number
    taskAttempt: number
    providerAttempt: number
    startedAtMs: number
    providerCompletedAtMs: number
    completedAtMs: number
    providerDurationMs: number
    executionDurationMs: number
    status: ApiResponseExecutionStatus
    terminalKind: ApiResponseExecutionTerminalKind
    toolCount: number
    completedToolCount: number
    failedToolCount: number
    cancelledToolCount: number
}

export class ApiResponseExecutionEntity implements ApiResponseExecutionEntityValues {
    static readonly storage = defineEntity<ApiResponseExecutionEntity>()({
        schemaId: "api-response-execution-flat",
        version: 1,
        columns: {
            executionId: column.text({ primary: true }),
            revision: column.integer({ primary: true }),
            schemaVersion: column.integer(),
            taskId: column.text({ indexed: true }),
            roundId: column.text({ indexed: true }),
            logicalRequestId: column.text({ indexed: true }),
            apiIndex: column.integer(),
            taskAttempt: column.integer(),
            providerAttempt: column.integer(),
            startedAtMs: column.real(),
            providerCompletedAtMs: column.real(),
            completedAtMs: column.real({ indexed: true }),
            providerDurationMs: column.real(),
            executionDurationMs: column.real(),
            status: column.enumText(["completed", "failed", "cancelled", "aborted"] as const),
            terminalKind: column.enumText(["provider_only", "tools_settled", "turn_end_awaiting_user"] as const),
            toolCount: column.integer(),
            completedToolCount: column.integer(),
            failedToolCount: column.integer(),
            cancelledToolCount: column.integer(),
        },
        indexes: [
            { name: "api-response-execution-task-completed-revision", fields: ["taskId", "completedAtMs", "revision"] },
            { name: "api-response-execution-logical-attempt", fields: ["logicalRequestId", "providerAttempt"] },
            { name: "api-response-execution-round", fields: ["roundId"] },
        ],
        defaultOrder: [
            { field: "completedAtMs", direction: "asc" },
            { field: "providerAttempt", direction: "asc" },
            { field: "revision", direction: "asc" },
        ],
        hydrate: (values) => new ApiResponseExecutionEntity(values),
    })

    readonly executionId!: string
    readonly revision!: number
    readonly schemaVersion!: number
    readonly taskId!: string
    readonly roundId!: string
    readonly logicalRequestId!: string
    readonly apiIndex!: number
    readonly taskAttempt!: number
    readonly providerAttempt!: number
    readonly startedAtMs!: number
    readonly providerCompletedAtMs!: number
    readonly completedAtMs!: number
    readonly providerDurationMs!: number
    readonly executionDurationMs!: number
    readonly status!: ApiResponseExecutionStatus
    readonly terminalKind!: ApiResponseExecutionTerminalKind
    readonly toolCount!: number
    readonly completedToolCount!: number
    readonly failedToolCount!: number
    readonly cancelledToolCount!: number

    constructor(values: ApiResponseExecutionEntityValues) {
        Object.assign(this, values)
    }
}

export function toApiResponseExecutionEntity(record: ApiResponseExecutionRecord): ApiResponseExecutionEntity {
    assertApiResponseExecutionRecord(record)
    return new ApiResponseExecutionEntity(record)
}

export function fromApiResponseExecutionEntity(entity: ApiResponseExecutionEntity): ApiResponseExecutionRecord {
    const record: ApiResponseExecutionRecord = {
        schemaVersion: API_RESPONSE_EXECUTION_SCHEMA_VERSION,
        taskId: entity.taskId,
        executionId: entity.executionId,
        revision: entity.revision,
        roundId: entity.roundId,
        logicalRequestId: entity.logicalRequestId,
        apiIndex: entity.apiIndex,
        taskAttempt: entity.taskAttempt,
        providerAttempt: entity.providerAttempt,
        startedAtMs: entity.startedAtMs,
        providerCompletedAtMs: entity.providerCompletedAtMs,
        completedAtMs: entity.completedAtMs,
        providerDurationMs: entity.providerDurationMs,
        executionDurationMs: entity.executionDurationMs,
        status: entity.status,
        terminalKind: entity.terminalKind,
        toolCount: entity.toolCount,
        completedToolCount: entity.completedToolCount,
        failedToolCount: entity.failedToolCount,
        cancelledToolCount: entity.cancelledToolCount,
    }
    assertApiResponseExecutionRecord(record)
    return record
}

export function assertApiResponseExecutionRecord(record: ApiResponseExecutionRecord): void {
    if (record.schemaVersion !== API_RESPONSE_EXECUTION_SCHEMA_VERSION) {
        throw new Error("Unsupported API response execution schema version")
    }
    if (!record.taskId || !record.executionId || !record.roundId || !record.logicalRequestId) {
        throw new Error("API response execution identity is incomplete")
    }
    for (const [name, value] of [
        ["revision", record.revision],
        ["apiIndex", record.apiIndex],
        ["taskAttempt", record.taskAttempt],
        ["providerAttempt", record.providerAttempt],
        ["toolCount", record.toolCount],
        ["completedToolCount", record.completedToolCount],
        ["failedToolCount", record.failedToolCount],
        ["cancelledToolCount", record.cancelledToolCount],
    ] as const) {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new Error(`API response execution ${name} must be a non-negative integer`)
        }
    }
    for (const [name, value] of [
        ["startedAtMs", record.startedAtMs],
        ["providerCompletedAtMs", record.providerCompletedAtMs],
        ["completedAtMs", record.completedAtMs],
        ["providerDurationMs", record.providerDurationMs],
        ["executionDurationMs", record.executionDurationMs],
    ] as const) {
        if (!Number.isFinite(value) || value < 0) {
            throw new Error(`API response execution ${name} must be non-negative and finite`)
        }
    }
    if (record.providerCompletedAtMs < record.startedAtMs || record.completedAtMs < record.providerCompletedAtMs) {
        throw new Error("API response execution timestamps are out of order")
    }
    if (record.providerDurationMs < 1 || record.executionDurationMs < record.providerDurationMs) {
        throw new Error("API response execution durations are inconsistent")
    }
    const settledToolCount = record.completedToolCount + record.failedToolCount + record.cancelledToolCount
    if (settledToolCount !== record.toolCount) {
        throw new Error("API response execution tool counts must describe fully settled tools")
    }
    if (record.terminalKind === "provider_only" && record.toolCount !== 0) {
        throw new Error("Provider-only API response execution cannot contain tools")
    }
    if (record.terminalKind !== "provider_only" && record.toolCount === 0) {
        throw new Error("Tool API response execution must contain at least one tool")
    }
}
