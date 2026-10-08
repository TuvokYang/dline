import type { EntitySchema } from "../api/EntitySchema"
import type { UnifyStore, UnifyStoreResult, UnifyStoreStats, UnifyStoreTransaction } from "../api/UnifyStore"
import type { UnifyStoreQuery } from "../api/UnifyStoreQuery"
import { type NormalizedUnifyStoreQuery, normalizeUnifyStoreQuery } from "./UnifyStoreQueryEvaluator"

export interface UnifyStoreDriverTransaction<TEntity extends object> {
	query(query: NormalizedUnifyStoreQuery<TEntity>): Promise<TEntity[]>
	insert(records: readonly TEntity[]): Promise<void>
	upsert(records: readonly TEntity[]): Promise<void>
	replaceAll(records: readonly TEntity[]): Promise<void>
}

export interface UnifyStoreDriver<TEntity extends object> {
	query(query: NormalizedUnifyStoreQuery<TEntity>): Promise<UnifyStoreResult<TEntity>>
	insert(records: readonly TEntity[]): Promise<void>
	upsert(records: readonly TEntity[]): Promise<void>
	replaceAll(records: readonly TEntity[]): Promise<void>
	transaction<TResult>(
		operation: (transaction: UnifyStoreDriverTransaction<TEntity>) => TResult | Promise<TResult>,
	): Promise<TResult>
	stats(): Promise<UnifyStoreStats>
	close(): Promise<void>
}

export class UnifyStoreCore<TEntity extends object> implements UnifyStore<TEntity> {
	private operationSequence: Promise<void> = Promise.resolve()
	private closing = false
	private closed = false
	private closePromise: Promise<void> | undefined

	constructor(
		private readonly schema: EntitySchema<TEntity>,
		private readonly driver: UnifyStoreDriver<TEntity>,
	) {}

	query(query?: UnifyStoreQuery<TEntity>): Promise<UnifyStoreResult<TEntity>> {
		const normalized = normalizeUnifyStoreQuery(this.schema, query)
		return this.enqueue(() => this.driver.query(normalized))
	}

	insert(records: readonly TEntity[]): Promise<void> {
		return this.enqueue(async () => {
			if (records.length === 0) return
			validateRecords(this.schema, records)
			await this.driver.insert(records)
		})
	}

	upsert(records: readonly TEntity[]): Promise<void> {
		return this.enqueue(async () => {
			if (records.length === 0) return
			validateRecords(this.schema, records)
			await this.driver.upsert(records)
		})
	}

	replaceAll(records: readonly TEntity[]): Promise<void> {
		return this.enqueue(async () => {
			validateRecords(this.schema, records)
			await this.driver.replaceAll(records)
		})
	}

	transaction<TResult>(
		operation: (transaction: UnifyStoreTransaction<TEntity>) => TResult | Promise<TResult>,
	): Promise<TResult> {
		return this.enqueue(() =>
			this.driver.transaction(async (driverTransaction) => {
				return await operation(createValidatedTransaction(this.schema, driverTransaction))
			}),
		)
	}

	stats(): Promise<UnifyStoreStats> {
		return this.enqueue(() => this.driver.stats())
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise
		this.closing = true
		this.closePromise = this.operationSequence
			.then(() => this.driver.close())
			.then(() => {
				this.closed = true
			})
		return this.closePromise
	}

	private enqueue<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
		if (this.closing || this.closed) return Promise.reject(new Error("UnifyStore is closed"))
		const result = this.operationSequence.then(operation)
		this.operationSequence = result.then(
			() => undefined,
			() => undefined,
		)
		return result
	}
}

/** Wraps a backend transaction so every write is schema-validated before it reaches the backend. */
export function createValidatedTransaction<TEntity extends object>(
	schema: EntitySchema<TEntity>,
	driverTransaction: UnifyStoreDriverTransaction<TEntity>,
): UnifyStoreTransaction<TEntity> {
	return {
		query: (query) => driverTransaction.query(normalizeUnifyStoreQuery(schema, query)),
		insert: async (records) => {
			validateRecords(schema, records)
			await driverTransaction.insert(records)
		},
		upsert: async (records) => {
			if (records.length === 0) return
			validateRecords(schema, records)
			await driverTransaction.upsert(records)
		},
		replaceAll: async (records) => {
			validateRecords(schema, records)
			await driverTransaction.replaceAll(records)
		},
	}
}

function validateRecords<TEntity extends object>(schema: EntitySchema<TEntity>, records: readonly TEntity[]): void {
	for (const record of records) schema.dehydrate(record)
}
