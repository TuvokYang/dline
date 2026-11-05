/**
 * The `metrics_metadata` table: the ledger's own bookkeeping.
 *
 * This is not a third daily account. It holds exactly the facts that must be decided
 * in the same transaction as the numbers they describe: which events were already
 * received, how far back late events are still accepted, and whether a one-time
 * legacy import already happened. Keeping them in the ledger's database is what makes
 * "receipt committed but numbers lost" impossible.
 */

import { column, defineEntity } from "@core/storage/backend/api/EntitySchema"

export const METRICS_METADATA_SCHEMA_VERSION = 1 as const

/** Metadata row kinds. One row per kind, per scope, per subject. */
export type MetricsMetadataKind = "receipt" | "acceptance_floor" | "legacy_marker" | "legacy_baseline"

/** One persisted metadata row. */
export interface MetricsMetadataEntityValues {
    readonly scopeId: string
    readonly kind: MetricsMetadataKind
    /**
     * The subject this row is about.
     *
     * Receipts use the idempotency key, the acceptance floor uses the empty string
     * (one per scope), and legacy rows use the legacy account key.
     */
    readonly subjectKey: string
    /** Event identity for a receipt; empty for every other kind. */
    readonly eventId: string
    /** Task that produced a receipt; empty for scope-wide kinds. */
    readonly taskId: string
    /** Acceptance floor in epoch milliseconds; `null` for non-floor kinds. */
    readonly floorMs: number | null
    /**
     * Observation time of the event a receipt describes; `null` for non-receipt kinds.
     *
     * Retention keeps this so a receipt can be dropped exactly when the acceptance
     * floor already rejects its event, instead of keeping receipts forever.
     */
    readonly observedAtMs: number | null
    /** Numeric baseline a legacy import froze; `null` when not a legacy baseline. */
    readonly legacyInputTokens: number | null
    readonly legacyOutputTokens: number | null
    readonly legacyCost: number | null
    readonly legacyCurrency: string | null
    /** ISO time the row was written, for diagnostics only. */
    readonly recordedAt: string
}

/**
 * Primary key of a metadata row.
 *
 * `kind` is part of the identity so a receipt and the acceptance floor of the same
 * scope can never overwrite each other.
 */
export class MetricsMetadataEntity implements MetricsMetadataEntityValues {
    static readonly storage = defineEntity<MetricsMetadataEntity>()({
        schemaId: "metrics-metadata",
        version: METRICS_METADATA_SCHEMA_VERSION,
        columns: {
            scopeId: column.text({ primary: true }),
            kind: column.enumText(["receipt", "acceptance_floor", "legacy_marker", "legacy_baseline"] as const, {
                primary: true,
            }),
            subjectKey: column.text({ primary: true }),
            eventId: column.text(),
            taskId: column.text(),
            floorMs: column.real({ nullable: true }),
            observedAtMs: column.real({ nullable: true }),
            legacyInputTokens: column.integer({ nullable: true }),
            legacyOutputTokens: column.integer({ nullable: true }),
            legacyCost: column.real({ nullable: true }),
            legacyCurrency: column.text({ nullable: true }),
            recordedAt: column.text(),
        },
        indexes: [
            { name: "metrics-metadata-task", fields: ["scopeId", "taskId"] },
            { name: "metrics-metadata-kind", fields: ["scopeId", "kind"] },
        ],
        defaultOrder: [{ field: "recordedAt", direction: "asc" }],
        hydrate: (values) => new MetricsMetadataEntity(values),
    })

    readonly scopeId!: string
    readonly kind!: MetricsMetadataKind
    readonly subjectKey!: string
    readonly eventId!: string
    readonly taskId!: string
    readonly floorMs!: number | null
    readonly observedAtMs!: number | null
    readonly legacyInputTokens!: number | null
    readonly legacyOutputTokens!: number | null
    readonly legacyCost!: number | null
    readonly legacyCurrency!: string | null
    readonly recordedAt!: string

    constructor(values: MetricsMetadataEntityValues) {
        Object.assign(this, values)
    }
}
