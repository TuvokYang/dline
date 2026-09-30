import { performance } from "node:perf_hooks"
import type { UnifyStore, UnifyStoreResult, UnifyStoreStats } from "@core/storage/backend/api/UnifyStore"
import { and, asc, desc, eq, gte, latestPerGroup, lt } from "@core/storage/backend/api/UnifyStoreQuery"
import { Logger } from "@shared/services/Logger"
import { compactApiRateMetrics } from "./api-rate-metrics-aggregator"
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
	private closing = false
	private closed = false
	private closePromise: Promise<void> | undefined

	constructor(private readonly options: TaskApiRateMetricsRepositoryOptions) {
		this.now = options.now ?? Date.now
		this.compactionThresholdBytes = options.compactionThresholdBytes ?? DEFAULT_COMPACTION_THRESHOLD_BYTES
		this.hardLimitBytes = options.hardLimitBytes ?? DEFAULT_HARD_LIMIT_BYTES
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
		const startedAt = performance.now()
		const read = await this.readAll()
		const compacted = compactApiRateMetrics(read.records, nowSecond)
		const beforeBytes = this.logicalBytes
		await this.replaceAll(compacted)
		Logger.debug(
			`[Task ${this.options.taskId}] API rate metrics compaction: durationMs=${Math.round(performance.now() - startedAt)}, beforeBytes=${beforeBytes}, beforeRecords=${read.records.length}, afterRecords=${compacted.length}`,
		)
		return true
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

		let records: ApiRateMetricsStoredRecord[] = []
		await this.collection.transaction(async (transaction) => {
			const current = await transaction.query()
			records = current.map(fromApiRateMetricsEntity)
			for (const marker of records.map(sanitizeMigrationMarker).filter((value) => value !== undefined)) {
				this.rememberMigrationMarker(marker)
			}
			const metaRecords = records.filter((record): record is ApiRateMetricsMetaRecord => record.kind === "meta")
			if (metaRecords.length === 0) {
				if (records.length > 0 || this.options.readOnly) {
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
				records = [this.meta]
				await transaction.replaceAll(records.map(toApiRateMetricsEntity))
				return
			}
			if (metaRecords.length !== 1 || metaRecords[0].taskId !== this.options.taskId) {
				throw new ApiRateMetricsFileIntegrityError(
					`API rate metrics Task mismatch: expected ${this.options.taskId}, received ${metaRecords[0]?.taskId ?? "unknown"}`,
				)
			}
			this.meta = metaRecords[0]
		})

		this.logicalBytes = serializedBytes(records.filter(isFileRecord))
		const stats = await this.collection.stats()
		const latestSeconds = new Map<number, ApiRateSecondRecord>()
		for (const record of records) {
			if (record.kind !== "second") continue
			const previous = latestSeconds.get(record.second)
			if (!previous || record.revision > previous.revision) latestSeconds.set(record.second, record)
		}
		const recentRecords = [...latestSeconds.values()]
			.filter((record): record is ApiRateSecondRecord => {
				if (record.kind !== "second") return false
				const activity = getApiRateSecondActivitySeconds(record.signals)
				return activity.activeSeconds > 0 || activity.providerActiveSeconds > 0
			})
			.sort((left, right) => left.second - right.second)
			.slice(-MAX_RECENT_ACTIVE_SECONDS)
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
			`[Task ${this.options.taskId}] API rate metrics initialize: durationMs=${Math.round(performance.now() - startedAt)}, storageBytes=${stats.storageBytes}, records=${records.length}, activeSeconds=${activity.activeSeconds}, degraded=${stats.degraded}`,
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
