import type { EntitySchema, EntityValues, StoredEntityClass } from "../api/EntitySchema"
import type {
    TransactionalUnifyStoreDatabase,
    UnifyStore,
    UnifyStoreCollectionInfo,
    UnifyStoreCollectionTransaction,
    UnifyStoreDatabaseTransaction,
    UnifyStoreResult,
    UnifyStoreStats,
} from "../api/UnifyStore"
import {
    createValidatedCollectionTransaction,
    type UnifyStoreCollectionDriverTransaction,
    UnifyStoreCore,
    type UnifyStoreDriver,
    type UnifyStoreDriverTransaction,
} from "./UnifyStoreCore"
import { evaluateUnifyStoreValues, matchesUnifyStorePredicate, type NormalizedUnifyStoreQuery } from "./UnifyStoreQueryEvaluator"
import {
    hydrateStoredValues,
    snapshotStoredValues,
    UnifyStoreCollectionWork,
    type UnifyStoreRowIndex,
} from "./UnifyStoreRowIndex"

/** Committed state of one database as a read or write sees it. */
export interface IndexedDatabaseView {
    /**
     * Whether the collection of `schema` exists.
     * @throws when it exists with a different or newer schema.
     */
    registered<TEntity extends object>(schema: EntitySchema<TEntity>): boolean
    /** Committed rows of a registered collection. @throws when the collection is not registered. */
    index<TEntity extends object>(schema: EntitySchema<TEntity>): Promise<UnifyStoreRowIndex<TEntity>>
    /** Physical size of the committed data. */
    readonly storageBytes: number
}

/** Changes of one write; only collections the write touched appear. */
export type IndexedDatabaseChanges = readonly UnifyStoreCollectionWork<object>[]

/**
 * Durable state behind an {@link IndexedUnifyStoreDatabase}: the rows of every collection
 * held in memory and a way to commit changes to them.
 *
 * Every read and write of one location is serialized. A write sees committed state and
 * returns its changes; the engine makes all of them durable as one unit before the write
 * resolves, and a write that throws commits nothing.
 */
export interface IndexedStorageEngine {
    read<TResult>(operation: (view: IndexedDatabaseView) => TResult | Promise<TResult>): Promise<TResult>
    write<TResult>(
        operation: (view: IndexedDatabaseView) => Promise<{ readonly result: TResult; readonly changes: IndexedDatabaseChanges }>,
    ): Promise<TResult>
    /** Registers the collection unless it exists. @throws when it exists with a different or newer schema. */
    ensureCollection<TEntity extends object>(schema: EntitySchema<TEntity>): Promise<void>
    collections(): Promise<readonly UnifyStoreCollectionInfo[]>
    /** Releases this handle's share of the location. */
    close(): Promise<void>
}

/**
 * A transactional UnifyStore database whose rows live in memory and are persisted by an
 * {@link IndexedStorageEngine}. It enforces the same primary and unique keys, ordering and
 * transaction semantics as the SQLite backend, so the two are interchangeable.
 */
export class IndexedUnifyStoreDatabase implements TransactionalUnifyStoreDatabase {
    private closePromise: Promise<void> | undefined

    constructor(
        private readonly engine: IndexedStorageEngine,
        private readonly name: string,
    ) {}

    async hasStore<TEntity extends object>(entity: StoredEntityClass<TEntity>): Promise<boolean> {
        this.assertOpen()
        return await this.engine.read((view) => view.registered(entity.storage))
    }

    async openStore<TEntity extends object>(entity: StoredEntityClass<TEntity>): Promise<UnifyStore<TEntity>> {
        this.assertOpen()
        await this.engine.ensureCollection(entity.storage)
        return new UnifyStoreCore(entity.storage, new IndexedDriver(this.engine, entity.storage, () => this.assertOpen()))
    }

    async collections(): Promise<readonly UnifyStoreCollectionInfo[]> {
        this.assertOpen()
        return await this.engine.collections()
    }

    async transaction<TResult>(
        operation: (transaction: UnifyStoreDatabaseTransaction) => TResult | Promise<TResult>,
    ): Promise<TResult> {
        this.assertOpen()
        return await this.engine.write(async (view) => {
            const works = new Map<string, UnifyStoreCollectionWork<object>>()
            const stores = new Map<string, UnifyStoreCollectionTransaction<object>>()
            const result = await operation({
                store: <TEntity extends object>(entity: StoredEntityClass<TEntity>): UnifyStoreCollectionTransaction<TEntity> => {
                    const schema = entity.storage
                    const cached = stores.get(schema.schemaId)
                    if (cached) return cached as unknown as UnifyStoreCollectionTransaction<TEntity>
                    // Checked here rather than on first use, so a transaction that asks for a
                    // collection it may not use still fails the same way SQLite does.
                    if (!view.registered(schema)) {
                        throw new Error(`UnifyStore collection ${schema.schemaId} must be opened before a database transaction`)
                    }
                    const workOf = async (): Promise<UnifyStoreCollectionWork<TEntity>> => {
                        let work = works.get(schema.schemaId) as UnifyStoreCollectionWork<TEntity> | undefined
                        if (!work) {
                            work = new UnifyStoreCollectionWork(schema, await view.index(schema))
                            works.set(schema.schemaId, work as unknown as UnifyStoreCollectionWork<object>)
                        }
                        return work
                    }
                    const store = createValidatedCollectionTransaction(schema, workTransaction(schema, workOf))
                    stores.set(schema.schemaId, store as unknown as UnifyStoreCollectionTransaction<object>)
                    return store
                },
            })
            return { result, changes: [...works.values()] }
        })
    }

    close(): Promise<void> {
        this.closePromise ??= this.engine.close()
        return this.closePromise
    }

    private assertOpen(): void {
        if (this.closePromise) throw new Error(`UnifyStore database ${this.name} is closed`)
    }
}

function workTransaction<TEntity extends object>(
    schema: EntitySchema<TEntity>,
    workOf: () => Promise<UnifyStoreCollectionWork<TEntity>>,
): UnifyStoreCollectionDriverTransaction<TEntity> {
    return {
        query: async (query) => hydrateAll(schema, evaluateUnifyStoreValues((await workOf()).rows(), query)),
        insert: async (records) => (await workOf()).insert(snapshotAll(schema, records)),
        upsert: async (records) => (await workOf()).upsert(snapshotAll(schema, records)),
        replaceAll: async (records) => (await workOf()).replaceAll(snapshotAll(schema, records)),
        deleteWhere: async (where) => (await workOf()).deleteWhere((row) => matchesUnifyStorePredicate(row, where)),
    }
}

function snapshotAll<TEntity extends object>(
    schema: EntitySchema<TEntity>,
    records: readonly TEntity[],
): EntityValues<TEntity>[] {
    return records.map((record) => snapshotStoredValues(schema, record))
}

function hydrateAll<TEntity extends object>(schema: EntitySchema<TEntity>, rows: readonly EntityValues<TEntity>[]): TEntity[] {
    return rows.map((row) => hydrateStoredValues(schema, row))
}

class IndexedDriver<TEntity extends object> implements UnifyStoreDriver<TEntity> {
    private closed = false

    constructor(
        private readonly engine: IndexedStorageEngine,
        private readonly schema: EntitySchema<TEntity>,
        private readonly assertDatabaseOpen: () => void,
    ) {}

    async query(query: NormalizedUnifyStoreQuery<TEntity>): Promise<UnifyStoreResult<TEntity>> {
        this.assertOpen()
        return await this.engine.read(async (view) => {
            const index = await view.index(this.schema)
            return {
                records: hydrateAll(this.schema, evaluateUnifyStoreValues(index.rows, query)),
                stats: { storageBytes: view.storageBytes, storedRecordCount: index.rows.length, degraded: false },
            }
        })
    }

    insert(records: readonly TEntity[]): Promise<void> {
        return this.change((work) => work.insert(snapshotAll(this.schema, records)))
    }

    upsert(records: readonly TEntity[]): Promise<void> {
        return this.change((work) => work.upsert(snapshotAll(this.schema, records)))
    }

    replaceAll(records: readonly TEntity[]): Promise<void> {
        return this.change((work) => work.replaceAll(snapshotAll(this.schema, records)))
    }

    async transaction<TResult>(
        operation: (transaction: UnifyStoreDriverTransaction<TEntity>) => TResult | Promise<TResult>,
    ): Promise<TResult> {
        this.assertOpen()
        return await this.engine.write(async (view) => {
            const work = new UnifyStoreCollectionWork(this.schema, await view.index(this.schema))
            const result = await operation(workTransaction(this.schema, async () => work))
            return { result, changes: [work as unknown as UnifyStoreCollectionWork<object>] }
        })
    }

    async stats(): Promise<UnifyStoreStats> {
        this.assertOpen()
        return await this.engine.read(async (view) => ({
            storageBytes: view.storageBytes,
            storedRecordCount: (await view.index(this.schema)).rows.length,
            degraded: false,
        }))
    }

    async close(): Promise<void> {
        this.closed = true
    }

    private async change(apply: (work: UnifyStoreCollectionWork<TEntity>) => void): Promise<void> {
        this.assertOpen()
        await this.engine.write(async (view) => {
            const work = new UnifyStoreCollectionWork(this.schema, await view.index(this.schema))
            apply(work)
            return { result: undefined, changes: [work as unknown as UnifyStoreCollectionWork<object>] }
        })
    }

    private assertOpen(): void {
        if (this.closed) throw new Error(`UnifyStore driver for ${this.schema.schemaId} is closed`)
        this.assertDatabaseOpen()
    }
}

/**
 * Checks a stored collection against the schema opening it, with the messages the SQLite
 * backend uses.
 */
export function assertCollectionSchema<TEntity extends object>(
    schema: EntitySchema<TEntity>,
    stored: { readonly version: number; readonly fingerprint: string },
): void {
    if (stored.version > schema.version) throw new Error(`Future entity schema version for ${schema.schemaId}`)
    if (stored.version !== schema.version || stored.fingerprint !== schema.fingerprint) {
        throw new Error(`Entity schema conflict for ${schema.schemaId}`)
    }
}
