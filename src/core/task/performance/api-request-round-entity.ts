import { column, defineEntity } from "@core/storage/backend/api/EntitySchema"
import {
    API_REQUEST_ROUND_SCHEMA_VERSION,
    type ApiRequestRoundRecord,
    type ApiRequestRoundStatus,
    type ApiRequestRoundUsageQuality,
} from "./api-request-round-types"

export interface ApiRequestRoundEntityValues {
    roundId: string
    revision: number
    schemaVersion: number
    taskId: string
    logicalRequestId: string
    apiIndex: number
    taskAttempt: number
    providerAttempt: number
    startedAtMs: number
    completedAtMs: number
    providerDurationMs: number
    status: ApiRequestRoundStatus
    inputTokens: number | null
    outputTokens: number | null
    thoughtsTokens: number | null
    cacheWriteTokens: number | null
    cacheReadTokens: number | null
    cacheUsageReported: boolean
    totalCost: number | null
    currency: string | null
    usageQuality: ApiRequestRoundUsageQuality
}

export class ApiRequestRoundEntity implements ApiRequestRoundEntityValues {
    static readonly storage = defineEntity<ApiRequestRoundEntity>()({
        schemaId: "api-request-round-flat",
        version: 1,
        columns: {
            roundId: column.text({ primary: true }),
            revision: column.integer({ primary: true }),
            schemaVersion: column.integer(),
            taskId: column.text({ indexed: true }),
            logicalRequestId: column.text({ indexed: true }),
            apiIndex: column.integer(),
            taskAttempt: column.integer(),
            providerAttempt: column.integer(),
            startedAtMs: column.real(),
            completedAtMs: column.real({ indexed: true }),
            providerDurationMs: column.real(),
            status: column.enumText(["completed", "failed", "cancelled", "aborted"] as const),
            inputTokens: column.integer({ nullable: true }),
            outputTokens: column.integer({ nullable: true }),
            thoughtsTokens: column.integer({ nullable: true }),
            cacheWriteTokens: column.integer({ nullable: true }),
            cacheReadTokens: column.integer({ nullable: true }),
            cacheUsageReported: column.boolean(),
            totalCost: column.real({ nullable: true }),
            currency: column.text({ nullable: true }),
            usageQuality: column.enumText(["none", "estimated", "exact"] as const),
        },
        indexes: [
            { name: "api-request-round-task-completed-revision", fields: ["taskId", "completedAtMs", "revision"] },
            { name: "api-request-round-logical-attempt", fields: ["logicalRequestId", "providerAttempt"] },
        ],
        defaultOrder: [
            { field: "completedAtMs", direction: "asc" },
            { field: "providerAttempt", direction: "asc" },
            { field: "revision", direction: "asc" },
        ],
        hydrate: (values) => new ApiRequestRoundEntity(values),
    })

    readonly roundId!: string
    readonly revision!: number
    readonly schemaVersion!: number
    readonly taskId!: string
    readonly logicalRequestId!: string
    readonly apiIndex!: number
    readonly taskAttempt!: number
    readonly providerAttempt!: number
    readonly startedAtMs!: number
    readonly completedAtMs!: number
    readonly providerDurationMs!: number
    readonly status!: ApiRequestRoundStatus
    readonly inputTokens!: number | null
    readonly outputTokens!: number | null
    readonly thoughtsTokens!: number | null
    readonly cacheWriteTokens!: number | null
    readonly cacheReadTokens!: number | null
    readonly cacheUsageReported!: boolean
    readonly totalCost!: number | null
    readonly currency!: string | null
    readonly usageQuality!: ApiRequestRoundUsageQuality

    constructor(values: ApiRequestRoundEntityValues) {
        Object.assign(this, values)
    }
}

export function toApiRequestRoundEntity(record: ApiRequestRoundRecord): ApiRequestRoundEntity {
    assertApiRequestRoundRecord(record)
    const providerDurationMs = record.providerDurationMs
    if (providerDurationMs === undefined || record.usageQuality === "legacy") {
        throw new Error("Legacy API request rounds cannot be written to the exact round store")
    }
    return new ApiRequestRoundEntity({
        ...record,
        providerDurationMs,
        inputTokens: record.inputTokens ?? null,
        outputTokens: record.outputTokens ?? null,
        thoughtsTokens: record.thoughtsTokens ?? null,
        cacheWriteTokens: record.cacheWriteTokens ?? null,
        cacheReadTokens: record.cacheReadTokens ?? null,
        totalCost: record.totalCost ?? null,
        currency: record.currency ?? null,
    })
}

export function fromApiRequestRoundEntity(entity: ApiRequestRoundEntity): ApiRequestRoundRecord {
    const record: ApiRequestRoundRecord = {
        schemaVersion: API_REQUEST_ROUND_SCHEMA_VERSION,
        taskId: entity.taskId,
        roundId: entity.roundId,
        revision: entity.revision,
        logicalRequestId: entity.logicalRequestId,
        apiIndex: entity.apiIndex,
        taskAttempt: entity.taskAttempt,
        providerAttempt: entity.providerAttempt,
        startedAtMs: entity.startedAtMs,
        completedAtMs: entity.completedAtMs,
        providerDurationMs: entity.providerDurationMs,
        status: entity.status,
        cacheUsageReported: entity.cacheUsageReported,
        usageQuality: entity.usageQuality,
        ...(entity.inputTokens === null ? {} : { inputTokens: entity.inputTokens }),
        ...(entity.outputTokens === null ? {} : { outputTokens: entity.outputTokens }),
        ...(entity.thoughtsTokens === null ? {} : { thoughtsTokens: entity.thoughtsTokens }),
        ...(entity.cacheWriteTokens === null ? {} : { cacheWriteTokens: entity.cacheWriteTokens }),
        ...(entity.cacheReadTokens === null ? {} : { cacheReadTokens: entity.cacheReadTokens }),
        ...(entity.totalCost === null ? {} : { totalCost: entity.totalCost }),
        ...(entity.currency === null ? {} : { currency: entity.currency }),
    }
    assertApiRequestRoundRecord(record)
    return record
}

export function assertApiRequestRoundRecord(record: ApiRequestRoundRecord): void {
    if (record.schemaVersion !== API_REQUEST_ROUND_SCHEMA_VERSION) throw new Error("Unsupported API request round schema version")
    if (!record.taskId || !record.roundId || !record.logicalRequestId) throw new Error("API request round identity is incomplete")
    for (const [name, value] of [
        ["revision", record.revision],
        ["apiIndex", record.apiIndex],
        ["taskAttempt", record.taskAttempt],
        ["providerAttempt", record.providerAttempt],
    ] as const) {
        if (!Number.isSafeInteger(value) || value < 0) throw new Error(`API request round ${name} must be a non-negative integer`)
    }
    for (const [name, value] of [
        ["startedAtMs", record.startedAtMs],
        ["completedAtMs", record.completedAtMs],
    ] as const) {
        if (!Number.isFinite(value) || value < 0) throw new Error(`API request round ${name} must be non-negative and finite`)
    }
    if (
        record.providerDurationMs !== undefined &&
        (!Number.isFinite(record.providerDurationMs) || record.providerDurationMs < 0)
    ) {
        throw new Error("API request round providerDurationMs must be non-negative and finite")
    }
    if (record.completedAtMs < record.startedAtMs) throw new Error("API request round completion cannot precede start")
    for (const [name, value] of [
        ["inputTokens", record.inputTokens],
        ["outputTokens", record.outputTokens],
        ["thoughtsTokens", record.thoughtsTokens],
        ["cacheWriteTokens", record.cacheWriteTokens],
        ["cacheReadTokens", record.cacheReadTokens],
    ] as const) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
            throw new Error(`API request round ${name} must be a non-negative integer`)
        }
    }
    if (record.totalCost !== undefined && (!Number.isFinite(record.totalCost) || record.totalCost < 0)) {
        throw new Error("API request round totalCost must be non-negative and finite")
    }
}
