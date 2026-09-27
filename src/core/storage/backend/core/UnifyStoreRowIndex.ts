import type { EntitySchema, EntityValues } from "../api/EntitySchema"
import { UnifyStoreCorruptionError } from "../api/UnifyStoreErrors"
import { primaryKeyOf, rowValuesEqual, type UniqueConstraint, uniqueConstraintsOf, uniqueKeyOf } from "./UnifyStoreKeys"

type StoredValues<TEntity extends object> = EntityValues<TEntity>

/** The error every backend raises when a write would repeat a primary or unique key. */
export function unifyStoreConflict(schemaId: string): Error {
	return new Error(`UnifyStore conflict for ${schemaId}`)
}

/**
 * Rows of one collection held in memory, together with the primary and unique keys
 * that SQLite enforces on its tables, so an in-memory backend rejects the same writes.
 */
export class UnifyStoreRowIndex<TEntity extends object> {
	readonly rows: StoredValues<TEntity>[] = []
	private readonly positions = new Map<string, number>()
	private readonly owners: Map<string, string>[]

	private constructor(
		readonly schema: EntitySchema<TEntity>,
		private readonly constraints: readonly UniqueConstraint<TEntity>[],
	) {
		this.owners = constraints.map(() => new Map())
	}

	static empty<TEntity extends object>(schema: EntitySchema<TEntity>): UnifyStoreRowIndex<TEntity> {
		return new UnifyStoreRowIndex(schema, uniqueConstraintsOf(schema))
	}

	/**
	 * Indexes rows read back from storage.
	 *
	 * @throws UnifyStoreCorruptionError when two stored rows share a key, which a correct writer never produces.
	 */
	static load<TEntity extends object>(
		schema: EntitySchema<TEntity>,
		rows: readonly StoredValues<TEntity>[],
		where: string,
	): UnifyStoreRowIndex<TEntity> {
		const index = UnifyStoreRowIndex.empty(schema)
		for (const row of rows) {
			if (index.conflicts(row, primaryKeyOf(schema, row))) {
				throw new UnifyStoreCorruptionError(`Duplicate ${schema.schemaId} key in ${where}`)
			}
			index.append(row)
		}
		return index
	}

	copy(): UnifyStoreRowIndex<TEntity> {
		const copy = new UnifyStoreRowIndex(this.schema, this.constraints)
		for (const row of this.rows) copy.append(row)
		return copy
	}

	get(primary: string): StoredValues<TEntity> | undefined {
		const position = this.positions.get(primary)
		return position === undefined ? undefined : this.rows[position]
	}

	/** Whether `row` would repeat a primary key, or a unique key that another row holds. */
	conflicts(row: StoredValues<TEntity>, primary: string): boolean {
		return this.positions.has(primary) || this.uniqueHeldByOther(row, primary)
	}

	/** Whether a row other than `primary` holds one of `row`'s unique keys. NULL keys never collide. */
	uniqueHeldByOther(row: StoredValues<TEntity>, primary: string): boolean {
		return this.constraints.some((constraint, index) => {
			const key = uniqueKeyOf(row, constraint)
			if (key === undefined) return false
			const owner = this.owners[index].get(key)
			return owner !== undefined && owner !== primary
		})
	}

	/** Adds a row whose keys the caller has checked. */
	append(row: StoredValues<TEntity>): void {
		const primary = primaryKeyOf(this.schema, row)
		this.positions.set(primary, this.rows.length)
		this.rows.push(row)
		this.claim(row, primary)
	}

	/** Replaces the row stored under `primary` in place; the caller has checked the new unique keys. */
	replace(primary: string, row: StoredValues<TEntity>): void {
		const position = this.positions.get(primary)
		if (position === undefined) throw new Error(`No ${this.schema.schemaId} row to replace`)
		this.release(this.rows[position], primary)
		this.rows[position] = row
		this.claim(row, primary)
	}

	private claim(row: StoredValues<TEntity>, primary: string): void {
		this.constraints.forEach((constraint, index) => {
			const key = uniqueKeyOf(row, constraint)
			if (key !== undefined) this.owners[index].set(key, primary)
		})
	}

	private release(row: StoredValues<TEntity>, primary: string): void {
		this.constraints.forEach((constraint, index) => {
			const key = uniqueKeyOf(row, constraint)
			if (key !== undefined && this.owners[index].get(key) === primary) this.owners[index].delete(key)
		})
	}
}

/**
 * The changes one transaction makes to one collection, kept apart from the committed
 * rows until the transaction commits.
 *
 * Inserts of new keys are collected as an append, which a file backend writes without
 * touching earlier records. Replacing a stored row or the whole collection switches to
 * a full copy that is written as a whole.
 */
export class UnifyStoreCollectionWork<TEntity extends object> {
	private full: UnifyStoreRowIndex<TEntity> | undefined
	private readonly added: UnifyStoreRowIndex<TEntity>

	constructor(
		readonly schema: EntitySchema<TEntity>,
		private readonly base: UnifyStoreRowIndex<TEntity>,
	) {
		this.added = UnifyStoreRowIndex.empty(schema)
	}

	get changed(): boolean {
		return this.full !== undefined || this.added.rows.length > 0
	}

	/** Whether the committed collection must be rewritten rather than extended. */
	get rewrites(): boolean {
		return this.full !== undefined
	}

	/** Rows this work adds after the committed ones; empty when it rewrites. */
	get appended(): readonly StoredValues<TEntity>[] {
		return this.full ? [] : this.added.rows
	}

	/** Rows as this transaction sees them. */
	rows(): readonly StoredValues<TEntity>[] {
		if (this.full) return this.full.rows
		return this.added.rows.length === 0 ? this.base.rows : [...this.base.rows, ...this.added.rows]
	}

	insert(rows: readonly StoredValues<TEntity>[]): void {
		for (const row of rows) this.insertRow(row)
	}

	/** Inserts new keys and replaces stored rows; a row equal to the stored one changes nothing. */
	upsert(rows: readonly StoredValues<TEntity>[]): void {
		for (const row of rows) {
			const primary = primaryKeyOf(this.schema, row)
			const existing = this.full ? this.full.get(primary) : (this.base.get(primary) ?? this.added.get(primary))
			if (existing === undefined) {
				this.insertRow(row)
				continue
			}
			if (rowValuesEqual(this.schema, existing, row)) continue
			const index = this.materialize()
			if (index.uniqueHeldByOther(row, primary)) throw unifyStoreConflict(this.schema.schemaId)
			index.replace(primary, row)
		}
	}

	replaceAll(rows: readonly StoredValues<TEntity>[]): void {
		const index = UnifyStoreRowIndex.empty(this.schema)
		for (const row of rows) {
			if (index.conflicts(row, primaryKeyOf(this.schema, row))) throw unifyStoreConflict(this.schema.schemaId)
			index.append(row)
		}
		this.full = index
	}

	/**
	 * The committed index after this work. An append extends the index the work started
	 * from in place, so call this only once the change is durable.
	 */
	apply(): UnifyStoreRowIndex<TEntity> {
		if (this.full) return this.full
		for (const row of this.added.rows) this.base.append(row)
		return this.base
	}

	private insertRow(row: StoredValues<TEntity>): void {
		const primary = primaryKeyOf(this.schema, row)
		if (this.full) {
			if (this.full.conflicts(row, primary)) throw unifyStoreConflict(this.schema.schemaId)
			this.full.append(row)
			return
		}
		if (this.base.conflicts(row, primary) || this.added.conflicts(row, primary)) {
			throw unifyStoreConflict(this.schema.schemaId)
		}
		this.added.append(row)
	}

	private materialize(): UnifyStoreRowIndex<TEntity> {
		if (!this.full) {
			const index = this.base.copy()
			for (const row of this.added.rows) index.append(row)
			this.full = index
		}
		return this.full
	}
}

/**
 * The values of `entity` as a backend stores them at the moment of the write.
 *
 * JSON goes through a serialize/parse round trip exactly like the SQLite column, and
 * bytes are copied, so a caller that edits the entity afterwards cannot change what
 * was written.
 */
export function snapshotStoredValues<TEntity extends object>(
	schema: EntitySchema<TEntity>,
	entity: TEntity,
): StoredValues<TEntity> {
	const values = schema.dehydrate(entity) as Record<string, unknown>
	const snapshot: Record<string, unknown> = {}
	for (const { name, column } of schema.columnEntries) {
		const value = values[name]
		if (value === null) snapshot[name] = null
		else if (column.kind === "json") snapshot[name] = JSON.parse(JSON.stringify(value))
		else if (column.kind === "blob" && value instanceof Uint8Array) snapshot[name] = new Uint8Array(value)
		else snapshot[name] = value
	}
	return snapshot as StoredValues<TEntity>
}

/** A fresh entity for stored values; JSON and bytes are copied so callers never share stored objects. */
export function hydrateStoredValues<TEntity extends object>(
	schema: EntitySchema<TEntity>,
	values: StoredValues<TEntity>,
): TEntity {
	const stored = values as Record<string, unknown>
	const copy: Record<string, unknown> = {}
	for (const { name, column } of schema.columnEntries) {
		const value = stored[name]
		if (value === null) copy[name] = null
		else if (column.kind === "json") copy[name] = structuredClone(value)
		else if (column.kind === "blob" && value instanceof Uint8Array) copy[name] = new Uint8Array(value)
		else copy[name] = value
	}
	return schema.hydrate(copy as StoredValues<TEntity>)
}
