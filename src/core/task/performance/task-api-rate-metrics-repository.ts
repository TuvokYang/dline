import { performance } from "node:perf_hooks"
import type { UnifyStore, UnifyStoreResult, UnifyStoreStats } from "@core/storage/backend/api/UnifyStore"
import { and, asc, desc, eq, gte, latestPerGroup, lt } from "@core/storage/backend/api/UnifyStoreQuery"
import { Logger } from "@shared/services/Logger"
import {
    compactApiRateMetrics,
    HOUR_RETENTION_SECONDS,
    MINUTE_RETENTION_SECONDS,
    RAW_SECOND_RETENTION_SECONDS,
} from "./api-rate-metrics-aggregator"
import { createApiRateMetricsCollection } from "./api-rate-metrics-collection"
import { migrateLegacyApiRateMetrics } from "./api-rate-metrics-legacy-migration"
import {
    ApiRateMetricsEntity,
    type ApiRateMetricsMigrationKey,
    type ApiRateMetricsMigrationMarker,
    type ApiRateMetricsStoredRecord,
    fromApiRateMetricsEntity,
    sanitizeMigrationMarker,
    toApiRateMetricsEntity,
} from "./api-rate-metrics-record-codec"
import {
    API_RATE_METRICS_SCHEMA_VERSION,
    type ApiRateMetricsDataRecord,
    ApiRateMetricsFileIntegrityError,
    type ApiRateMetricsFileRecord,
    ApiRateMetricsHardLimitError,
    type ApiRateMetricsMetaRecord,
    type ApiRateMetricsRangeQuery,
    type ApiRateMetricsReadResult,
    type ApiRateMetricsRecovery,
    type ApiRateMetricsRepository,
    type ApiRateSecondRecord,
    getApiRateSecondActivitySeconds,
} from "./api-rate-metrics-types"

export interface TaskApiRateMetricsRepositoryOptions {
    taskId: string
    location?: string
    readOnly?: boolean
    legacySourcePath?: string
    migrateLegacy?: boolean
    now?: () => number
    compactionThresholdBytes?: number
    hardLimitBytes?: number
}

const MAX_RECENT_ACTIVE_SECONDS = 60
const DEFAULT_COMPACTION_THRESHOLD_BYTES = 32 * 1_024 * 1_024
const DEFAULT_HARD_LIMIT_BYTES = 64 * 1_024 * 1_024
const SLOW_APPEND_QUEUE_WAIT_MS = 100
const SLOW_APPEND_WRITE_MS = 25
/** Small stores measure initial logicalBytes exactly; large stores sample to avoid full-table open scans. */
const EXACT_INITIAL_BYTES_RECORD_LIMIT = 2_048
const RECENT_SECOND_INITIAL_SCAN_ROWS = 512
const RECENT_SECOND_MAX_SCAN_ROWS = 8_192
/** Backoff applied when a compaction pass cannot shrink logicalBytes below the trigger threshold. */
const COMPACTION_RETRY_GROWTH_BYTES = 4 * 1_024 * 1_024
const COMPACTION_RETRY_COOLDOWN_SECONDS = 30 * 60
/** Minimum relative row reduction required to justify a full-table rewrite when no rows aged into rollups. */
const MIN_DEDUP_COMPACTION_REDUCTION_RATIO = 0.1

/** Owns API rate metrics domain persistence while delegating physical storage to UnifyStore. */
export class TaskApiRateMetricsRepository implements ApiRateMetricsRepository {
    private readonly now: () => number
    private readonly compactionThresholdBytes: number
    private readonly hardLimitBytes: number
    private collection: UnifyStore<ApiRateMetricsEntity> | undefined
    private meta: ApiRateMetricsMetaRecord | undefined
    private readonly migrationMarkers = new Map<ApiRateMetricsMigrationKey, ApiRateMetricsMigrationMarker>()
    private initialization: Promise<ApiRateMetricsRecovery> | undefined
    private writeSequence: Promise<void> = Promise.resolve()
    private logicalBytes = 0
    private nextCompactionThresholdBytes: number
    private nextCompactionEligibleSecond = 0
    private closing = false
    private closed = false
    private closePromise: Promise<void> | undefined

    constructor(private readonly options: TaskApiRateMetricsRepositoryOptions) {
        this.now = options.now ?? Date.now
        this.compactionThresholdBytes = options.compactionThresholdBytes ?? DEFAULT_COMPACTION_THRESHOLD_BYTES
        this.hardLimitBytes = options.hardLimitBytes ?? DEFAULT_HARD_LIMIT_BYTES
        this.nextCompactionThresholdBytes = this.compactionThresholdBytes
    }

    initialize(): Promise<ApiRateMetricsRecovery> {
        if (this.closing || this.closed) return Promise.reject(new Error("API rate metrics repository is closed"))
        this.initialization ??= this.initializeInternal()
        return this.initialization
    }

    async append(records: readonly ApiRateMetricsDataRecord[]): Promise<void> {
        this.assertWritable()
        if (records.length === 0) return
        await this.initialize()
        const entities = records.map(toApiRateMetricsEntity)
        const payloadBytes = serializedBytes(records)
        const queuedAt = performance.now()
        return this.enqueueWrite(async () => {
            const startedAt = performance.now()
            this.assertWithinHardLimit(this.logicalBytes + payloadBytes, "append")
            await this.requireCollection().insert(entities)
            this.logicalBytes += payloadBytes
            const queueWaitMs = Math.round(startedAt - queuedAt)
            const writeMs = Math.round(performance.now() - startedAt)
            if (queueWaitMs >= SLOW_APPEND_QUEUE_WAIT_MS || writeMs >= SLOW_APPEND_WRITE_MS) {
                Logger.debug(
                    `[Task ${this.options.taskId}] API rate metrics slow append: queueWaitMs=${queueWaitMs}, writeMs=${writeMs}, records=${records.length}, bytes=${payloadBytes}`,
                )
            }
        })
    }

    async readAll(): Promise<ApiRateMetricsReadResult> {
        await this.initialize()
        await this.waitForWrites()
        const startedAt = performance.now()
        const collection = this.requireCollection()
        const physical = await queryMetricsEntities(collection, false)
        const canonical = await queryMetricsEntities(collection, true)
        const storedRecords = physical.records.map(fromApiRateMetricsEntity)
        const canonicalRecords = canonical.records.map(fromApiRateMetricsEntity)
        const records = storedRecords.filter(isDataRecord)
        const result = toReadResult(
            records,
            physical.stats,
            storedRecords.filter(isInternalRecord).length,
            canonicalRecords.filter(isDataRecord).length,
        )
        result.degraded ||= this.hasDegradedMigration()
        Logger.debug(
            `[Task ${this.options.taskId}] API rate metrics scan: durationMs=${Math.round(performance.now() - startedAt)}, storageBytes=${result.storageBytes}, physicalRecords=${result.physicalRecordCount ?? 0}, records=${records.length}, degraded=${result.degraded}`,
        )
        return result
    }

    async readRange(query: ApiRateMetricsRangeQuery): Promise<ApiRateMetricsReadResult> {
        await this.initialize()
        await this.waitForWrites()
        if (
            !Number.isSafeInteger(query.startSecond) ||
            !Number.isSafeInteger(query.endSecond) ||
            query.endSecond <= query.startSecond
        ) {
            throw new Error("API rate metrics range must use increasing integer seconds")
        }
        const collection = this.requireCollection()
        const physical = await queryMetricsRange(collection, query, false)
        const canonical = await queryMetricsRange(collection, query, true)
        const records = canonical.records.map(fromApiRateMetricsEntity).filter(isDataRecord)
        return {
            records,
            degraded: canonical.stats.degraded || this.hasDegradedMigration(),
            storageBytes: canonical.stats.storageBytes,
            logicalRecordCount: records.length,
            physicalRecordCount: physical.records.length,
        }
    }

    async replaceAll(records: readonly ApiRateMetricsDataRecord[]): Promise<void> {
        this.assertWritable()
        await this.initialize()
        const allRecords: ApiRateMetricsStoredRecord[] = [this.requireMeta(), ...this.migrationMarkers.values(), ...records]
        const payloadBytes = serializedBytes(allRecords.filter(isFileRecord))
        const queuedAt = performance.now()
        return this.enqueueWrite(async () => {
            const startedAt = performance.now()
            this.assertWithinHardLimit(payloadBytes, "replace")
            await this.requireCollection().replaceAll(allRecords.map(toApiRateMetricsEntity))
            this.logicalBytes = payloadBytes
            Logger.debug(
                `[Task ${this.options.taskId}] API rate metrics replace: queueWaitMs=${Math.round(startedAt - queuedAt)}, writeMs=${Math.round(performance.now() - startedAt)}, records=${records.length}, bytes=${payloadBytes}`,
            )
        })
    }

    async compactIfNeeded(nowSecond: number): Promise<boolean> {
        if (this.options.readOnly) return false
        await this.initialize()
        await this.waitForWrites()
        if (this.logicalBytes < this.compactionThresholdBytes) return false
        if (this.logicalBytes < this.nextCompactionThresholdBytes && nowSecond < this.nextCompactionEligibleSecond) {
            return false
        }
        const startedAt = performance.now()
        const collection = this.requireCollection()
        const hasAgeEligible = await hasAgeEligibleCompactionRecords(collection, nowSecond)
        // Only physical rows are needed to compute the compacted set; avoid the extra
        // latestPerGroup window scan that readAll() performs for diagnostics.
        const physical = await queryMetricsEntities(collection, false)
        const dataRecords = physical.records.map(fromApiRateMetricsEntity).filter(isDataRecord)
        const compacted = compactApiRateMetrics(dataRecords, nowSecond)
        const reducedRecords = dataRecords.length - compacted.length
        if (
            !hasAgeEligible &&
            (reducedRecords <= 0 || reducedRecords < Math.ceil(dataRecords.length * MIN_DEDUP_COMPACTION_REDUCTION_RATIO))
        ) {
            // Active records still inside the 48h raw retention window cannot be rolled up yet;
            // back off instead of rewriting the full table on every subsequent API round.
            this.deferCompaction(nowSecond)
            return false
        }
        const beforeBytes = this.logicalBytes
        await this.replaceAll(compacted)
        if (this.logicalBytes >= this.compactionThresholdBytes) {
            this.deferCompaction(nowSecond)
        } else {
            this.nextCompactionThresholdBytes = this.compactionThresholdBytes
            this.nextCompactionEligibleSecond = 0
        }
        Logger.debug(
            `[Task ${this.options.taskId}] API rate metrics compaction: durationMs=${Math.round(performance.now() - startedAt)}, beforeBytes=${beforeBytes}, beforeRecords=${dataRecords.length}, afterRecords=${compacted.length}`,
        )
        return true
    }

    private deferCompaction(nowSecond: number): void {
        this.nextCompactionThresholdBytes = Math.max(
            this.compactionThresholdBytes,
            this.logicalBytes + COMPACTION_RETRY_GROWTH_BYTES,
        )
        this.nextCompactionEligibleSecond = nowSecond + COMPACTION_RETRY_COOLDOWN_SECONDS
    }

    async waitForWrites(): Promise<void> {
        await this.writeSequence
    }

    close(): Promise<void> {
        if (this.closePromise) return this.closePromise
        this.closing = true
        this.closePromise = (async () => {
            await this.initialization?.catch(() => undefined)
            await this.waitForWrites()
            await this.collection?.close()
            this.closed = true
        })()
        return this.closePromise
    }

    private async initializeInternal(): Promise<ApiRateMetricsRecovery> {
        const startedAt = performance.now()
        this.collection = await createApiRateMetricsCollection({
            taskId: this.options.taskId,
            ...(this.options.location ? { location: this.options.location } : {}),
            now: this.now,
            readOnly: this.options.readOnly,
        })
        await this.loadMigrationMarkers()

        if (this.shouldMigrateLegacy() && !this.migrationMarkers.has("api-rate-metrics-sqlite-wrapper-v1")) {
            const migration = await migrateLegacyApiRateMetrics({
                taskId: this.options.taskId,
                collection: this.collection,
                ...(this.options.legacySourcePath ? { sourcePath: this.options.legacySourcePath } : {}),
                now: this.now,
            })
            if (migration.marker) this.rememberMigrationMarker(migration.marker)
        }

        const fields = ApiRateMetricsEntity.storage.fields
        let createdFreshMeta = false
        await this.collection.transaction(async (transaction) => {
            const [metaEntities, migrationEntities] = await Promise.all([
                transaction.query({ where: eq(fields.kind, "meta") }),
                transaction.query({ where: eq(fields.kind, "migration") }),
            ])
            for (const marker of migrationEntities
                .map(fromApiRateMetricsEntity)
                .map(sanitizeMigrationMarker)
                .filter((value) => value !== undefined)) {
                this.rememberMigrationMarker(marker)
            }
            const metaRecords = metaEntities
                .map(fromApiRateMetricsEntity)
                .filter((record): record is ApiRateMetricsMetaRecord => record.kind === "meta")
            if (metaRecords.length === 0) {
                const anyRow = await transaction.query({ limit: 1 })
                if (anyRow.length > 0 || this.options.readOnly) {
                    throw new ApiRateMetricsFileIntegrityError(
                        `Missing API rate metrics metadata for Task ${this.options.taskId}`,
                    )
                }
                this.meta = {
                    schemaVersion: API_RATE_METRICS_SCHEMA_VERSION,
                    kind: "meta",
                    taskId: this.options.taskId,
                    createdAt: this.now(),
                }
                createdFreshMeta = true
                await transaction.replaceAll([toApiRateMetricsEntity(this.meta)])
                return
            }
            if (metaRecords.length !== 1 || metaRecords[0].taskId !== this.options.taskId) {
                throw new ApiRateMetricsFileIntegrityError(
                    `API rate metrics Task mismatch: expected ${this.options.taskId}, received ${metaRecords[0]?.taskId ?? "unknown"}`,
                )
            }
            this.meta = metaRecords[0]
        })

        const stats = await this.collection.stats()
        let recentRecords: ApiRateSecondRecord[] = []
        if (createdFreshMeta) {
            this.logicalBytes = serializedBytes([this.requireMeta()])
        } else if (stats.storedRecordCount <= EXACT_INITIAL_BYTES_RECORD_LIMIT) {
            const allRecords = (await this.collection.query()).records.map(fromApiRateMetricsEntity)
            this.logicalBytes = serializedBytes(allRecords.filter(isFileRecord))
            recentRecords = selectRecentActiveSeconds(
                allRecords.filter((record): record is ApiRateSecondRecord => record.kind === "second"),
            )
        } else {
            const sampled = await readRecentActiveSecondSample(this.collection)
            recentRecords = sampled.recentRecords
            const fileRecordCount = Math.max(1, stats.storedRecordCount - this.migrationMarkers.size)
            const sampleFileRecords: ApiRateMetricsFileRecord[] = [this.requireMeta(), ...sampled.sampledRecords]
            const averageRecordBytes = serializedBytes(sampleFileRecords) / sampleFileRecords.length
            this.logicalBytes = Math.round(averageRecordBytes * fileRecordCount)
        }
        const activity = recentRecords.reduce(
            (total, record) => {
                const current = getApiRateSecondActivitySeconds(record.signals)
                return {
                    activeSeconds: total.activeSeconds + current.activeSeconds,
                    providerActiveSeconds: total.providerActiveSeconds + current.providerActiveSeconds,
                }
            },
            { activeSeconds: 0, providerActiveSeconds: 0 },
        )
        const requestCount = recentRecords.reduce((total, record) => total + record.requestCount, 0)
        const tokenCount = recentRecords.reduce((total, record) => total + record.effectiveTokens, 0)
        const lastRecord = recentRecords.at(-1)
        const recovery: ApiRateMetricsRecovery = {
            activeSeconds: activity.activeSeconds,
            requestCount,
            tokenCount,
            lastActiveSecond: lastRecord?.second,
            snapshot:
                activity.activeSeconds > 0
                    ? {
                          activeSeconds: activity.activeSeconds,
                          requestsPerMinute: extrapolatePerMinute(requestCount, activity.activeSeconds),
                          tokensPerMinute: extrapolatePerMinute(tokenCount, activity.providerActiveSeconds),
                      }
                    : {},
            degraded: stats.degraded || this.hasDegradedMigration(),
            lastRecord,
            recentRecords,
        }
        Logger.debug(
            `[Task ${this.options.taskId}] API rate metrics initialize: durationMs=${Math.round(performance.now() - startedAt)}, storageBytes=${stats.storageBytes}, records=${stats.storedRecordCount}, activeSeconds=${activity.activeSeconds}, degraded=${stats.degraded}`,
        )
        return recovery
    }

    private shouldMigrateLegacy(): boolean {
        return !this.options.readOnly && (this.options.migrateLegacy ?? true)
    }

    private async loadMigrationMarkers(): Promise<void> {
        const collection = this.requireCollection()
        const fields = ApiRateMetricsEntity.storage.fields
        const result = await collection.query({ where: eq(fields.kind, "migration") })
        for (const entity of result.records) {
            const marker = sanitizeMigrationMarker(fromApiRateMetricsEntity(entity))
            if (marker) this.rememberMigrationMarker(marker)
        }
    }

    private rememberMigrationMarker(marker: ApiRateMetricsMigrationMarker): void {
        this.migrationMarkers.set(marker.migrationKey, marker)
    }

    private hasDegradedMigration(): boolean {
        return [...this.migrationMarkers.values()].some((marker) => marker.degraded)
    }

    private enqueueWrite(operation: () => Promise<void>): Promise<void> {
        const queued = this.writeSequence.then(operation)
        this.writeSequence = queued.catch(() => undefined)
        return queued
    }

    private assertWithinHardLimit(projectedBytes: number, operation: "append" | "replace"): void {
        if (projectedBytes <= this.hardLimitBytes) return
        throw new ApiRateMetricsHardLimitError(
            `API rate metrics hard limit exceeded for Task ${this.options.taskId}: operation=${operation}, projectedBytes=${projectedBytes}, hardLimitBytes=${this.hardLimitBytes}`,
        )
    }

    private requireMeta(): ApiRateMetricsMetaRecord {
        if (!this.meta) throw new Error(`API rate metrics repository is not initialized for Task ${this.options.taskId}`)
        return this.meta
    }

    private requireCollection(): UnifyStore<ApiRateMetricsEntity> {
        if (!this.collection) throw new Error(`API rate metrics repository is not initialized for Task ${this.options.taskId}`)
        return this.collection
    }

    private assertWritable(): void {
        if (this.closing || this.closed) throw new Error("API rate metrics repository is closed")
        if (this.options.readOnly) throw new Error("API rate metrics repository is read-only")
    }
}

async function queryMetricsRange(
    collection: UnifyStore<ApiRateMetricsEntity>,
    query: ApiRateMetricsRangeQuery,
    latest: boolean,
): Promise<UnifyStoreResult<ApiRateMetricsEntity>> {
    const fields = ApiRateMetricsEntity.storage.fields
    return await collection.query({
        where: and(gte(fields.startSecond, query.startSecond), lt(fields.startSecond, query.endSecond)),
        ...(latest
            ? {
                  select: latestPerGroup({ groupBy: [fields.recordKey], orderBy: [desc(fields.revision)] }),
              }
            : {}),
        orderBy: [asc(fields.startSecond), asc(fields.recordKey), asc(fields.revision)],
    })
}

async function queryMetricsEntities(
    collection: UnifyStore<ApiRateMetricsEntity>,
    latest: boolean,
): Promise<UnifyStoreResult<ApiRateMetricsEntity>> {
    const fields = ApiRateMetricsEntity.storage.fields
    return await collection.query({
        ...(latest
            ? {
                  select: latestPerGroup({ groupBy: [fields.recordKey], orderBy: [desc(fields.revision)] }),
              }
            : {}),
        orderBy: [asc(fields.startSecond), asc(fields.recordKey), asc(fields.revision)],
    })
}

/** Check via indexed LIMIT-1 probes whether any rows have aged into a coarser rollup bucket. */
async function hasAgeEligibleCompactionRecords(
    collection: UnifyStore<ApiRateMetricsEntity>,
    nowSecond: number,
): Promise<boolean> {
    const fields = ApiRateMetricsEntity.storage.fields
    const [agedSecond, agedMinute, agedHour] = await Promise.all([
        collection.query({
            where: and(eq(fields.kind, "second"), lt(fields.startSecond, nowSecond - RAW_SECOND_RETENTION_SECONDS + 1)),
            orderBy: [asc(fields.startSecond)],
            limit: 1,
        }),
        collection.query({
            where: and(
                eq(fields.kind, "rollup"),
                eq(fields.resolution, "minute"),
                lt(fields.startSecond, nowSecond - MINUTE_RETENTION_SECONDS + 1),
            ),
            orderBy: [asc(fields.startSecond)],
            limit: 1,
        }),
        collection.query({
            where: and(
                eq(fields.kind, "rollup"),
                eq(fields.resolution, "hour"),
                lt(fields.startSecond, nowSecond - HOUR_RETENTION_SECONDS + 1),
            ),
            orderBy: [asc(fields.startSecond)],
            limit: 1,
        }),
    ])
    return agedSecond.records.length > 0 || agedMinute.records.length > 0 || agedHour.records.length > 0
}

/** Walk newest `second` rows via the (kind, startSecond, revision) index until 60 active seconds are collected. */
async function readRecentActiveSecondSample(
    collection: UnifyStore<ApiRateMetricsEntity>,
): Promise<{ readonly recentRecords: ApiRateSecondRecord[]; readonly sampledRecords: ApiRateSecondRecord[] }> {
    const fields = ApiRateMetricsEntity.storage.fields
    let scanLimit = RECENT_SECOND_INITIAL_SCAN_ROWS
    let sampledRecords: ApiRateSecondRecord[] = []
    let recentRecords: ApiRateSecondRecord[] = []
    while (true) {
        const result = await collection.query({
            where: eq(fields.kind, "second"),
            orderBy: [desc(fields.startSecond), desc(fields.revision)],
            limit: scanLimit,
        })
        sampledRecords = result.records
            .map(fromApiRateMetricsEntity)
            .filter((record): record is ApiRateSecondRecord => record.kind === "second")
        recentRecords = selectRecentActiveSeconds(sampledRecords)
        if (
            recentRecords.length >= MAX_RECENT_ACTIVE_SECONDS ||
            result.records.length < scanLimit ||
            scanLimit >= RECENT_SECOND_MAX_SCAN_ROWS
        ) {
            return { recentRecords, sampledRecords }
        }
        scanLimit = Math.min(scanLimit * 4, RECENT_SECOND_MAX_SCAN_ROWS)
    }
}

function selectRecentActiveSeconds(seconds: readonly ApiRateSecondRecord[]): ApiRateSecondRecord[] {
    const latestSeconds = new Map<number, ApiRateSecondRecord>()
    for (const record of seconds) {
        const previous = latestSeconds.get(record.second)
        if (!previous || record.revision > previous.revision) latestSeconds.set(record.second, record)
    }
    return [...latestSeconds.values()]
        .filter((record) => {
            const activity = getApiRateSecondActivitySeconds(record.signals)
            return activity.activeSeconds > 0 || activity.providerActiveSeconds > 0
        })
        .sort((left, right) => left.second - right.second)
        .slice(-MAX_RECENT_ACTIVE_SECONDS)
}

function isDataRecord(record: ApiRateMetricsStoredRecord): record is ApiRateMetricsDataRecord {
    return record.kind === "second" || record.kind === "rollup"
}

function isFileRecord(record: ApiRateMetricsStoredRecord): record is ApiRateMetricsFileRecord {
    return record.kind !== "migration"
}

function isInternalRecord(record: ApiRateMetricsStoredRecord): boolean {
    return record.kind === "meta" || record.kind === "migration"
}

function serializedBytes(records: readonly ApiRateMetricsFileRecord[]): number {
    if (records.length === 0) return 0
    return Buffer.byteLength(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`)
}

function toReadResult(
    records: ApiRateMetricsDataRecord[],
    stats: UnifyStoreStats,
    physicalInternalRecordCount: number,
    logicalRecordCount: number,
): ApiRateMetricsReadResult {
    return {
        records,
        degraded: stats.degraded,
        storageBytes: stats.storageBytes,
        logicalRecordCount,
        physicalRecordCount: Math.max(0, stats.storedRecordCount - physicalInternalRecordCount),
    }
}

function extrapolatePerMinute(value: number, activeSeconds: number): number {
    return activeSeconds > 0 ? Math.round((value * 60) / activeSeconds) : 0
}
