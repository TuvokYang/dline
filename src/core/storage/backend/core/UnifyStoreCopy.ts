import { column, defineEntity, type EntitySchema, type EntityValues, type StoredEntityClass } from "../api/EntitySchema"
import type { TransactionalUnifyStoreDatabase, UnifyStoreDatabase } from "../api/UnifyStore"
import { eq } from "../api/UnifyStoreQuery"
import { rowValuesEqual } from "./UnifyStoreKeys"

/**
 * Records that a database was produced by copying another one, and which copy is newest.
 *
 * When a crash or an open file prevents the source from being removed, both copies stay on
 * disk; the one with the higher generation holds the latest data.
 */
export class UnifyStoreCopyMarker {
	static readonly storage = defineEntity<UnifyStoreCopyMarker>()({
		schemaId: "unify-store-copy-marker",
		version: 1,
		columns: {
			id: column.text({ primary: true }),
			generation: column.integer(),
			source: column.text(),
			copiedAtMs: column.integer(),
		},
		hydrate: (values) => new UnifyStoreCopyMarker(values.id, values.generation, values.source, values.copiedAtMs),
	})

	static readonly ID = "copy"

	constructor(
		readonly id: string,
		readonly generation: number,
		readonly source: string,
		readonly copiedAtMs: number,
	) {}
}

/** Copy generation of `database`: 0 when it was never produced by a copy. */
export async function copyGenerationOf(database: UnifyStoreDatabase): Promise<number> {
	if (!(await database.hasStore(UnifyStoreCopyMarker))) return 0
	const store = await database.openStore(UnifyStoreCopyMarker)
	const [marker] = (await store.query({ where: eq(UnifyStoreCopyMarker.storage.fields.id, UnifyStoreCopyMarker.ID) })).records
	return marker?.generation ?? 0
}

export interface UnifyStoreCopyOptions {
	readonly source: UnifyStoreDatabase
	readonly target: TransactionalUnifyStoreDatabase
	/** Entities of every collection the source may hold. */
	readonly entities: readonly StoredEntityClass<object>[]
	/** Describes the source in the copy marker, for diagnostics. */
	readonly sourceLabel: string
}

export interface UnifyStoreCopyResult {
	readonly generation: number
	readonly rowsByCollection: ReadonlyMap<string, number>
}

/**
 * Copies every collection of `source` into `target` and verifies the copy row by row.
 *
 * All rows and the copy marker are written in one target transaction, so the target either
 * holds the complete copy or its previous content. The copy is refused when the source holds
 * a collection that `entities` does not describe, because it could not be carried over.
 *
 * @throws when a collection is unknown, a schema differs, or the verification finds any
 * difference; the target must then be discarded.
 */
export async function copyUnifyStoreDatabase(options: UnifyStoreCopyOptions): Promise<UnifyStoreCopyResult> {
	const { source, target, entities } = options
	const bySchemaId = new Map(entities.map((entity) => [entity.storage.schemaId, entity]))
	const selected: StoredEntityClass<object>[] = []
	for (const info of await source.collections()) {
		if (info.schemaId === UnifyStoreCopyMarker.storage.schemaId) continue
		const entity = bySchemaId.get(info.schemaId)
		if (!entity) throw new Error(`Cannot copy unknown UnifyStore collection ${info.schemaId}`)
		if (entity.storage.version !== info.version || entity.storage.fingerprint !== info.fingerprint) {
			throw new Error(`Cannot copy ${info.schemaId}: stored schema differs from the current one`)
		}
		selected.push(entity)
	}

	const snapshot = new Map<string, EntityValues<object>[]>()
	for (const entity of selected) {
		const store = await source.openStore(entity)
		snapshot.set(
			entity.storage.schemaId,
			(await store.query()).records.map((record) => entity.storage.dehydrate(record)),
		)
	}
	const generation = (await copyGenerationOf(source)) + 1

	for (const entity of selected) await target.openStore(entity)
	await target.openStore(UnifyStoreCopyMarker)
	await target.transaction(async (transaction) => {
		for (const entity of selected) {
			const rows = snapshot.get(entity.storage.schemaId) ?? []
			await transaction.store(entity).replaceAll(rows.map((row) => entity.storage.hydrate(row)))
		}
		await transaction
			.store(UnifyStoreCopyMarker)
			.replaceAll([new UnifyStoreCopyMarker(UnifyStoreCopyMarker.ID, generation, options.sourceLabel, Date.now())])
	})

	const rowsByCollection = new Map<string, number>()
	for (const entity of selected) {
		const expected = snapshot.get(entity.storage.schemaId) ?? []
		const store = await target.openStore(entity)
		const actual = (await store.query()).records.map((record) => entity.storage.dehydrate(record))
		assertSameRows(entity.storage, expected, actual)
		rowsByCollection.set(entity.storage.schemaId, actual.length)
	}
	const copied = new Set((await target.collections()).map((info) => info.schemaId))
	for (const entity of selected) {
		if (!copied.has(entity.storage.schemaId)) throw new Error(`Copy is missing collection ${entity.storage.schemaId}`)
	}
	return { generation, rowsByCollection }
}

function assertSameRows<TEntity extends object>(
	schema: EntitySchema<TEntity>,
	expected: readonly EntityValues<TEntity>[],
	actual: readonly EntityValues<TEntity>[],
): void {
	if (expected.length !== actual.length) {
		throw new Error(`Copy of ${schema.schemaId} holds ${actual.length} rows instead of ${expected.length}`)
	}
	expected.forEach((row, index) => {
		if (!rowValuesEqual(schema, row, actual[index])) throw new Error(`Copy of ${schema.schemaId} differs at row ${index}`)
	})
}
