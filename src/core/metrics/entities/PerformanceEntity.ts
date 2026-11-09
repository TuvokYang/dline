/**
 * The `performance` table's persisted schema.
 *
 * Durations and counts are stored as accumulators, never as means, so a reader can
 * recombine any set of buckets without having averaged an average. The identity
 * prefix is shared with usage; `factKind` is added because one Provider round and one
 * logical execution are different observations that must never share a counter.
 */

import { column, defineEntity } from "@core/storage/backend/api/EntitySchema"
import type { MetricsResolution, MetricsRowIdentity, PerformanceFactKind, PerformanceQuality } from "@shared/metrics/types"

/**
 * Stays at 1: this table has never shipped, so no persisted row predates
 * `executionDurationCoverage`.
 *
 * Raising the version would not rebuild anything. `ensureEntitySchema` throws
 * `Entity schema conflict` when the stored version differs, which would make the whole
 * ledger unopenable — usage included — instead of repairing one average.
 */
export const PERFORMANCE_SCHEMA_VERSION = 1 as const

/** One persisted performance row. */
export interface PerformanceEntityValues extends MetricsRowIdentity {
    readonly providerId: string
    readonly factKind: PerformanceFactKind
    readonly providerDurationMs: number
    readonly executionDurationMs: number
    readonly generationDurationMs: number
    readonly ttftMs: number
    readonly requestCount: number
    readonly completedCount: number
    readonly failedCount: number
    readonly cancelledCount: number
    readonly abortedCount: number
    readonly providerRoundCount: number
    readonly executionCount: number
    readonly perfQuality: PerformanceQuality
    /**
     * Provider attempts that contributed a duration; the provider average's divisor.
     *
     * A totals read sums rows of both fact kinds, so the execution average needs its own
     * divisor here. Sharing one counter made a provider duration divide by provider *and*
     * execution attempts.
     */
    readonly durationCoverage: number
    /** Logical executions that contributed a duration; the execution average's divisor. */
    readonly executionDurationCoverage: number
    readonly ttftCoverage: number
    readonly aggregatedAt: string
}

/**
 * Primary key of a performance row.
 *
 * `factKind` sits inside the identity on purpose: folding provider and execution facts
 * into one row would make the execution RPM denominator count Provider rounds.
 */
export class PerformanceEntity implements PerformanceEntityValues {
    static readonly storage = defineEntity<PerformanceEntity>()({
        schemaId: "metrics-performance",
        version: PERFORMANCE_SCHEMA_VERSION,
        columns: {
            scopeId: column.text({ primary: true }),
            resolution: column.enumText(["minute", "hour", "day"] as const, { primary: true }),
            bucketStartMs: column.real({ primary: true }),
            modelId: column.text({ primary: true }),
            taskId: column.text({ primary: true }),
            profileId: column.text({ primary: true }),
            keyFingerprint: column.text({ primary: true }),
            factKind: column.enumText(["provider", "execution"] as const, { primary: true }),
            providerId: column.text({ indexed: true }),
            providerDurationMs: column.real(),
            executionDurationMs: column.real(),
            generationDurationMs: column.real(),
            ttftMs: column.real(),
            requestCount: column.integer(),
            completedCount: column.integer(),
            failedCount: column.integer(),
            cancelledCount: column.integer(),
            abortedCount: column.integer(),
            providerRoundCount: column.integer(),
            executionCount: column.integer(),
            perfQuality: column.enumText(["exact", "estimated", "unknown", "mixed"] as const),
            durationCoverage: column.integer(),
            executionDurationCoverage: column.integer(),
            ttftCoverage: column.integer(),
            aggregatedAt: column.text(),
        },
        indexes: [
            { name: "metrics-performance-bucket", fields: ["scopeId", "resolution", "bucketStartMs"] },
            { name: "metrics-performance-profile-day", fields: ["scopeId", "profileId", "resolution", "bucketStartMs"] },
            { name: "metrics-performance-task", fields: ["scopeId", "taskId"] },
        ],
        defaultOrder: [{ field: "bucketStartMs", direction: "asc" }],
        hydrate: (values) => new PerformanceEntity(values),
    })

    readonly scopeId!: string
    readonly resolution!: MetricsResolution
    readonly bucketStartMs!: number
    readonly modelId!: string
    readonly taskId!: string
    readonly profileId!: string
    readonly keyFingerprint!: string
    readonly factKind!: PerformanceFactKind
    readonly providerId!: string
    readonly providerDurationMs!: number
    readonly executionDurationMs!: number
    readonly generationDurationMs!: number
    readonly ttftMs!: number
    readonly requestCount!: number
    readonly completedCount!: number
    readonly failedCount!: number
    readonly cancelledCount!: number
    readonly abortedCount!: number
    readonly providerRoundCount!: number
    readonly executionCount!: number
    readonly perfQuality!: PerformanceQuality
    readonly durationCoverage!: number
    readonly executionDurationCoverage!: number
    readonly ttftCoverage!: number
    readonly aggregatedAt!: string

    constructor(values: PerformanceEntityValues) {
        Object.assign(this, values)
    }
}
