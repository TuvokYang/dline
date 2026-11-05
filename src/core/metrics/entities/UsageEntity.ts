/**
 * The `usage` table's persisted schema.
 *
 * Every column the aggregation needs is a stored accumulator: derived values (cache
 * rate, averages) are recomputed on read so no bucket can claim a pre-averaged number.
 *
 * The persisted shape uses `null` for an absent value because the storage layer's
 * nullable column accepts nothing else. Only these two columns are nullable, and they
 * are exactly the pair that must stay distinguishable from a real value: a missing
 * cost is not `0`, and a missing currency is not a currency.
 */

import { column, defineEntity } from "@core/storage/backend/api/EntitySchema"
import type { MetricsResolution, MetricsRowIdentity, UsageQuality } from "@shared/metrics/types"

export const USAGE_SCHEMA_VERSION = 1 as const

/** One persisted usage row. `cost`/`currency` are `null` when no complete total exists. */
export interface UsageEntityValues extends MetricsRowIdentity {
    readonly providerId: string
    readonly inputTokens: number
    readonly outputTokens: number
    readonly thoughtsTokens: number
    readonly cacheWriteTokens: number
    readonly cacheReadTokens: number
    readonly cacheNumerator: number
    readonly cacheDenominator: number
    readonly usageAvailable: boolean
    readonly cacheUsageAvailable: boolean
    readonly cost: number | null
    readonly currency: string | null
    readonly currencyMixed: boolean
    readonly costAvailable: boolean
    readonly usageQuality: UsageQuality
    readonly respondingRequests: number
    readonly aggregatedAt: string
}

/**
 * Primary key of a usage row.
 *
 * `resolution` is part of the identity, so a rolled-up hour can never be summed
 * together with the minute rows it replaced, and a query cannot accidentally treat
 * one as the other.
 */
export class UsageEntity implements UsageEntityValues {
    static readonly storage = defineEntity<UsageEntity>()({
        schemaId: "metrics-usage",
        version: USAGE_SCHEMA_VERSION,
        columns: {
            scopeId: column.text({ primary: true }),
            resolution: column.enumText(["minute", "hour", "day"] as const, { primary: true }),
            bucketStartMs: column.real({ primary: true }),
            modelId: column.text({ primary: true }),
            taskId: column.text({ primary: true }),
            profileId: column.text({ primary: true }),
            keyFingerprint: column.text({ primary: true }),
            providerId: column.text({ indexed: true }),
            inputTokens: column.integer(),
            outputTokens: column.integer(),
            thoughtsTokens: column.integer(),
            cacheWriteTokens: column.integer(),
            cacheReadTokens: column.integer(),
            cacheNumerator: column.integer(),
            cacheDenominator: column.integer(),
            usageAvailable: column.boolean(),
            cacheUsageAvailable: column.boolean(),
            cost: column.real({ nullable: true }),
            currency: column.text({ nullable: true }),
            currencyMixed: column.boolean(),
            costAvailable: column.boolean(),
            usageQuality: column.enumText(["none", "estimated", "exact", "mixed", "legacy"] as const),
            respondingRequests: column.integer(),
            aggregatedAt: column.text(),
        },
        indexes: [
            { name: "metrics-usage-bucket", fields: ["scopeId", "resolution", "bucketStartMs"] },
            { name: "metrics-usage-profile-day", fields: ["scopeId", "profileId", "resolution", "bucketStartMs"] },
            { name: "metrics-usage-task", fields: ["scopeId", "taskId"] },
        ],
        defaultOrder: [{ field: "bucketStartMs", direction: "asc" }],
        hydrate: (values) => new UsageEntity(values),
    })

    readonly scopeId!: string
    readonly resolution!: MetricsResolution
    readonly bucketStartMs!: number
    readonly modelId!: string
    readonly taskId!: string
    readonly profileId!: string
    readonly keyFingerprint!: string
    readonly providerId!: string
    readonly inputTokens!: number
    readonly outputTokens!: number
    readonly thoughtsTokens!: number
    readonly cacheWriteTokens!: number
    readonly cacheReadTokens!: number
    readonly cacheNumerator!: number
    readonly cacheDenominator!: number
    readonly usageAvailable!: boolean
    readonly cacheUsageAvailable!: boolean
    readonly cost!: number | null
    readonly currency!: string | null
    readonly currencyMixed!: boolean
    readonly costAvailable!: boolean
    readonly usageQuality!: UsageQuality
    readonly respondingRequests!: number
    readonly aggregatedAt!: string

    constructor(values: UsageEntityValues) {
        Object.assign(this, values)
    }
}
