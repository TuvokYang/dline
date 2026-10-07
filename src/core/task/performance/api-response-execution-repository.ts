import type { UnifyStore, UnifyStoreTransaction } from "@core/storage/backend/api/UnifyStore"
import { and, asc, desc, eq, gte, latestPerGroup, lt } from "@core/storage/backend/api/UnifyStoreQuery"
import { createApiResponseExecutionCollection } from "./api-response-execution-collection"
import {
	ApiResponseExecutionEntity,
	fromApiResponseExecutionEntity,
	toApiResponseExecutionEntity,
} from "./api-response-execution-entity"
import type {
	ApiResponseExecutionRangeQuery,
	ApiResponseExecutionRangeSnapshotQuery,
	ApiResponseExecutionRecord,
	ApiResponseExecutionRepository,
} from "./api-response-execution-types"

export interface TaskApiResponseExecutionRepositoryOptions {
	readonly taskId: string
	readonly location?: string
	readonly readOnly?: boolean
}

const DEFAULT_RECENT_EXECUTION_LIMIT = 60

/** Owns canonical complete-execution persistence for one Task. */
export class TaskApiResponseExecutionRepository implements ApiResponseExecutionRepository {
	private collection: UnifyStore<ApiResponseExecutionEntity> | undefined
	private initialization: Promise<void> | undefined
	private writeSequence: Promise<void> = Promise.resolve()
	private closing = false
	private closed = false
	private closePromise: Promise<void> | undefined

	constructor(private readonly options: TaskApiResponseExecutionRepositoryOptions) {}

	async append(records: readonly ApiResponseExecutionRecord[]): Promise<void> {
		this.assertWritable()
		if (records.length === 0) return
		for (const record of records) {
			if (record.taskId !== this.options.taskId) {
				throw new Error(
					`API response execution Task mismatch: expected ${this.options.taskId}, received ${record.taskId}`,
				)
			}
		}
		await this.initialize()
		const entities = records.map(toApiResponseExecutionEntity)
		return this.enqueueWrite(() => this.requireCollection().insert(entities))
	}

	async readRecent(limit = DEFAULT_RECENT_EXECUTION_LIMIT): Promise<ApiResponseExecutionRecord[]> {
		assertPositiveLimit(limit, "API response execution recent limit")
		await this.initialize()
		await this.waitForWrites()
		const fields = ApiResponseExecutionEntity.storage.fields
		const result = await this.requireCollection().query({
			where: eq(fields.taskId, this.options.taskId),
			select: latestPerGroup({ groupBy: [fields.executionId], orderBy: [desc(fields.revision)] }),
			orderBy: [desc(fields.completedAtMs), desc(fields.providerAttempt)],
			limit,
		})
		return result.records.reverse().map(fromApiResponseExecutionEntity)
	}

	async readRange(query: ApiResponseExecutionRangeQuery): Promise<ApiResponseExecutionRecord[]> {
		assertRangeQuery(query)
		await this.initialize()
		await this.waitForWrites()
		const fields = ApiResponseExecutionEntity.storage.fields
		const result = await this.requireCollection().query({
			where: and(
				eq(fields.taskId, this.options.taskId),
				gte(fields.completedAtMs, query.startMs),
				lt(fields.completedAtMs, query.endMs),
			),
			select: latestPerGroup({ groupBy: [fields.executionId], orderBy: [desc(fields.revision)] }),
			orderBy: [asc(fields.completedAtMs), asc(fields.providerAttempt)],
			limit: query.maxPoints,
		})
		return result.records.map(fromApiResponseExecutionEntity)
	}

	async readRangeSnapshot(query: ApiResponseExecutionRangeSnapshotQuery): Promise<ApiResponseExecutionRecord[]> {
		assertRangeSnapshotQuery(query)
		await this.initialize()
		await this.waitForWrites()
		const entities = await this.requireCollection().transaction(async (transaction) => {
			const snapshot: ApiResponseExecutionEntity[] = []
			let cursorExecutionId: string | undefined
			while (true) {
				const page = await readCanonicalRangePage(transaction, {
					taskId: this.options.taskId,
					startMs: query.startMs,
					endMs: query.endMs,
					pageSize: query.pageSize,
					cursorExecutionId,
				})
				const newEntities =
					cursorExecutionId === undefined ? page : page.filter(({ executionId }) => executionId !== cursorExecutionId)
				snapshot.push(...newEntities)
				if (page.length < query.pageSize) break
				const nextCursor = page.at(-1)?.executionId
				if (!nextCursor || nextCursor === cursorExecutionId) {
					throw new Error("API response execution range pagination did not advance")
				}
				cursorExecutionId = nextCursor
			}
			return snapshot
		})
		return entities
			.map(fromApiResponseExecutionEntity)
			.sort(
				(left, right) =>
					left.completedAtMs - right.completedAtMs ||
					left.providerAttempt - right.providerAttempt ||
					left.executionId.localeCompare(right.executionId),
			)
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
				await this.initialization?.catch(() => undefined)
				await this.collection?.close()
			} finally {
				this.closed = true
				this.collection = undefined
			}
		})()
		return this.closePromise
	}

	private initialize(): Promise<void> {
		if (this.closing || this.closed) return Promise.reject(new Error("API response execution repository is closed"))
		this.initialization ??= createApiResponseExecutionCollection(this.options).then((collection) => {
			this.collection = collection
		})
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

	private requireCollection(): UnifyStore<ApiResponseExecutionEntity> {
		if (!this.collection) throw new Error("API response execution repository is not initialized")
		return this.collection
	}

	private assertWritable(): void {
		if (this.closing || this.closed) throw new Error("API response execution repository is closed")
		if (this.options.readOnly) throw new Error("API response execution repository is read-only")
	}
}

interface CanonicalRangePageQuery {
	readonly taskId: string
	readonly startMs: number
	readonly endMs: number
	readonly pageSize: number
	readonly cursorExecutionId?: string
}

async function readCanonicalRangePage(
	transaction: UnifyStoreTransaction<ApiResponseExecutionEntity>,
	query: CanonicalRangePageQuery,
): Promise<ApiResponseExecutionEntity[]> {
	const fields = ApiResponseExecutionEntity.storage.fields
	return transaction.query({
		where: and(
			eq(fields.taskId, query.taskId),
			gte(fields.completedAtMs, query.startMs),
			lt(fields.completedAtMs, query.endMs),
			...(query.cursorExecutionId === undefined ? [] : [gte(fields.executionId, query.cursorExecutionId)]),
		),
		select: latestPerGroup({ groupBy: [fields.executionId], orderBy: [desc(fields.revision)] }),
		orderBy: [asc(fields.executionId)],
		limit: query.pageSize,
	})
}

function assertPositiveLimit(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`)
}

function assertRangeQuery(query: ApiResponseExecutionRangeQuery): void {
	assertRange(query.startMs, query.endMs)
	assertPositiveLimit(query.maxPoints, "API response execution range maxPoints")
}

function assertRangeSnapshotQuery(query: ApiResponseExecutionRangeSnapshotQuery): void {
	assertRange(query.startMs, query.endMs)
	if (!Number.isSafeInteger(query.pageSize) || query.pageSize < 2) {
		throw new Error("API response execution range pageSize must be an integer of at least two")
	}
}

function assertRange(startMs: number, endMs: number): void {
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
		throw new Error("API response execution range must use increasing finite milliseconds")
	}
}
