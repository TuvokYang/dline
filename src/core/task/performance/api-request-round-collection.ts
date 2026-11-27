import type { UnifyStore } from "@core/storage/backend/api/UnifyStore"
import { physicalTableName, quoteIdentifier } from "@core/storage/backend/sqlite/SqliteSchemaCompiler"
import { SqliteUnifyStoreBackend } from "@core/storage/backend/sqlite/SqliteUnifyStore"
import { resolveTaskMetricsDatabase } from "@core/storage/task-metrics-database"
import { ApiRequestRoundEntity } from "./api-request-round-entity"

export interface ApiRequestRoundCollectionOptions {
    readonly taskId: string
    readonly location?: string
    readonly readOnly?: boolean
}

export interface ExactCumulativeRoundUsage {
    readonly usageAvailable: boolean
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheWriteTokens: number
    readonly cacheReadTokens: number
    readonly cacheNumerator: number
    readonly cacheDenominator: number
    readonly costAvailable: boolean
    readonly totalCost: number
    readonly distinctCurrencies: number
    readonly singleCurrency?: string
}

export interface ApiRequestRoundCollection extends UnifyStore<ApiRequestRoundEntity> {
    /**
     * Aggregate cumulative usage over every recorded round of `taskId` inside SQLite.
     *
     * Computing the sum in SQLite avoids both truncating lifetime totals to a chart
     * round budget and materializing tens of thousands of entities into JS memory.
     */
    readExactCumulativeUsage(taskId: string): Promise<ExactCumulativeRoundUsage>
}

interface CumulativeAggregateRow {
    readonly usageCount: number
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheWriteTokens: number
    readonly cacheReadTokens: number
    readonly cacheNumerator: number
    readonly cacheDenominator: number
    readonly costCount: number
    readonly totalCost: number
    readonly distinctCurrencies: number
    readonly singleCurrency: string | null
}

const ROUND_TABLE = quoteIdentifier(physicalTableName(ApiRequestRoundEntity.storage.schemaId))

const EXACT_CUMULATIVE_USAGE_SQL = `
WITH latest AS (
    SELECT
        "usageQuality",
        "inputTokens",
        "outputTokens",
        "cacheWriteTokens",
        "cacheReadTokens",
        "cacheUsageReported",
        "totalCost",
        "currency",
        MAX("revision")
    FROM ${ROUND_TABLE}
    WHERE "taskId" = ?
    GROUP BY "roundId"
)
SELECT
    COALESCE(SUM(CASE WHEN "inputTokens" IS NOT NULL AND "outputTokens" IS NOT NULL THEN 1 ELSE 0 END), 0) AS usageCount,
    COALESCE(SUM(CASE WHEN "inputTokens" IS NOT NULL AND "outputTokens" IS NOT NULL THEN "inputTokens" ELSE 0 END), 0) AS inputTokens,
    COALESCE(SUM(CASE WHEN "inputTokens" IS NOT NULL AND "outputTokens" IS NOT NULL THEN "outputTokens" ELSE 0 END), 0) AS outputTokens,
    COALESCE(SUM(CASE WHEN "inputTokens" IS NOT NULL AND "outputTokens" IS NOT NULL THEN COALESCE("cacheWriteTokens", 0) ELSE 0 END), 0) AS cacheWriteTokens,
    COALESCE(SUM(CASE WHEN "inputTokens" IS NOT NULL AND "outputTokens" IS NOT NULL THEN COALESCE("cacheReadTokens", 0) ELSE 0 END), 0) AS cacheReadTokens,
    COALESCE(SUM(CASE
        WHEN "inputTokens" IS NOT NULL
         AND "outputTokens" IS NOT NULL
         AND "cacheUsageReported" = 1
         AND ("inputTokens" + COALESCE("cacheWriteTokens", 0) + COALESCE("cacheReadTokens", 0)) > 0
        THEN COALESCE("cacheReadTokens", 0)
        ELSE 0
    END), 0) AS cacheNumerator,
    COALESCE(SUM(CASE
        WHEN "inputTokens" IS NOT NULL
         AND "outputTokens" IS NOT NULL
         AND "cacheUsageReported" = 1
         AND ("inputTokens" + COALESCE("cacheWriteTokens", 0) + COALESCE("cacheReadTokens", 0)) > 0
        THEN ("inputTokens" + COALESCE("cacheWriteTokens", 0) + COALESCE("cacheReadTokens", 0))
        ELSE 0
    END), 0) AS cacheDenominator,
    COALESCE(SUM(CASE WHEN "totalCost" IS NOT NULL THEN 1 ELSE 0 END), 0) AS costCount,
    COALESCE(SUM(CASE WHEN "totalCost" IS NOT NULL THEN "totalCost" ELSE 0 END), 0) AS totalCost,
    COUNT(DISTINCT CASE WHEN "currency" IS NOT NULL AND LENGTH("currency") > 0 THEN "currency" END) AS distinctCurrencies,
    MIN(CASE WHEN "currency" IS NOT NULL AND LENGTH("currency") > 0 THEN "currency" END) AS singleCurrency
FROM latest
WHERE "usageQuality" != ?
`

export async function createApiRequestRoundCollection(
    options: ApiRequestRoundCollectionOptions,
): Promise<ApiRequestRoundCollection> {
    const databasePath = await resolveTaskMetricsDatabase(options.taskId, options.location, options.readOnly)
    const database = await new SqliteUnifyStoreBackend().open(databasePath, { readonly: options.readOnly })
    let store: UnifyStore<ApiRequestRoundEntity> | undefined
    try {
        store = await database.openStore(ApiRequestRoundEntity)
        const closeStore = store.close.bind(store)
        let closePromise: Promise<void> | undefined
        const collection = store as ApiRequestRoundCollection
        collection.close = () => {
            closePromise ??= closeStore().then(() => database.close())
            return closePromise
        }
        collection.readExactCumulativeUsage = (taskId: string) =>
            database.read((sqlite) => {
                const row = sqlite.prepare(EXACT_CUMULATIVE_USAGE_SQL).get(taskId, "none") as unknown as
                    | CumulativeAggregateRow
                    | undefined
                if (!row) {
                    return {
                        usageAvailable: false,
                        inputTokens: 0,
                        outputTokens: 0,
                        cacheWriteTokens: 0,
                        cacheReadTokens: 0,
                        cacheNumerator: 0,
                        cacheDenominator: 0,
                        costAvailable: false,
                        totalCost: 0,
                        distinctCurrencies: 0,
                    }
                }
                return {
                    usageAvailable: Number(row.usageCount) > 0,
                    inputTokens: Number(row.inputTokens),
                    outputTokens: Number(row.outputTokens),
                    cacheWriteTokens: Number(row.cacheWriteTokens),
                    cacheReadTokens: Number(row.cacheReadTokens),
                    cacheNumerator: Number(row.cacheNumerator),
                    cacheDenominator: Number(row.cacheDenominator),
                    costAvailable: Number(row.costCount) > 0,
                    totalCost: Number(row.totalCost),
                    distinctCurrencies: Number(row.distinctCurrencies),
                    ...(row.singleCurrency ? { singleCurrency: row.singleCurrency } : {}),
                }
            })
        return collection
    } catch (error) {
        await store?.close().catch(() => undefined)
        await database.close().catch(() => undefined)
        throw error
    }
}
