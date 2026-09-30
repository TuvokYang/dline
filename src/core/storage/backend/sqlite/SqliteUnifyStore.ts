import type { DatabaseSync } from "node:sqlite"
import type { EntitySchema, EntityValues, StoredEntityClass } from "../api/EntitySchema"
import type { UnifyStore, UnifyStoreBackend, UnifyStoreDatabase, UnifyStoreResult, UnifyStoreStats } from "../api/UnifyStore"
import { UnifyStoreCore, type UnifyStoreDriver, type UnifyStoreDriverTransaction } from "../core/UnifyStoreCore"
import type { NormalizedUnifyStoreQuery } from "../core/UnifyStoreQueryEvaluator"
import { type SqliteDatabaseLease, SqliteDatabaseRegistry } from "./SqliteDatabaseRegistry"
import type { SqliteMigration } from "./SqliteMigrationRegistry"
import { compileSqliteQuery } from "./SqliteQueryCompiler"
import {
	compileEntitySchema,
	decodeSqliteValue,
	encodeSqliteValue,
	physicalTableName,
	quoteIdentifier,
} from "./SqliteSchemaCompiler"

const APPLICATION_ID = 0x444c494e
const registry = new SqliteDatabaseRegistry()

const UNIFY_STORE_MIGRATIONS: readonly SqliteMigration[] = [
	{
		version: 1,
		name: "create_entity_schema_registry",
		migrate(database) {
			database.exec(`
				CREATE TABLE entity_schema_registry (
					schema_id TEXT PRIMARY KEY,
					schema_version INTEGER NOT NULL,
					schema_fingerprint TEXT NOT NULL,
					physical_name TEXT NOT NULL UNIQUE,
					applied_at_ms INTEGER NOT NULL
				)
			`)
		},
	},
]

interface SchemaRegistryRow {
	readonly schema_version: number
	readonly schema_fingerprint: string
	readonly physical_name: string
}

interface CountRow {
	readonly count: number
}

interface PragmaRow {
	readonly page_count?: number
	readonly page_size?: number
}

export class SqliteUnifyStoreBackend implements UnifyStoreBackend {
	async open(location: string, options: { readonly?: boolean } = {}): Promise<UnifyStoreDatabase> {
		const lease = await registry.acquire(location, {
			applicationId: APPLICATION_ID,
			migrations: UNIFY_STORE_MIGRATIONS,
			readonly: options.readonly,
		})
		return new SqliteUnifyStoreDatabase(lease, options.readonly ?? false)
	}
}

class SqliteUnifyStoreDatabase implements UnifyStoreDatabase {
	private closed = false
	private closePromise: Promise<void> | undefined

	constructor(
		private readonly lease: SqliteDatabaseLease,
		private readonly readOnly: boolean,
	) {}

	async hasStore<TEntity extends object>(entity: StoredEntityClass<TEntity>): Promise<boolean> {
		this.assertOpen()
		return await this.lease.withLock(() => {
			this.assertOpen()
			return hasEntitySchema(this.lease.database, entity.storage)
		})
	}

	async openStore<TEntity extends object>(entity: StoredEntityClass<TEntity>): Promise<UnifyStore<TEntity>> {
		this.assertOpen()
		await this.lease.withLock(() => {
			this.assertOpen()
			if (this.readOnly) {
				if (!hasEntitySchema(this.lease.database, entity.storage))
					throw new Error(`Missing entity schema ${entity.storage.schemaId}`)
			} else {
				ensureEntitySchema(this.lease.database, entity.storage)
			}
		})
		return new UnifyStoreCore(entity.storage, new SqliteUnifyStoreDriver(this.lease, entity.storage, this.readOnly))
	}

	close(): Promise<void> {
		this.closePromise ??= Promise.resolve().then(() => {
			this.closed = true
			this.lease.close()
		})
		return this.closePromise
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("SQLite UnifyStore database is closed")
	}
}

class SqliteUnifyStoreDriver<TEntity extends object> implements UnifyStoreDriver<TEntity> {
	private closed = false
	private closePromise: Promise<void> | undefined

	constructor(
		private readonly lease: SqliteDatabaseLease,
		private readonly schema: EntitySchema<TEntity>,
		private readonly readOnly: boolean,
	) {}

	async query(query: NormalizedUnifyStoreQuery<TEntity>): Promise<UnifyStoreResult<TEntity>> {
		this.assertOpen()
		return await this.lease.withLock(() => {
			this.assertOpen()
			return {
				records: selectEntities(this.database, this.schema, query),
				stats: createStats(this.database, countEntities(this.database, this.schema)),
			}
		})
	}

	async insert(records: readonly TEntity[]): Promise<void> {
		this.assertWritable()
		await this.lease.withLock(() => {
			this.assertOpen()
			transactionSync(this.database, () => insertEntities(this.database, this.schema, records))
		})
	}

	async replaceAll(records: readonly TEntity[]): Promise<void> {
		this.assertWritable()
		await this.lease.withLock(() => {
			this.assertOpen()
			transactionSync(this.database, () => replaceAllEntities(this.database, this.schema, records))
		})
	}

	async transaction<TResult>(
		operation: (transaction: UnifyStoreDriverTransaction<TEntity>) => TResult | Promise<TResult>,
	): Promise<TResult> {
		this.assertOpen()
		return await this.lease.withLock(async () => {
			this.assertOpen()
			this.database.exec(this.readOnly ? "BEGIN" : "BEGIN IMMEDIATE")
			try {
				const transaction: UnifyStoreDriverTransaction<TEntity> = {
					query: async (query) => selectEntities(this.database, this.schema, query),
					insert: async (records) => {
						this.assertWritable()
						insertEntities(this.database, this.schema, records)
					},
					replaceAll: async (records) => {
						this.assertWritable()
						replaceAllEntities(this.database, this.schema, records)
					},
				}
				const result = await operation(transaction)
				this.database.exec("COMMIT")
				return result
			} catch (error) {
				rollbackPreservingOriginal(this.database)
				throw error
			}
		})
	}

	async stats(): Promise<UnifyStoreStats> {
		this.assertOpen()
		return await this.lease.withLock(() => {
			this.assertOpen()
			return createStats(this.database, countEntities(this.database, this.schema))
		})
	}

	close(): Promise<void> {
		this.closePromise ??= Promise.resolve().then(() => {
			this.closed = true
		})
		return this.closePromise
	}

	private get database(): DatabaseSync {
		return this.lease.database
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("SQLite UnifyStore driver is closed")
	}

	private assertWritable(): void {
		this.assertOpen()
		if (this.readOnly) throw new Error("SQLite UnifyStore is read-only")
	}
}

function hasEntitySchema<TEntity extends object>(database: DatabaseSync, schema: EntitySchema<TEntity>): boolean {
	const row = readSchemaRegistryRow(database, schema.schemaId)
	if (!row) return false
	validateSchemaRegistryRow(schema, row)
	const table = database
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
		.get(row.physical_name) as unknown as { name: string } | undefined
	if (!table) throw new Error(`Missing entity table for ${schema.schemaId}`)
	return true
}

function ensureEntitySchema<TEntity extends object>(database: DatabaseSync, schema: EntitySchema<TEntity>): void {
	const compiled = compileEntitySchema(schema)
	const row = readSchemaRegistryRow(database, schema.schemaId)
	if (row) {
		validateSchemaRegistryRow(schema, row)
		return
	}

	transactionSync(database, () => {
		database.exec(compiled.createTableSql)
		for (const sql of compiled.createIndexSql) database.exec(sql)
		database
			.prepare(
				"INSERT INTO entity_schema_registry(schema_id, schema_version, schema_fingerprint, physical_name, applied_at_ms) VALUES (?, ?, ?, ?, ?)",
			)
			.run(schema.schemaId, schema.version, schema.fingerprint, compiled.tableName, Date.now())
	})
}

function readSchemaRegistryRow(database: DatabaseSync, schemaId: string): SchemaRegistryRow | undefined {
	return database
		.prepare("SELECT schema_version, schema_fingerprint, physical_name FROM entity_schema_registry WHERE schema_id = ?")
		.get(schemaId) as unknown as SchemaRegistryRow | undefined
}

function validateSchemaRegistryRow<TEntity extends object>(schema: EntitySchema<TEntity>, row: SchemaRegistryRow): void {
	const compiled = compileEntitySchema(schema)
	if (row.schema_version > schema.version) throw new Error(`Future entity schema version for ${schema.schemaId}`)
	if (row.schema_version !== schema.version || row.schema_fingerprint !== schema.fingerprint) {
		throw new Error(`Entity schema conflict for ${schema.schemaId}`)
	}
	if (row.physical_name !== compiled.tableName) throw new Error(`Entity physical name conflict for ${schema.schemaId}`)
}

function insertEntities<TEntity extends object>(
	database: DatabaseSync,
	schema: EntitySchema<TEntity>,
	entities: readonly TEntity[],
): void {
	if (entities.length === 0) return
	const table = quoteIdentifier(physicalTableName(schema.schemaId))
	const columns = schema.columnEntries.map(({ name }) => quoteIdentifier(name)).join(", ")
	const placeholders = schema.columnEntries.map(() => "?").join(", ")
	const statement = database.prepare(`INSERT INTO ${table} (${columns}) VALUES (${placeholders})`)
	for (const entity of entities) {
		const values = schema.dehydrate(entity)
		try {
			statement.run(...schema.columnEntries.map(({ name, column }) => encodeSqliteValue(column.kind, values[name])))
		} catch (error) {
			if (/constraint/i.test(String(error))) throw new Error(`UnifyStore conflict for ${schema.schemaId}`, { cause: error })
			throw error
		}
	}
}

function replaceAllEntities<TEntity extends object>(
	database: DatabaseSync,
	schema: EntitySchema<TEntity>,
	entities: readonly TEntity[],
): void {
	database.exec(`DELETE FROM ${quoteIdentifier(physicalTableName(schema.schemaId))}`)
	insertEntities(database, schema, entities)
}

function selectEntities<TEntity extends object>(
	database: DatabaseSync,
	schema: EntitySchema<TEntity>,
	query: NormalizedUnifyStoreQuery<TEntity>,
): TEntity[] {
	const compiled = compileSqliteQuery(schema, query)
	const rows = database.prepare(compiled.sql).all(...compiled.bindings) as unknown as Array<Record<string, unknown>>
	return rows.map((row) => {
		const values: Record<string, unknown> = {}
		for (const { name, column } of schema.columnEntries) values[name] = decodeSqliteValue(column.kind, row[name])
		return schema.hydrate(values as EntityValues<TEntity>)
	})
}

function countEntities<TEntity extends object>(database: DatabaseSync, schema: EntitySchema<TEntity>): number {
	return (
		database
			.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(physicalTableName(schema.schemaId))}`)
			.get() as unknown as CountRow
	).count
}

function createStats(database: DatabaseSync, count: number): UnifyStoreStats {
	const pageCount = database.prepare("PRAGMA page_count").get() as unknown as PragmaRow
	const pageSize = database.prepare("PRAGMA page_size").get() as unknown as PragmaRow
	return {
		storageBytes: (pageCount.page_count ?? 0) * (pageSize.page_size ?? 0),
		storedRecordCount: count,
		degraded: false,
	}
}

function transactionSync<TResult>(database: DatabaseSync, operation: () => TResult): TResult {
	database.exec("BEGIN IMMEDIATE")
	try {
		const result = operation()
		database.exec("COMMIT")
		return result
	} catch (error) {
		rollbackPreservingOriginal(database)
		throw error
	}
}

function rollbackPreservingOriginal(database: DatabaseSync): void {
	try {
		database.exec("ROLLBACK")
	} catch {
		// Preserve the original operation error.
	}
}

export const sqliteUnifyStoreRegistry = registry
