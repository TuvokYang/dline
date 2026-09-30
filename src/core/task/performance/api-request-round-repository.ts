import type { UnifyStore, UnifyStoreTransaction } from "@core/storage/backend/api/UnifyStore"
import { and, asc, desc, eq, gte, latestPerGroup, lt } from "@core/storage/backend/api/UnifyStoreQuery"
import { Logger } from "@shared/services/Logger"
import { createApiRequestRoundCollection } from "./api-request-round-collection"
import { ApiRequestRoundEntity, fromApiRequestRoundEntity, toApiRequestRoundEntity } from "./api-request-round-entity"
import { createApiRequestRoundLegacyImportCollection } from "./api-request-round-legacy-import-collection"
import { ApiRequestRoundLegacyImportEntity } from "./api-request-round-legacy-import-entity"
import { importApiRequestRoundLegacyUsage } from "./api-request-round-legacy-importer"
import type { LegacyUiMessageSource } from "./api-request-round-legacy-usage-parser"
import type {
	ApiRequestRoundCumulativeUsage,
	ApiRequestRoundRangeQuery,
	ApiRequestRoundRangeSnapshotQuery,
	ApiRequestRoundRecord,
	ApiRequestRoundRepository,
} from "./api-request-round-types"

export interface TaskApiRequestRoundRepositoryOptions {
	readonly taskId: string
	readonly location?: string
	readonly readOnly?: boolean
	readonly legacySource?: LegacyUiMessageSource
	readonly clock?: () => number
}

const DEFAULT_RECENT_ROUND_LIMIT = 60

/** Owns canonical Provider round persistence for one Task. */
export class TaskApiRequestRoundRepository implements ApiRequestRoundRepository {
	private collection: UnifyStore<ApiRequestRoundEntity> | undefined
	private legacyCollection: UnifyStore<ApiRequestRoundLegacyImportEntity> | undefined
	private initialization: Promise<void> | undefined
	private writeSequence: Promise<void> = Promise.resolve()
	private legacyImportDegraded = false
	private closing = false
	private closed = false
	private closePromise: Promise<void> | undefined

	constructor(private readonly options: TaskApiRequestRoundRepositoryOptions) {}

	async append(records: readonly ApiRequestRoundRecord[]): Promise<void> {
		this.assertWritable()
		if (records.length === 0) return
		for (const record of records) {
			if (record.taskId !== this.options.taskId) {
				throw new Error(`API request round Task mismatch: expected ${this.options.taskId}, received ${record.taskId}`)
			}
		}
		await this.initialize()
		const entities = records.map(toApiRequestRoundEntity)
		return this.enqueueWrite(() => this.requireCollection().insert(entities))
	}

	async readRecent(limit = DEFAULT_RECENT_ROUND_LIMIT): Promise<ApiRequestRoundRecord[]> {
		assertPositiveLimit(limit, "API request round recent limit")
		await this.initialize()
		await this.waitForWrites()
		const fields = ApiRequestRoundEntity.storage.fields
		const result = await this.requireCollection().query({
			where: eq(fields.taskId, this.options.taskId),
			select: latestPerGroup({ groupBy: [fields.roundId], orderBy: [desc(fields.revision)] }),
			orderBy: [desc(fields.completedAtMs), desc(fields.providerAttempt)],
			limit,
		})
		return result.records.reverse().map(fromApiRequestRoundEntity)
	}

	async readRange(query: ApiRequestRoundRangeQuery): Promise<ApiRequestRoundRecord[]> {
		assertRangeQuery(query)
		await this.initialize()
		await this.waitForWrites()
		const fields = ApiRequestRoundEntity.storage.fields
		const result = await this.requireCollection().query({
			where: and(
				eq(fields.taskId, this.options.taskId),
				gte(fields.completedAtMs, query.startMs),
				lt(fields.completedAtMs, query.endMs),
			),
			select: latestPerGroup({ groupBy: [fields.roundId], orderBy: [desc(fields.revision)] }),
			orderBy: [asc(fields.completedAtMs), asc(fields.providerAttempt)],
			limit: query.maxPoints,
		})
		return result.records.map(fromApiRequestRoundEntity)
	}

	async readRangeSnapshot(query: ApiRequestRoundRangeSnapshotQuery): Promise<ApiRequestRoundRecord[]> {
		assertRangeSnapshotQuery(query)
		await this.initialize()
		await this.waitForWrites()
		const entities = await this.requireCollection().transaction(async (transaction) => {
			const snapshot: ApiRequestRoundEntity[] = []
			let cursorRoundId: string | undefined
			while (true) {
				const page = await readCanonicalRangePage(transaction, {
					taskId: this.options.taskId,
					startMs: query.startMs,
					endMs: query.endMs,
					pageSize: query.pageSize,
					cursorRoundId,
				})
				const newEntities = cursorRoundId === undefined ? page : page.filter(({ roundId }) => roundId !== cursorRoundId)
				snapshot.push(...newEntities)
				if (page.length < query.pageSize) break
				const nextCursorRoundId = page.at(-1)?.roundId
				if (!nextCursorRoundId || nextCursorRoundId === cursorRoundId) {
					throw new Error("API request round range pagination did not advance")
				}
				cursorRoundId = nextCursorRoundId
			}
			return snapshot
		})
		return entities
			.map(fromApiRequestRoundEntity)
			.sort(
				(left, right) =>
					left.completedAtMs - right.completedAtMs ||
					left.providerAttempt - right.providerAttempt ||
					left.roundId.localeCompare(right.roundId),
			)
	}

	async readRecentHistory(limit = DEFAULT_RECENT_ROUND_LIMIT): Promise<ApiRequestRoundRecord[]> {
		assertPositiveLimit(limit, "API request round history recent limit")
		await this.initialize()
		await this.waitForWrites()
		const [exact, legacy] = await Promise.all([this.readRecent(limit), this.readRecentLegacy(limit)])
		return sortRounds([...exact, ...legacy]).slice(-limit)
	}

	async readRangeHistorySnapshot(query: ApiRequestRoundRangeSnapshotQuery): Promise<ApiRequestRoundRecord[]> {
		assertRangeSnapshotQuery(query)
		await this.initialize()
		await this.waitForWrites()
		const [exact, legacy] = await Promise.all([this.readRangeSnapshot(query), this.readLegacyRangeSnapshot(query)])
		return sortRounds([...exact, ...legacy])
	}

	async readCumulativeUsage(): Promise<ApiRequestRoundCumulativeUsage> {
		await this.initialize()
		await this.waitForWrites()
		const exact = await this.readRangeSnapshot({ startMs: 0, endMs: Number.MAX_SAFE_INTEGER, pageSize: 512 })
		let legacyRows: ApiRequestRoundLegacyImportEntity[] = []
		if (this.legacyCollection) {
			try {
				legacyRows = await readAllLegacyRows(this.legacyCollection, this.options.taskId, 512)
			} catch (error) {
				this.legacyImportDegraded = true
				Logger.warn(`[Task ${this.options.taskId}] Failed to read legacy API request usage`, error)
			}
		}
		return aggregateCumulativeUsage(exact, legacyRows, this.legacyImportDegraded)
	}

	isDegraded(): boolean {
		return this.legacyImportDegraded
	}

	async waitForWrites(): Promise<void> {
		await this.writeSequence
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise
		this.closing = true
		this.closePromise = (async () => {
			try {
				await this.writeSequence
				await this.initialization
				const results = await Promise.allSettled([this.collection?.close(), this.legacyCollection?.close()])
				const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
				if (failure) throw failure.reason
			} finally {
				this.closed = true
				this.collection = undefined
				this.legacyCollection = undefined
			}
		})()
		return this.closePromise
	}

	private initialize(): Promise<void> {
		if (this.closing || this.closed) return Promise.reject(new Error("API request round repository is closed"))
		this.initialization ??= (async () => {
			this.collection = await createApiRequestRoundCollection(this.options)
			try {
				this.legacyCollection = await createApiRequestRoundLegacyImportCollection(this.options)
				if (this.options.readOnly) return
				const result = await importApiRequestRoundLegacyUsage({
					taskId: this.options.taskId,
					exactStore: this.collection,
					legacyStore: this.legacyCollection,
					source: this.options.legacySource,
					clock: this.options.clock,
				})
				this.legacyImportDegraded = result.degraded
			} catch (error) {
				this.legacyImportDegraded = true
				Logger.warn(`[Task ${this.options.taskId}] Failed to initialize legacy API request usage`, error)
				await this.legacyCollection?.close().catch(() => undefined)
				this.legacyCollection = undefined
			}
		})()
		return this.initialization
	}

	private enqueueWrite(operation: () => Promise<void>): Promise<void> {
		const result = this.writeSequence.then(operation)
		this.writeSequence = result.then(
			() => undefined,
			() => undefined,
		)
		return result
	}

	private async readRecentLegacy(limit: number): Promise<ApiRequestRoundRecord[]> {
		const store = this.legacyCollection
		if (!store) return []
		try {
			const fields = ApiRequestRoundLegacyImportEntity.storage.fields
			const result = await store.query({
				where: and(eq(fields.taskId, this.options.taskId), eq(fields.kind, "legacy_round")),
				orderBy: [desc(fields.messageTs), desc(fields.recordKey)],
				limit,
			})
			return result.records.reverse().map(fromLegacyEntity)
		} catch (error) {
			this.legacyImportDegraded = true
			Logger.warn(`[Task ${this.options.taskId}] Failed to read recent legacy API request rounds`, error)
			return []
		}
	}

	private async readLegacyRangeSnapshot(query: ApiRequestRoundRangeSnapshotQuery): Promise<ApiRequestRoundRecord[]> {
		const store = this.legacyCollection
		if (!store) return []
		try {
			return (await readLegacyRangeRows(store, this.options.taskId, query)).map(fromLegacyEntity)
		} catch (error) {
			this.legacyImportDegraded = true
			Logger.warn(`[Task ${this.options.taskId}] Failed to read legacy API request round range`, error)
			return []
		}
	}

	private requireCollection(): UnifyStore<ApiRequestRoundEntity> {
		if (!this.collection) throw new Error("API request round repository is not initialized")
		return this.collection
	}

	private assertWritable(): void {
		if (this.closing || this.closed) throw new Error("API request round repository is closed")
		if (this.options.readOnly) throw new Error("API request round repository is read-only")
	}
}

function fromLegacyEntity(entity: ApiRequestRoundLegacyImportEntity): ApiRequestRoundRecord {
	if (
		entity.kind !== "legacy_round" ||
		entity.roundId === null ||
		entity.logicalRequestId === null ||
		entity.apiIndex === null ||
		entity.inputTokens === null ||
		entity.outputTokens === null ||
		entity.cacheWriteTokens === null ||
		entity.cacheReadTokens === null
	) {
		throw new Error("Legacy API request round row is incomplete")
	}
	return {
		schemaVersion: 1,
		taskId: entity.taskId,
		roundId: entity.roundId,
		revision: 0,
		logicalRequestId: entity.logicalRequestId,
		apiIndex: entity.apiIndex,
		taskAttempt: 0,
		providerAttempt: 0,
		startedAtMs: entity.messageTs,
		completedAtMs: entity.messageTs,
		status: "completed",
		inputTokens: entity.inputTokens,
		outputTokens: entity.outputTokens,
		cacheWriteTokens: entity.cacheWriteTokens,
		cacheReadTokens: entity.cacheReadTokens,
		cacheUsageReported: entity.cacheUsageReported,
		...(entity.totalCost === null ? {} : { totalCost: entity.totalCost }),
		...(entity.currency === null ? {} : { currency: entity.currency }),
		usageQuality: "legacy",
	}
}

function sortRounds(rounds: readonly ApiRequestRoundRecord[]): ApiRequestRoundRecord[] {
	return [...rounds].sort(
		(left, right) =>
			left.completedAtMs - right.completedAtMs ||
			left.providerAttempt - right.providerAttempt ||
			left.roundId.localeCompare(right.roundId),
	)
}

async function readLegacyRangeRows(
	store: UnifyStore<ApiRequestRoundLegacyImportEntity>,
	taskId: string,
	query: ApiRequestRoundRangeSnapshotQuery,
): Promise<ApiRequestRoundLegacyImportEntity[]> {
	return store.transaction(async (transaction) => {
		const snapshot: ApiRequestRoundLegacyImportEntity[] = []
		let cursorRecordKey: string | undefined
		while (true) {
			const fields = ApiRequestRoundLegacyImportEntity.storage.fields
			const page = await transaction.query({
				where: and(
					eq(fields.taskId, taskId),
					eq(fields.kind, "legacy_round"),
					gte(fields.messageTs, query.startMs),
					lt(fields.messageTs, query.endMs),
					...(cursorRecordKey === undefined ? [] : [gte(fields.recordKey, cursorRecordKey)]),
				),
				orderBy: [asc(fields.recordKey)],
				limit: query.pageSize,
			})
			const newRows = cursorRecordKey === undefined ? page : page.filter(({ recordKey }) => recordKey !== cursorRecordKey)
			snapshot.push(...newRows)
			if (page.length < query.pageSize) break
			const nextCursor = page.at(-1)?.recordKey
			if (!nextCursor || nextCursor === cursorRecordKey)
				throw new Error("Legacy API request round pagination did not advance")
			cursorRecordKey = nextCursor
		}
		return snapshot.sort((left, right) => left.messageTs - right.messageTs || left.recordKey.localeCompare(right.recordKey))
	})
}

async function readAllLegacyRows(
	store: UnifyStore<ApiRequestRoundLegacyImportEntity>,
	taskId: string,
	pageSize: number,
): Promise<ApiRequestRoundLegacyImportEntity[]> {
	return store.transaction(async (transaction) => {
		const snapshot: ApiRequestRoundLegacyImportEntity[] = []
		let cursorRecordKey: string | undefined
		while (true) {
			const fields = ApiRequestRoundLegacyImportEntity.storage.fields
			const page = await transaction.query({
				where: and(
					eq(fields.taskId, taskId),
					...(cursorRecordKey === undefined ? [] : [gte(fields.recordKey, cursorRecordKey)]),
				),
				orderBy: [asc(fields.recordKey)],
				limit: pageSize,
			})
			const newRows = cursorRecordKey === undefined ? page : page.filter(({ recordKey }) => recordKey !== cursorRecordKey)
			snapshot.push(...newRows)
			if (page.length < pageSize) break
			const nextCursor = page.at(-1)?.recordKey
			if (!nextCursor || nextCursor === cursorRecordKey)
				throw new Error("Legacy API request usage pagination did not advance")
			cursorRecordKey = nextCursor
		}
		return snapshot
	})
}

function aggregateCumulativeUsage(
	exact: readonly ApiRequestRoundRecord[],
	legacyRows: readonly ApiRequestRoundLegacyImportEntity[],
	degraded: boolean,
): ApiRequestRoundCumulativeUsage {
	let inputTokens = 0
	let outputTokens = 0
	let cacheWriteTokens = 0
	let cacheReadTokens = 0
	let cacheNumerator = 0
	let cacheDenominator = 0
	let totalCost = 0
	let usageAvailable = false
	let costAvailable = false
	let currency: string | undefined
	let mixedCurrency = false
	const add = (usage: {
		inputTokens?: number | null
		outputTokens?: number | null
		cacheWriteTokens?: number | null
		cacheReadTokens?: number | null
		cacheUsageReported: boolean
		totalCost?: number | null
		currency?: string | null
	}): void => {
		if (
			usage.inputTokens !== undefined &&
			usage.inputTokens !== null &&
			usage.outputTokens !== undefined &&
			usage.outputTokens !== null
		) {
			usageAvailable = true
			inputTokens += usage.inputTokens
			outputTokens += usage.outputTokens
			cacheWriteTokens += usage.cacheWriteTokens ?? 0
			cacheReadTokens += usage.cacheReadTokens ?? 0
			if (usage.cacheUsageReported) {
				const denominator = usage.inputTokens + (usage.cacheWriteTokens ?? 0) + (usage.cacheReadTokens ?? 0)
				if (denominator > 0) {
					cacheNumerator += usage.cacheReadTokens ?? 0
					cacheDenominator += denominator
				}
			}
		}
		if (usage.totalCost !== undefined && usage.totalCost !== null) {
			totalCost += usage.totalCost
			costAvailable = true
		}
		if (usage.currency) {
			if (currency === undefined) currency = usage.currency
			else if (currency !== usage.currency) mixedCurrency = true
		}
	}
	for (const round of exact) {
		if (round.usageQuality !== "none") add(round)
	}
	for (const row of legacyRows) {
		if (row.kind === "legacy_round" || row.kind === "aggregate") add(row)
	}
	return {
		degraded,
		...(usageAvailable ? { inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens } : {}),
		cacheNumerator,
		cacheDenominator,
		...(costAvailable ? { totalCost } : {}),
		...(currency !== undefined && !mixedCurrency ? { currency } : {}),
	}
}

interface CanonicalRangePageQuery {
	readonly taskId: string
	readonly startMs: number
	readonly endMs: number
	readonly pageSize: number
	readonly cursorRoundId?: string
}

async function readCanonicalRangePage(
	transaction: UnifyStoreTransaction<ApiRequestRoundEntity>,
	query: CanonicalRangePageQuery,
): Promise<ApiRequestRoundEntity[]> {
	const fields = ApiRequestRoundEntity.storage.fields
	return transaction.query({
		where: and(
			eq(fields.taskId, query.taskId),
			gte(fields.completedAtMs, query.startMs),
			lt(fields.completedAtMs, query.endMs),
			...(query.cursorRoundId === undefined ? [] : [gte(fields.roundId, query.cursorRoundId)]),
		),
		select: latestPerGroup({ groupBy: [fields.roundId], orderBy: [desc(fields.revision)] }),
		orderBy: [asc(fields.roundId)],
		limit: query.pageSize,
	})
}

function assertPositiveLimit(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`)
}

function assertRangeQuery(query: ApiRequestRoundRangeQuery): void {
	assertRange(query.startMs, query.endMs)
	assertPositiveLimit(query.maxPoints, "API request round range maxPoints")
}

function assertRangeSnapshotQuery(query: ApiRequestRoundRangeSnapshotQuery): void {
	assertRange(query.startMs, query.endMs)
	if (!Number.isSafeInteger(query.pageSize) || query.pageSize < 2) {
		throw new Error("API request round range pageSize must be an integer of at least two")
	}
}

function assertRange(startMs: number, endMs: number): void {
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
		throw new Error("API request round range must use increasing finite milliseconds")
	}
}
