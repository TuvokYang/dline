import type { StoredEntityClass } from "../backend/api/EntitySchema"
import type {
	TransactionalUnifyStoreDatabase,
	UnifyStore,
	UnifyStoreDatabaseTransaction,
	UnifyStoreTransaction,
} from "../backend/api/UnifyStore"

/**
 * Wraps `database` so every write first calls `claim`.
 *
 * Opening and reading never claim, so a window that only shows a task can open its
 * files. The first write claims the database for its writer; `claim` throws when
 * another owner already writes it, and the write then fails before touching the file.
 */
export function claimOnWrite(database: TransactionalUnifyStoreDatabase, claim: () => void): TransactionalUnifyStoreDatabase {
	return {
		hasStore<TEntity extends object>(entity: StoredEntityClass<TEntity>): Promise<boolean> {
			return database.hasStore(entity)
		},
		async openStore<TEntity extends object>(entity: StoredEntityClass<TEntity>): Promise<UnifyStore<TEntity>> {
			return claimStore(await database.openStore(entity), claim)
		},
		collections() {
			return database.collections()
		},
		transaction<TResult>(
			operation: (transaction: UnifyStoreDatabaseTransaction) => TResult | Promise<TResult>,
		): Promise<TResult> {
			return database.transaction((transaction) =>
				operation({
					store: <TEntity extends object>(entity: StoredEntityClass<TEntity>) =>
						claimTransaction(transaction.store(entity), claim),
				}),
			)
		},
		close(): Promise<void> {
			return database.close()
		},
	}
}

function claimStore<TEntity extends object>(store: UnifyStore<TEntity>, claim: () => void): UnifyStore<TEntity> {
	return {
		query: (query) => store.query(query),
		insert: async (records) => {
			claim()
			await store.insert(records)
		},
		upsert: async (records) => {
			claim()
			await store.upsert(records)
		},
		replaceAll: async (records) => {
			claim()
			await store.replaceAll(records)
		},
		transaction: (operation) => store.transaction((transaction) => operation(claimTransaction(transaction, claim))),
		stats: () => store.stats(),
		close: () => store.close(),
	}
}

function claimTransaction<TEntity extends object>(
	transaction: UnifyStoreTransaction<TEntity>,
	claim: () => void,
): UnifyStoreTransaction<TEntity> {
	return {
		query: (query) => transaction.query(query),
		insert: async (records) => {
			claim()
			await transaction.insert(records)
		},
		upsert: async (records) => {
			claim()
			await transaction.upsert(records)
		},
		replaceAll: async (records) => {
			claim()
			await transaction.replaceAll(records)
		},
	}
}
