import Mutex from "p-mutex"
import type { EntitySchema } from "../../api/EntitySchema"
import type {
	TransactionalUnifyStoreBackend,
	TransactionalUnifyStoreDatabase,
	UnifyStoreCollectionInfo,
} from "../../api/UnifyStore"
import {
	assertCollectionSchema,
	type IndexedDatabaseView,
	type IndexedStorageEngine,
	IndexedUnifyStoreDatabase,
} from "../../core/IndexedUnifyStoreDatabase"
import { compareCodePoints } from "../../core/UnifyStoreQueryEvaluator"
import { UnifyStoreRowIndex } from "../../core/UnifyStoreRowIndex"

interface MemoryCollection {
	readonly version: number
	readonly fingerprint: string
	index: UnifyStoreRowIndex<object>
}

interface MemoryDatabaseState {
	readonly mutex: Mutex
	readonly collections: Map<string, MemoryCollection>
}

/**
 * In-memory backend for tests. It shares the row index and transaction core with the
 * JSONL backend, so it enforces the same keys, ordering and rollback as SQLite.
 */
export class MemoryUnifyStoreBackend implements TransactionalUnifyStoreBackend {
	private readonly locations = new Map<string, MemoryDatabaseState>()

	async open(location: string): Promise<TransactionalUnifyStoreDatabase> {
		let state = this.locations.get(location)
		if (!state) {
			state = { mutex: new Mutex(), collections: new Map() }
			this.locations.set(location, state)
		}
		return new IndexedUnifyStoreDatabase(memoryEngine(state), location)
	}
}

function memoryEngine(state: MemoryDatabaseState): IndexedStorageEngine {
	const view: IndexedDatabaseView = {
		registered: (schema) => {
			const collection = state.collections.get(schema.schemaId)
			if (!collection) return false
			assertCollectionSchema(schema, collection)
			return true
		},
		index: async (schema) => collectionOf(state, schema).index as never,
		get storageBytes() {
			let rows = 0
			for (const collection of state.collections.values()) rows += collection.index.rows.length
			return rows
		},
	}
	return {
		read: (operation) => state.mutex.withLock(() => operation(view)),
		write: (operation) =>
			state.mutex.withLock(async () => {
				const { result, changes } = await operation(view)
				for (const work of changes) {
					if (work.changed) collectionOf(state, work.schema).index = work.apply()
				}
				return result
			}),
		ensureCollection: (schema) =>
			state.mutex.withLock(() => {
				if (view.registered(schema)) return
				state.collections.set(schema.schemaId, {
					version: schema.version,
					fingerprint: schema.fingerprint,
					index: UnifyStoreRowIndex.empty(schema) as unknown as UnifyStoreRowIndex<object>,
				})
			}),
		collections: () =>
			state.mutex.withLock((): UnifyStoreCollectionInfo[] =>
				[...state.collections.entries()]
					.map(([schemaId, { version, fingerprint }]) => ({ schemaId, version, fingerprint }))
					.sort((left, right) => compareCodePoints(left.schemaId, right.schemaId)),
			),
		close: async () => undefined,
	}
}

function collectionOf<TEntity extends object>(state: MemoryDatabaseState, schema: EntitySchema<TEntity>): MemoryCollection {
	const collection = state.collections.get(schema.schemaId)
	if (!collection) throw new Error(`UnifyStore collection ${schema.schemaId} is not registered`)
	assertCollectionSchema(schema, collection)
	return collection
}
