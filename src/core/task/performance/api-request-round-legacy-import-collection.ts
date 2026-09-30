import type { UnifyStore } from "@core/storage/backend/api/UnifyStore"
import { SqliteUnifyStoreBackend } from "@core/storage/backend/sqlite/SqliteUnifyStore"
import { resolveTaskMetricsDatabase } from "@core/storage/task-metrics-database"
import { ApiRequestRoundLegacyImportEntity } from "./api-request-round-legacy-import-entity"

export interface ApiRequestRoundLegacyImportCollectionOptions {
	readonly taskId: string
	readonly location?: string
	readonly readOnly?: boolean
}

/** Open the legacy import entity in the same Task-local SQLite database as exact rounds. */
export async function createApiRequestRoundLegacyImportCollection(
	options: ApiRequestRoundLegacyImportCollectionOptions,
): Promise<UnifyStore<ApiRequestRoundLegacyImportEntity>> {
	const databasePath = await resolveTaskMetricsDatabase(options.taskId, options.location, options.readOnly)
	const database = await new SqliteUnifyStoreBackend().open(databasePath, { readonly: options.readOnly })
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
