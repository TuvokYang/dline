import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type { UnifyStore } from "@core/storage/backend/api/UnifyStore"
import { ensureTaskDirectoryExists, GlobalFileNames } from "@core/storage/disk"
import {
    ApiRateMetricsEntity,
    type ApiRateMetricsMigrationMarker,
    fromApiRateMetricsEntity,
    sanitizeDataRecord,
    sanitizeMeta,
    sanitizeMigrationMarker,
    toApiRateMetricsEntity,
} from "./api-rate-metrics-record-codec"
import {
    API_RATE_METRICS_SCHEMA_VERSION,
    ApiRateMetricsFileIntegrityError,
    type ApiRateMetricsFileRecord,
} from "./api-rate-metrics-types"

export interface ApiRateMetricsLegacyMigrationResult {
    imported: boolean
    marker?: ApiRateMetricsMigrationMarker
}

export interface ApiRateMetricsLegacyMigrationOptions {
    taskId: string
    collection: UnifyStore<ApiRateMetricsEntity>
    sourcePath?: string
    now?: () => number
}

export async function migrateLegacyApiRateMetrics(
    options: ApiRateMetricsLegacyMigrationOptions,
): Promise<ApiRateMetricsLegacyMigrationResult> {
    const sourcePath = options.sourcePath ?? (await defaultLegacyPath(options.taskId))
    let content: string
    try {
        content = await fs.readFile(sourcePath, "utf8")
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { imported: false }
        throw error
    }
    if (content.trim().length === 0) return { imported: false }

    const fingerprint = createHash("sha256").update(content).digest("hex")
    const existing = await collectStoredRecords(options.collection)
    const existingMarker = existing
        .map(fromApiRateMetricsEntity)
        .map(sanitizeMigrationMarker)
        .find((marker) => marker?.migrationKey === "legacy-api-rate-metrics-jsonl-v1")
    if (existingMarker) {
        if (existingMarker.sourceFingerprint !== fingerprint) {
            throw new ApiRateMetricsFileIntegrityError(
                `Legacy API rate metrics changed after migration for Task ${options.taskId}`,
            )
        }
        return { imported: false, marker: existingMarker }
    }
    if (existing.length > 0) {
        throw new ApiRateMetricsFileIntegrityError(
            `Cannot migrate legacy API rate metrics into a non-empty target for Task ${options.taskId}`,
        )
    }

    const parsed = parseLegacyMetrics(content, options.taskId)
    const marker: ApiRateMetricsMigrationMarker = {
        schemaVersion: API_RATE_METRICS_SCHEMA_VERSION,
        kind: "migration",
        migrationKey: "legacy-api-rate-metrics-jsonl-v1",
        sourceFingerprint: fingerprint,
        importedRecords: parsed.records.length,
        degraded: parsed.degraded,
        completedAt: (options.now ?? Date.now)(),
    }
    const imported = [...parsed.records.map(toApiRateMetricsEntity), toApiRateMetricsEntity(marker)]
    let importedByThisCall = false
    let committedMarker = marker
    await options.collection.transaction(async (transaction) => {
        const current = await queryStoredEntities(transaction)
        const currentMarker = current
            .map(fromApiRateMetricsEntity)
            .map(sanitizeMigrationMarker)
            .find((candidate) => candidate?.migrationKey === "legacy-api-rate-metrics-jsonl-v1")
        if (currentMarker) {
            if (currentMarker.sourceFingerprint !== fingerprint) {
                throw new ApiRateMetricsFileIntegrityError(
                    `Legacy API rate metrics changed after migration for Task ${options.taskId}`,
                )
            }
            committedMarker = currentMarker
            return
        }
        if (current.length > 0) {
            throw new ApiRateMetricsFileIntegrityError(
                `Cannot migrate legacy API rate metrics into a non-empty target for Task ${options.taskId}`,
            )
        }
        await transaction.replaceAll(imported)
        importedByThisCall = true
    })
    return { imported: importedByThisCall, marker: committedMarker }
}

export function parseLegacyMetrics(content: string, taskId: string): { records: ApiRateMetricsFileRecord[]; degraded: boolean } {
    const trailingNewline = content.endsWith("\n")
    const lines = content.split(/\r?\n/)
    const nonEmpty = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.trim().length > 0)
    if (nonEmpty.length === 0) {
        throw new ApiRateMetricsFileIntegrityError(`Missing API rate metrics metadata for Task ${taskId}`)
    }

    let first: unknown
    try {
        first = JSON.parse(nonEmpty[0].line) as unknown
    } catch {
        throw new ApiRateMetricsFileIntegrityError(`Invalid API rate metrics metadata for Task ${taskId}`)
    }
    const meta = sanitizeMeta(first)
    if (!meta) throw new ApiRateMetricsFileIntegrityError(`Invalid API rate metrics metadata for Task ${taskId}`)
    if (meta.taskId !== taskId) {
        throw new ApiRateMetricsFileIntegrityError(`API rate metrics Task mismatch: expected ${taskId}, received ${meta.taskId}`)
    }

    const records: ApiRateMetricsFileRecord[] = [meta]
    let degraded = false
    for (let index = 1; index < nonEmpty.length; index++) {
        const entry = nonEmpty[index]
        let value: unknown
        try {
            value = JSON.parse(entry.line) as unknown
        } catch {
            const isPartialTail = index === nonEmpty.length - 1 && !trailingNewline
            if (!isPartialTail) degraded = true
            continue
        }
        const record = sanitizeDataRecord(value)
        if (record) records.push(record)
        else degraded = true
    }
    return { records, degraded }
}

interface MetricsEntityReader {
    query(
        query?: Parameters<UnifyStore<ApiRateMetricsEntity>["query"]>[0],
    ): Promise<ApiRateMetricsEntity[] | { records: ApiRateMetricsEntity[] }>
}

async function collectStoredRecords(collection: UnifyStore<ApiRateMetricsEntity>): Promise<ApiRateMetricsEntity[]> {
    return await queryStoredEntities(collection)
}

async function queryStoredEntities(reader: MetricsEntityReader): Promise<ApiRateMetricsEntity[]> {
    const result = await reader.query()
    return Array.isArray(result) ? result : result.records
}

async function defaultLegacyPath(taskId: string): Promise<string> {
    return path.join(await ensureTaskDirectoryExists(taskId), GlobalFileNames.taskApiRateMetrics)
}
