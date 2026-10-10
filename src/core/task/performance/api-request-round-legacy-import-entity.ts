import { column, defineEntity } from "@core/storage/backend/api/EntitySchema"

export type ApiRequestRoundLegacyImportKind = "legacy_round" | "aggregate" | "marker"

export interface ApiRequestRoundLegacyImportEntityValues {
    recordKey: string
    schemaVersion: number
    taskId: string
    kind: ApiRequestRoundLegacyImportKind
    sourceKey: string | null
    messageTs: number
    roundId: string | null
    logicalRequestId: string | null
    apiIndex: number | null
    inputTokens: number | null
    outputTokens: number | null
    cacheWriteTokens: number | null
    cacheReadTokens: number | null
    cacheUsageReported: boolean
    totalCost: number | null
    currency: string | null
    aggregateKind: string | null
    sourceFingerprint: string | null
    importedRoundCount: number
    importedAggregateCount: number
    degraded: boolean
    importedAtMs: number
}

/** Flat durable rows for legacy UIMessage usage, aggregate-only facts, and the import marker. */
export class ApiRequestRoundLegacyImportEntity implements ApiRequestRoundLegacyImportEntityValues {
    static readonly storage = defineEntity<ApiRequestRoundLegacyImportEntity>()({
        schemaId: "api-request-round-legacy-import-flat",
        version: 1,
        columns: {
            recordKey: column.text({ primary: true }),
            schemaVersion: column.integer(),
            taskId: column.text({ indexed: true }),
            kind: column.enumText(["legacy_round", "aggregate", "marker"] as const, { indexed: true }),
            sourceKey: column.text({ nullable: true, indexed: true }),
            messageTs: column.real({ indexed: true }),
            roundId: column.text({ nullable: true, indexed: true }),
            logicalRequestId: column.text({ nullable: true }),
            apiIndex: column.integer({ nullable: true }),
            inputTokens: column.integer({ nullable: true }),
            outputTokens: column.integer({ nullable: true }),
            cacheWriteTokens: column.integer({ nullable: true }),
            cacheReadTokens: column.integer({ nullable: true }),
            cacheUsageReported: column.boolean(),
            totalCost: column.real({ nullable: true }),
            currency: column.text({ nullable: true }),
            aggregateKind: column.text({ nullable: true }),
            sourceFingerprint: column.text({ nullable: true }),
            importedRoundCount: column.integer(),
            importedAggregateCount: column.integer(),
            degraded: column.boolean(),
            importedAtMs: column.real(),
        },
        indexes: [
            { name: "api-request-round-legacy-task-kind-time", fields: ["taskId", "kind", "messageTs"] },
            { name: "api-request-round-legacy-task-source", fields: ["taskId", "sourceKey"], unique: true },
        ],
        defaultOrder: [{ field: "recordKey", direction: "asc" }],
        hydrate: (values) => new ApiRequestRoundLegacyImportEntity(values),
    })

    readonly recordKey!: string
    readonly schemaVersion!: number
    readonly taskId!: string
    readonly kind!: ApiRequestRoundLegacyImportKind
    readonly sourceKey!: string | null
    readonly messageTs!: number
    readonly roundId!: string | null
    readonly logicalRequestId!: string | null
    readonly apiIndex!: number | null
    readonly inputTokens!: number | null
    readonly outputTokens!: number | null
    readonly cacheWriteTokens!: number | null
    readonly cacheReadTokens!: number | null
    readonly cacheUsageReported!: boolean
    readonly totalCost!: number | null
    readonly currency!: string | null
    readonly aggregateKind!: string | null
    readonly sourceFingerprint!: string | null
    readonly importedRoundCount!: number
    readonly importedAggregateCount!: number
    readonly degraded!: boolean
    readonly importedAtMs!: number

    constructor(values: ApiRequestRoundLegacyImportEntityValues) {
        Object.assign(this, values)
    }
}
