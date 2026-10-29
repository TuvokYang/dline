import type { StoredEntityClass } from "./EntitySchema"
import type { UnifyStorePredicate, UnifyStoreQuery } from "./UnifyStoreQuery"

export interface UnifyStoreStats {
    readonly storageBytes: number
    readonly storedRecordCount: number
    readonly degraded: boolean
}

export interface UnifyStoreResult<TEntity extends object> {
    readonly records: TEntity[]
    readonly stats: UnifyStoreStats
}

/**
 * Optional description of a `replaceAll`, computed by a caller that already holds
 * the previous contents.
 *
 * `firstChangedIndex` is the first position whose record differs from what the
 * collection held before the write in the same transaction; it equals the shorter
 * length when one sequence is a prefix of the other. The hint never changes what
 * is stored: a store must produce the same result with or without it, and a store
 * that maintains derived state treats a missing hint as 0.
 */
export interface UnifyStoreWriteHint {
    readonly firstChangedIndex: number
}

export interface UnifyStoreTransaction<TEntity extends object> {
    query(query?: UnifyStoreQuery<TEntity>): Promise<TEntity[]>
    insert(records: readonly TEntity[]): Promise<void>
    /** Insert records or replace the stored record with the same primary key; later duplicates in one batch win. */
    upsert(records: readonly TEntity[]): Promise<void>
    replaceAll(records: readonly TEntity[], hint?: UnifyStoreWriteHint): Promise<void>
}

/**
 * One collection inside a database-wide transaction.
 *
 * Predicate deletes live here rather than on {@link UnifyStoreTransaction}: a store
 * composed of several collections cannot translate a predicate across all of them,
 * and a single collection never needs to delete without other writes depending on it.
 */
export interface UnifyStoreCollectionTransaction<TEntity extends object> extends UnifyStoreTransaction<TEntity> {
    /** Delete every record matching `where`; the remaining records are unaffected. */
    deleteWhere(where: UnifyStorePredicate<TEntity>): Promise<void>
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
    replaceAll(records: readonly TEntity[], hint?: UnifyStoreWriteHint): Promise<void>
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
    store<TEntity extends object>(entity: StoredEntityClass<TEntity>): UnifyStoreCollectionTransaction<TEntity>
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
/** Outcome of {@link BufferedUnifyStore.stageMergeByTimestamp}. */
export interface StagedTimestampMerge<TItem> {
    /** Buffer position of the row after the call. */
    readonly index: number
    /** The row now stored under the timestamp. */
    readonly item: TItem
    /** False when `admit` refused the merge and the row was left as it was. */
    readonly applied: boolean
}

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
    /** Append one row and commit it; rejects when staged changes other than appends are pending. */
    appendDurable(item: TItem): Promise<TItem>
    /**
     * Commit whatever is staged, then append one row durably, under one lock.
     *
     * Unlike {@link appendDurable} a staged in-place rewrite does not reject the
     * row; it is committed first, at the cost of that rewrite.
     */
    commitPendingAndAppendDurable(item: TItem): Promise<TItem>
    stageInsertAt(index: number, item: TItem): Promise<void>
    stageUpdateAt(index: number, item: TItem): Promise<void>
    stagePatchAt(index: number, updates: Partial<TItem>): Promise<TItem>
    stageUpsertByTimestamp(item: TItem): Promise<void>
    /**
     * Merge `item` into the row carrying its timestamp, or insert it in timestamp
     * order when no row does.
     *
     * `admit` sees the current row under the same lock as the write, so a write
     * queued in between cannot invalidate the decision. A refused merge leaves the
     * buffer untouched and reports the row it kept.
     */
    stageMergeByTimestamp(item: TItem, admit?: (current: TItem) => boolean): Promise<StagedTimestampMerge<TItem>>
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
