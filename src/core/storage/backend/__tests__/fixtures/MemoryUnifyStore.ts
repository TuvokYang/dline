import Mutex from "p-mutex"
import type { EntitySchema, EntityValues, StoredEntityClass } from "../../api/EntitySchema"
import type { UnifyStore, UnifyStoreBackend, UnifyStoreDatabase, UnifyStoreResult, UnifyStoreStats } from "../../api/UnifyStore"
import { UnifyStoreCore, type UnifyStoreDriver, type UnifyStoreDriverTransaction } from "../../core/UnifyStoreCore"
import { evaluateUnifyStoreQuery, type NormalizedUnifyStoreQuery } from "../../core/UnifyStoreQueryEvaluator"

interface MemoryCollectionState {
	readonly schemaId: string
	readonly version: number
	readonly fingerprint: string
	rows: Array<Record<string, unknown>>
	readonly mutex: Mutex
}

interface MemoryDatabaseState {
	readonly collections: Map<string, MemoryCollectionState>
}

export class MemoryUnifyStoreBackend implements UnifyStoreBackend {
	private readonly locations = new Map<string, MemoryDatabaseState>()

	async open(location: string): Promise<UnifyStoreDatabase> {
		let state = this.locations.get(location)
		if (!state) {
			state = { collections: new Map() }
			this.locations.set(location, state)
		}
		return new MemoryUnifyStoreDatabase(state)
	}
}

class MemoryUnifyStoreDatabase implements UnifyStoreDatabase {
	private closed = false
	private closePromise: Promise<void> | undefined

	constructor(private readonly state: MemoryDatabaseState) {}

	async hasStore<TEntity extends object>(entity: StoredEntityClass<TEntity>): Promise<boolean> {
		this.assertOpen()
		const collection = this.state.collections.get(entity.storage.schemaId)
		if (!collection) return false
		assertMatchingSchema(entity.storage, collection)
		return true
	}

	async openStore<TEntity extends object>(entity: StoredEntityClass<TEntity>): Promise<UnifyStore<TEntity>> {
		this.assertOpen()
		const schema = entity.storage
		let collection = this.state.collections.get(schema.schemaId)
		if (!collection) {
			collection = {
				schemaId: schema.schemaId,
				version: schema.version,
				fingerprint: schema.fingerprint,
				rows: [],
				mutex: new Mutex(),
			}
			this.state.collections.set(schema.schemaId, collection)
		} else {
			assertMatchingSchema(schema, collection)
		}
		return new UnifyStoreCore(schema, new MemoryUnifyStoreDriver(schema, collection))
	}

	close(): Promise<void> {
		this.closePromise ??= Promise.resolve().then(() => {
			this.closed = true
		})
		return this.closePromise
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("UnifyStore database is closed")
	}
}

function assertMatchingSchema<TEntity extends object>(schema: EntitySchema<TEntity>, collection: MemoryCollectionState): void {
	if (collection.version > schema.version) throw new Error(`Future entity schema version for ${schema.schemaId}`)
	if (collection.version !== schema.version || collection.fingerprint !== schema.fingerprint) {
		throw new Error(`Entity schema conflict for ${schema.schemaId}`)
	}
}

class MemoryUnifyStoreDriver<TEntity extends object> implements UnifyStoreDriver<TEntity> {
	private closed = false
	private closePromise: Promise<void> | undefined

	constructor(
		private readonly schema: EntitySchema<TEntity>,
		private readonly state: MemoryCollectionState,
	) {}

	async query(query: NormalizedUnifyStoreQuery<TEntity>): Promise<UnifyStoreResult<TEntity>> {
		this.assertOpen()
		return await this.state.mutex.withLock(() => {
			this.assertOpen()
			const records = evaluateUnifyStoreQuery(this.schema, hydrateRows(this.schema, this.state.rows), query)
			return { records, stats: createStats(this.state.rows.length) }
		})
	}

	async insert(records: readonly TEntity[]): Promise<void> {
		this.assertOpen()
		await this.state.mutex.withLock(() => {
			this.assertOpen()
			const next = cloneRows(this.state.rows)
			appendRows(this.schema, next, records)
			this.state.rows = next
		})
	}

	async upsert(records: readonly TEntity[]): Promise<void> {
		this.assertOpen()
		await this.state.mutex.withLock(() => {
			this.assertOpen()
			const next = cloneRows(this.state.rows)
			upsertRows(this.schema, next, records)
			this.state.rows = next
		})
	}

	async replaceAll(records: readonly TEntity[]): Promise<void> {
		this.assertOpen()
		await this.state.mutex.withLock(() => {
			this.assertOpen()
			const next: Array<Record<string, unknown>> = []
			appendRows(this.schema, next, records)
			this.state.rows = next
		})
	}

	async transaction<TResult>(
		operation: (transaction: UnifyStoreDriverTransaction<TEntity>) => TResult | Promise<TResult>,
	): Promise<TResult> {
		this.assertOpen()
		return await this.state.mutex.withLock(async () => {
			this.assertOpen()
			let working = cloneRows(this.state.rows)
			const transaction: UnifyStoreDriverTransaction<TEntity> = {
				query: async (query) => evaluateUnifyStoreQuery(this.schema, hydrateRows(this.schema, working), query),
				insert: async (records) => appendRows(this.schema, working, records),
				upsert: async (records) => upsertRows(this.schema, working, records),
				replaceAll: async (records) => {
					const replacement: Array<Record<string, unknown>> = []
					appendRows(this.schema, replacement, records)
					working = replacement
				},
			}
			const result = await operation(transaction)
			this.state.rows = working
			return result
		})
	}

	async stats(): Promise<UnifyStoreStats> {
		this.assertOpen()
		return await this.state.mutex.withLock(() => createStats(this.state.rows.length))
	}

	close(): Promise<void> {
		this.closePromise ??= Promise.resolve().then(() => {
			this.closed = true
		})
		return this.closePromise
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("Memory UnifyStore driver is closed")
	}
}

function upsertRows<TEntity extends object>(
	schema: EntitySchema<TEntity>,
	rows: Array<Record<string, unknown>>,
	records: readonly TEntity[],
): void {
	const indexByKey = new Map(rows.map((row, index) => [primaryKey(schema, row), index]))
	for (const record of records) {
		const row = structuredClone(schema.dehydrate(record) as Record<string, unknown>)
		const key = primaryKey(schema, row)
		const existing = indexByKey.get(key)
		if (existing === undefined) {
			indexByKey.set(key, rows.length)
			rows.push(row)
		} else {
			rows[existing] = row
		}
	}
}

function appendRows<TEntity extends object>(
	schema: EntitySchema<TEntity>,
	rows: Array<Record<string, unknown>>,
	records: readonly TEntity[],
): void {
	const keys = new Set(rows.map((row) => primaryKey(schema, row)))
	for (const record of records) {
		const row = schema.dehydrate(record) as Record<string, unknown>
		const key = primaryKey(schema, row)
		if (keys.has(key)) throw new Error(`UnifyStore conflict for ${schema.schemaId}`)
		keys.add(key)
		rows.push(structuredClone(row))
	}
}

function hydrateRows<TEntity extends object>(schema: EntitySchema<TEntity>, rows: readonly Record<string, unknown>[]): TEntity[] {
	return rows.map((row) => schema.hydrate(structuredClone(row) as EntityValues<TEntity>))
}

function primaryKey<TEntity extends object>(schema: EntitySchema<TEntity>, row: Record<string, unknown>): string {
	return schema.primaryFields.map((field) => serializeKey(row[field.name])).join("|")
}

function serializeKey(value: unknown): string {
	if (typeof value === "bigint") return `bigint:${value}`
	if (value instanceof Uint8Array) return `blob:${Buffer.from(value).toString("base64")}`
	return `${typeof value}:${JSON.stringify(value)}`
}

function cloneRows(rows: readonly Record<string, unknown>[]): Array<Record<string, unknown>> {
	return rows.map((row) => structuredClone(row))
}

function createStats(count: number): UnifyStoreStats {
	return { storageBytes: Buffer.byteLength(JSON.stringify({ count })), storedRecordCount: count, degraded: false }
}
