import { column, defineEntity } from "@core/storage/backend/api/EntitySchema"
import type { UnifyStore, UnifyStoreDatabase } from "@core/storage/backend/api/UnifyStore"
import { eq } from "@core/storage/backend/api/UnifyStoreQuery"
import { SqliteUnifyStoreBackend } from "@core/storage/backend/sqlite/SqliteUnifyStore"
import { resolveTaskMetricsDatabase } from "@core/storage/task-metrics-database"
import type { ApiMetrics } from "@shared/getApiMetrics"

/** The metrics owner's complete usage projection, including legacy and subagent aggregates. */
class TaskUsageSummaryEntity {
	static readonly storage = defineEntity<TaskUsageSummaryEntity>()({
		schemaId: "task-usage-summary",
		version: 1,
		columns: {
			taskId: column.text({ primary: true }),
			usage: column.json<ApiMetrics>({ validate: isPersistableUsage }),
		},
		defaultOrder: [{ field: "taskId", direction: "asc" }],
		hydrate: (values) => new TaskUsageSummaryEntity(values.taskId, values.usage),
	})

	constructor(
		readonly taskId: string,
		readonly usage: ApiMetrics,
	) {}
}

export class TaskUsageSummaryRepository {
	private database?: UnifyStoreDatabase
	private store?: UnifyStore<TaskUsageSummaryEntity>
	private initialization?: Promise<void>
	private closed = false

	constructor(
		private readonly taskId: string,
		private readonly readOnly = false,
	) {}

	async read(): Promise<ApiMetrics | undefined> {
		await this.initialize()
		if (!this.store) return undefined
		const result = await this.store.query({
			where: eq<TaskUsageSummaryEntity, string>(TaskUsageSummaryEntity.storage.fields.taskId, this.taskId),
			limit: 1,
		})
		const usage = result.records[0]?.usage
		if (usage && !isPersistableUsage(usage)) throw new Error("Invalid Task usage summary")
		return usage
	}

	async write(usage: ApiMetrics): Promise<void> {
		if (this.readOnly) throw new Error("Task usage summary is read-only")
		if (!isPersistableUsage(usage)) return
		await this.initialize()
		await this.store?.replaceAll([new TaskUsageSummaryEntity(this.taskId, usage)])
	}

	async close(): Promise<void> {
		this.closed = true
		await this.initialization?.catch(() => undefined)
		try {
			await this.store?.close()
		} finally {
			await this.database?.close()
		}
	}

	private initialize(): Promise<void> {
		if (this.closed) return Promise.reject(new Error("Task usage summary is closed"))
		this.initialization ??= (async () => {
			const location = await resolveTaskMetricsDatabase(this.taskId, undefined, this.readOnly)
			this.database = await new SqliteUnifyStoreBackend().open(location, { readonly: this.readOnly })
			try {
				if (this.readOnly && !(await this.database.hasStore<TaskUsageSummaryEntity>(TaskUsageSummaryEntity))) return
				this.store = await this.database.openStore<TaskUsageSummaryEntity>(TaskUsageSummaryEntity)
			} catch (error) {
				await this.database.close()
				this.database = undefined
				throw error
			}
		})()
		return this.initialization
	}
}

function isPersistableUsage(value: unknown): value is ApiMetrics {
	if (!value || typeof value !== "object") return false
	const usage = value as Partial<ApiMetrics>
	if (
		typeof usage.totalTokensIn !== "number" ||
		typeof usage.totalTokensOut !== "number" ||
		typeof usage.totalCost !== "number"
	) {
		return false
	}
	return (
		[
			usage.totalTokensIn,
			usage.totalTokensOut,
			usage.totalCost,
			usage.totalCacheWrites,
			usage.totalCacheReads,
			usage.cacheHitRate,
		].every((value) => value === undefined || Number.isFinite(value)) &&
		(usage.currency === undefined || typeof usage.currency === "string")
	)
}
