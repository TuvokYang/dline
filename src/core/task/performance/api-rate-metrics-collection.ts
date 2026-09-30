import type { UnifyStore } from "@core/storage/backend/api/UnifyStore"
import { SqliteUnifyStoreBackend } from "@core/storage/backend/sqlite/SqliteUnifyStore"
import { resolveTaskMetricsDatabase } from "@core/storage/task-metrics-database"
import { LegacyApiRateMetricsWrapperEntity } from "./api-rate-metrics-legacy-wrapper-entity"
import { ApiRateMetricsEntity } from "./api-rate-metrics-record-codec"
import { migrateApiRateMetricsWrapper } from "./api-rate-metrics-wrapper-migration"

export interface ApiRateMetricsCollectionFactoryOptions {
	readonly taskId: string
	readonly location?: string
	readonly readOnly?: boolean
	readonly now?: () => number
}

export async function createApiRateMetricsCollection(
	options: ApiRateMetricsCollectionFactoryOptions,
): Promise<UnifyStore<ApiRateMetricsEntity>> {
	const databasePath = await resolveTaskMetricsDatabase(options.taskId, options.location, options.readOnly)
	const database = await new SqliteUnifyStoreBackend().open(databasePath, { readonly: options.readOnly })
	let legacyStore: UnifyStore<LegacyApiRateMetricsWrapperEntity> | undefined
	let store: UnifyStore<ApiRateMetricsEntity> | undefined
	try {
		if (!options.readOnly && (await database.hasStore(LegacyApiRateMetricsWrapperEntity))) {
			legacyStore = await database.openStore(LegacyApiRateMetricsWrapperEntity)
		}
		store = await database.openStore(ApiRateMetricsEntity)
		if (legacyStore) {
			await migrateApiRateMetricsWrapper({
				taskId: options.taskId,
				source: legacyStore,
				target: store,
				...(options.now ? { now: options.now } : {}),
			})
			await legacyStore.close()
			legacyStore = undefined
		}
		const closeStore = store.close.bind(store)
		let closePromise: Promise<void> | undefined
		store.close = () => {
			closePromise ??= closeStore().then(() => database.close())
			return closePromise
		}
		return store
	} catch (error) {
		await legacyStore?.close().catch(() => undefined)
		await store?.close().catch(() => undefined)
		await database.close().catch(() => undefined)
		throw error
	}
}
