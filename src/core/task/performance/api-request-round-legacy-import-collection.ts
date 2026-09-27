import type { UnifyStore } from "@core/storage/backend/api/UnifyStore"
import { SqliteUnifyStoreBackend } from "@core/storage/backend/sqlite/SqliteUnifyStore"
import { ApiRequestRoundLegacyImportEntity } from "./api-request-round-legacy-import-entity"
import { resolveTaskMetricsDatabase } from "./task-metrics-database"

export interface ApiRequestRoundLegacyImportCollectionOptions {
	readonly taskId: string
	readonly location?: string
}

/** Open the legacy import entity in the task's `metrics.db`, beside the exact rounds. */
export async function createApiRequestRoundLegacyImportCollection(
	options: ApiRequestRoundLegacyImportCollectionOptions,
): Promise<UnifyStore<ApiRequestRoundLegacyImportEntity>> {
	const databasePath = await resolveTaskMetricsDatabase(options.taskId, options.location)
	const database = await new SqliteUnifyStoreBackend().open(databasePath)
	let store: UnifyStore<ApiRequestRoundLegacyImportEntity> | undefined
	try {
		store = await database.openStore(ApiRequestRoundLegacyImportEntity)
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
