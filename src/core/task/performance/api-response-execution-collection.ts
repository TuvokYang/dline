import type { UnifyStore } from "@core/storage/backend/api/UnifyStore"
import { SqliteUnifyStoreBackend } from "@core/storage/backend/sqlite/SqliteUnifyStore"
import { resolveTaskMetricsDatabase } from "@core/storage/task-metrics-database"
import { ApiResponseExecutionEntity } from "./api-response-execution-entity"

export interface ApiResponseExecutionCollectionOptions {
	readonly taskId: string
	readonly location?: string
	readonly readOnly?: boolean
}

export async function createApiResponseExecutionCollection(
	options: ApiResponseExecutionCollectionOptions,
): Promise<UnifyStore<ApiResponseExecutionEntity>> {
	const databasePath = await resolveTaskMetricsDatabase(options.taskId, options.location, options.readOnly)
	const database = await new SqliteUnifyStoreBackend().open(databasePath, { readonly: options.readOnly })
	let store: UnifyStore<ApiResponseExecutionEntity> | undefined
	try {
		store = await database.openStore(ApiResponseExecutionEntity)
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
