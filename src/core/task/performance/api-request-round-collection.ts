import type { UnifyStore } from "@core/storage/backend/api/UnifyStore"
import { SqliteUnifyStoreBackend } from "@core/storage/backend/sqlite/SqliteUnifyStore"
import { ApiRequestRoundEntity } from "./api-request-round-entity"
import { resolveTaskMetricsDatabase } from "./task-metrics-database"

export interface ApiRequestRoundCollectionOptions {
	readonly taskId: string
	readonly location?: string
}

export async function createApiRequestRoundCollection(
	options: ApiRequestRoundCollectionOptions,
): Promise<UnifyStore<ApiRequestRoundEntity>> {
	const databasePath = await resolveTaskMetricsDatabase(options.taskId, options.location)
	const database = await new SqliteUnifyStoreBackend().open(databasePath)
	let store: UnifyStore<ApiRequestRoundEntity> | undefined
	try {
		store = await database.openStore(ApiRequestRoundEntity)
		const closeStore = store.close.bind(store)
		let closePromise: Promise<void> | undefined
		store.close = () => {
			closePromise ??= closeStore().then(() => database.close())
			return closePromise
		}
		return store
	} catch (error) {
		await store?.close().catch(() => undefined)
		await database.close().catch(() => undefined)
		throw error
	}
}
