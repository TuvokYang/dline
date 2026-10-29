import { createHash } from "node:crypto"
import type { UnifyStore } from "@core/storage/backend/api/UnifyStore"
import { asc, eq } from "@core/storage/backend/api/UnifyStoreQuery"
import { LEGACY_API_RATE_METRICS_PARTITION, LegacyApiRateMetricsWrapperEntity } from "./api-rate-metrics-legacy-wrapper-entity"
import {
    ApiRateMetricsEntity,
    type ApiRateMetricsMigrationMarker,
    type ApiRateMetricsStoredRecord,
    fromApiRateMetricsEntity,
    toApiRateMetricsEntity,
} from "./api-rate-metrics-record-codec"
import {
    API_RATE_METRICS_SCHEMA_VERSION,
    ApiRateMetricsFileIntegrityError,
    type ApiRateMetricsMetaRecord,
} from "./api-rate-metrics-types"

export interface ApiRateMetricsWrapperMigrationOptions {
    readonly taskId: string
    readonly source: UnifyStore<LegacyApiRateMetricsWrapperEntity>
    readonly target: UnifyStore<ApiRateMetricsEntity>
    readonly now?: () => number
}

export interface ApiRateMetricsWrapperMigrationResult {
    readonly imported: boolean
    readonly marker: ApiRateMetricsMigrationMarker
}

/** Migrate the obsolete wrapper entity into the flat class-first metrics schema. */
export async function migrateApiRateMetricsWrapper(
    options: ApiRateMetricsWrapperMigrationOptions,
): Promise<ApiRateMetricsWrapperMigrationResult> {
    const sourceRows = await queryLegacyRows(options.source)
    if (sourceRows.length === 0) {
        throw new ApiRateMetricsFileIntegrityError(`Legacy API rate metrics wrapper is empty for Task ${options.taskId}`)
    }
    const records = sourceRows.map(validateLegacyRow)
    validateTaskMetadata(records, options.taskId)
    const sourceFingerprint = fingerprintLegacyRows(sourceRows)
    const marker: ApiRateMetricsMigrationMarker = {
        schemaVersion: API_RATE_METRICS_SCHEMA_VERSION,
        kind: "migration",
        migrationKey: "api-rate-metrics-sqlite-wrapper-v1",
        sourceFingerprint,
        importedRecords: records.length,
        degraded: records.some((record) => record.kind === "migration" && record.degraded),
        completedAt: (options.now ?? Date.now)(),
    }
    let imported = false
    let committedMarker = marker
    await options.target.transaction(async (transaction) => {
        const current = await transaction.query()
        const currentRecords = current.map(fromApiRateMetricsEntity)
        const existing = currentRecords.find(
            (record): record is ApiRateMetricsMigrationMarker =>
                record.kind === "migration" && record.migrationKey === marker.migrationKey,
        )
        if (existing) {
            if (existing.sourceFingerprint !== sourceFingerprint || existing.importedRecords !== records.length) {
                throw new ApiRateMetricsFileIntegrityError(
                    `Legacy SQLite API rate metrics changed after migration for Task ${options.taskId}`,
                )
            }
            committedMarker = existing
            return
        }
        if (current.length > 0) {
            throw new ApiRateMetricsFileIntegrityError(
                `Cannot migrate legacy SQLite API rate metrics into a non-empty flat target for Task ${options.taskId}`,
            )
        }
        await transaction.replaceAll([...records.map(toApiRateMetricsEntity), toApiRateMetricsEntity(marker)])
        imported = true
    })
    return { imported, marker: committedMarker }
}

async function queryLegacyRows(
    source: UnifyStore<LegacyApiRateMetricsWrapperEntity>,
): Promise<LegacyApiRateMetricsWrapperEntity[]> {
    const fields = LegacyApiRateMetricsWrapperEntity.storage.fields
    return (
        await source.query({
            where: eq(fields.partition, LEGACY_API_RATE_METRICS_PARTITION),
            orderBy: [asc(fields.sortKey), asc(fields.logicalKey), asc(fields.revision)],
        })
    ).records
}

function validateLegacyRow(row: LegacyApiRateMetricsWrapperEntity): ApiRateMetricsStoredRecord {
    const expected = legacyProjection(row.record)
    if (
        row.partition !== LEGACY_API_RATE_METRICS_PARTITION ||
        row.logicalKey !== expected.logicalKey ||
        row.sortKey !== expected.sortKey ||
        row.revision !== expected.revision
    ) {
        throw new ApiRateMetricsFileIntegrityError(`Invalid legacy API rate metrics wrapper row ${row.logicalKey}`)
    }
    return row.record
}

function legacyProjection(record: ApiRateMetricsStoredRecord): {
    readonly logicalKey: string
    readonly sortKey: number
    readonly revision: number
} {
    if (record.kind === "migration") {
        return { logicalKey: `migration:${record.migrationKey}`, sortKey: -2, revision: 0 }
    }
    if (record.kind === "meta") return { logicalKey: "meta", sortKey: -1, revision: 0 }
    if (record.kind === "second") {
        return { logicalKey: `second:${record.second}`, sortKey: record.second, revision: record.revision }
    }
    return {
        logicalKey: `rollup:${record.resolution}:${record.bucketStartSecond}`,
        sortKey: record.bucketStartSecond,
        revision: 0,
    }
}

function validateTaskMetadata(records: readonly ApiRateMetricsStoredRecord[], taskId: string): void {
    const metadata = records.filter((record): record is ApiRateMetricsMetaRecord => record.kind === "meta")
    if (metadata.length !== 1 || metadata[0].taskId !== taskId) {
        throw new ApiRateMetricsFileIntegrityError(
            `API rate metrics Task mismatch: expected ${taskId}, received ${metadata[0]?.taskId ?? "unknown"}`,
        )
    }
}

function fingerprintLegacyRows(rows: readonly LegacyApiRateMetricsWrapperEntity[]): string {
    return createHash("sha256")
        .update(
            JSON.stringify(
                rows.map(({ partition, logicalKey, sortKey, revision, record }) => ({
                    partition,
                    logicalKey,
                    sortKey,
                    revision,
                    record,
                })),
            ),
        )
        .digest("hex")
}
