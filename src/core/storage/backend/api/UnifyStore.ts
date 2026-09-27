import type { StoredEntityClass } from "./EntitySchema"
import type { UnifyStoreQuery } from "./UnifyStoreQuery"

export interface UnifyStoreStats {
	readonly storageBytes: number
	readonly storedRecordCount: number
	readonly degraded: boolean
}

export interface UnifyStoreResult<TEntity extends object> {
	readonly records: TEntity[]
	readonly stats: UnifyStoreStats
}

export interface UnifyStoreTransaction<TEntity extends object> {
	query(query?: UnifyStoreQuery<TEntity>): Promise<TEntity[]>
	insert(records: readonly TEntity[]): Promise<void>
	/** Insert records or replace the stored record with the same primary key; later duplicates in one batch win. */
	upsert(records: readonly TEntity[]): Promise<void>
	replaceAll(records: readonly TEntity[]): Promise<void>
}

/**
 * Durable, backend-neutral entity store.
 *
 * Successful writes resolve only after their physical transaction commits.
 */
export interface UnifyStore<TEntity extends object> {
	query(query?: UnifyStoreQuery<TEntity>): Promise<UnifyStoreResult<TEntity>>
	insert(records: readonly TEntity[]): Promise<void>
	/** Insert records or replace the stored record with the same primary key; later duplicates in one batch win. */
	upsert(records: readonly TEntity[]): Promise<void>
	replaceAll(records: readonly TEntity[]): Promise<void>
	transaction<TResult>(operation: (transaction: UnifyStoreTransaction<TEntity>) => TResult | Promise<TResult>): Promise<TResult>
	stats(): Promise<UnifyStoreStats>
	close(): Promise<void>
}

/** A collection registered in a database, identified by the schema it was created with. */
export interface UnifyStoreCollectionInfo {
	readonly schemaId: string
	readonly version: number
	readonly fingerprint: string
}

export interface UnifyStoreDatabase {
	hasStore<TEntity extends object>(entity: StoredEntityClass<TEntity>): Promise<boolean>
	openStore<TEntity extends object>(entity: StoredEntityClass<TEntity>): Promise<UnifyStore<TEntity>>
	/** Every collection this database holds, ordered by schema id; a copy uses it so no collection is left behind. */
	collections(): Promise<readonly UnifyStoreCollectionInfo[]>
	close(): Promise<void>
}

export interface UnifyStoreBackend {
	open(location: string): Promise<UnifyStoreDatabase>
}

/** Transactional access to several collections of one physical database. */
export interface UnifyStoreDatabaseTransaction {
	store<TEntity extends object>(entity: StoredEntityClass<TEntity>): UnifyStoreTransaction<TEntity>
}

/**
 * A database whose collections can be changed together: every write made through
 * `transaction` commits or rolls back as one unit.
 *
 * The operation must only use the transaction handle. Calling a store opened from the
 * same database inside the operation waits for the transaction and never completes.
 */
export interface TransactionalUnifyStoreDatabase extends UnifyStoreDatabase {
	transaction<TResult>(operation: (transaction: UnifyStoreDatabaseTransaction) => TResult | Promise<TResult>): Promise<TResult>
}

/** A backend whose databases support cross-collection transactions; SQLite and JSONL both do. */
export interface TransactionalUnifyStoreBackend extends UnifyStoreBackend {
	open(location: string): Promise<TransactionalUnifyStoreDatabase>
}

export interface BufferedUnifyStoreChange {
	readonly generation: number
}

export type BufferedUnifyStoreChangeListener = (change: BufferedUnifyStoreChange) => void | Promise<void>

/**
 * Optional materialized and staged behavior used by legacy ordered message stores.
 */
export interface BufferedUnifyStore<TItem extends { ts: number }> {
	readonly count: number
	readonly isFullyLoaded: boolean
	getAll(): ReadonlyArray<TItem>
	getByTimestamp(timestamp: number): TItem | undefined
	getAt(index: number): TItem | undefined
	findTimestampIndex(timestamp: number): number
	getRecent(limit: number): Promise<TItem[]>
	getRange(fromTimestamp: number, toTimestamp: number): Promise<TItem[]>
	reload(force?: boolean): Promise<void>
	append(item: TItem): Promise<void>
	appendDurable(item: TItem): Promise<TItem>
	stageInsertAt(index: number, item: TItem): Promise<void>
	stageUpdateAt(index: number, item: TItem): Promise<void>
	stagePatchAt(index: number, updates: Partial<TItem>): Promise<TItem>
	stageUpsertByTimestamp(item: TItem): Promise<void>
	removeAt(index: number): Promise<void>
	insertAt(index: number, item: TItem): Promise<void>
	clear(): Promise<void>
	truncateAt(count: number): Promise<void>
	truncateBeforeTimestamp(timestamp: number): Promise<void>
	mutate(transform: (items: TItem[]) => TItem[]): Promise<void>
	replaceAll(items: readonly TItem[]): Promise<void>
	flush(): Promise<void>
	subscribe(listener: BufferedUnifyStoreChangeListener): () => void
	close(): Promise<void>
}
