import type { UnifyStore } from "@core/storage/backend/api/UnifyStore"
import { SqliteUnifyStoreBackend } from "@core/storage/backend/sqlite/SqliteUnifyStore"
import { resolveTaskMetricsDatabase } from "@core/storage/task-metrics-database"
import { ApiRequestRoundEntity } from "./api-request-round-entity"

export interface ApiRequestRoundCollectionOptions {
	readonly taskId: string
	readonly location?: string
	readonly readOnly?: boolean
}

export async function createApiRequestRoundCollection(
	options: ApiRequestRoundCollectionOptions,
): Promise<UnifyStore<ApiRequestRoundEntity>> {
	const databasePath = await resolveTaskMetricsDatabase(options.taskId, options.location, options.readOnly)
	const database = await new SqliteUnifyStoreBackend().open(databasePath, { readonly: options.readOnly })
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
