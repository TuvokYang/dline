import path from "node:path"
import { DatabaseSync } from "node:sqlite"

interface SchemaRegistryRow {
	physical_name: string
}

interface StoredMetricRow {
	recordKey: string
	revision: number
	schemaVersion: number
	kind: "meta" | "second" | "rollup" | "migration"
	startSecond: number | null
	taskId: string | null
	createdAt: number | null
	second: number | null
	signalsMask: number | null
	requestCount: number | null
	estimatedTokens: number | null
	effectiveTokens: number | null
	tokenQuality: "estimated" | "mixed" | "exact" | null
	runningActiveSeconds: number | null
	runningProviderActiveSeconds: number | null
	runningRequestCount: number | null
	runningTokenCount: number | null
	requestsPerMinute: number | null
	tokensPerMinute: number | null
	resolution: "minute" | "hour" | "day" | null
	bucketStartSecond: number | null
	bucketSeconds: number | null
	activeSeconds: number | null
	providerActiveSeconds: number | null
	tokenCount: number | null
	migrationKey: string | null
	sourceFingerprint: string | null
	importedRecords: number | null
	degraded: number | null
	completedAt: number | null
}

export function readTaskApiRateMetrics<TEntity>(dlineDocsDir: string, taskId: string): TEntity[] | undefined {
	const databasePath = path.join(dlineDocsDir, "tasks", taskId, "metrics.db")
	let database: DatabaseSync | undefined
	try {
		database = new DatabaseSync(databasePath, { readOnly: true })
		const registry = database
			.prepare("SELECT physical_name FROM entity_schema_registry WHERE schema_id = ?")
			.get("api-rate-metrics-flat") as unknown as SchemaRegistryRow | undefined
		if (!registry) return undefined
		const tableName = quoteIdentifier(registry.physical_name)
		const rows = database
			.prepare(`SELECT * FROM ${tableName} ORDER BY "startSecond", "recordKey", "revision"`)
			.all() as unknown as StoredMetricRow[]
		return rows.map(decodeStoredMetricRow) as TEntity[]
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
		if (String(error).includes("unable to open database file")) return undefined
		throw error
	} finally {
		database?.close()
	}
}

function decodeStoredMetricRow(row: StoredMetricRow): object {
	if (row.kind === "meta") {
		return { schemaVersion: row.schemaVersion, kind: row.kind, taskId: row.taskId, createdAt: row.createdAt }
	}
	if (row.kind === "second") {
		return {
			schemaVersion: row.schemaVersion,
			kind: row.kind,
			second: row.second,
			revision: row.revision,
			signals: decodeSignals(row.signalsMask ?? 0),
			requestCount: row.requestCount,
			estimatedTokens: row.estimatedTokens,
			effectiveTokens: row.effectiveTokens,
			tokenQuality: row.tokenQuality,
			runningActiveSeconds: row.runningActiveSeconds,
			...(row.runningProviderActiveSeconds === null
				? {}
				: { runningProviderActiveSeconds: row.runningProviderActiveSeconds }),
			runningRequestCount: row.runningRequestCount,
			runningTokenCount: row.runningTokenCount,
			requestsPerMinute: row.requestsPerMinute,
			tokensPerMinute: row.tokensPerMinute,
		}
	}
	if (row.kind === "rollup") {
		return {
			schemaVersion: row.schemaVersion,
			kind: row.kind,
			resolution: row.resolution,
			bucketStartSecond: row.bucketStartSecond,
			bucketSeconds: row.bucketSeconds,
			activeSeconds: row.activeSeconds,
			...(row.providerActiveSeconds === null ? {} : { providerActiveSeconds: row.providerActiveSeconds }),
			requestCount: row.requestCount,
			tokenCount: row.tokenCount,
			requestsPerMinute: row.requestsPerMinute,
			tokensPerMinute: row.tokensPerMinute,
			tokenQuality: row.tokenQuality,
		}
	}
	return {
		schemaVersion: row.schemaVersion,
		kind: row.kind,
		migrationKey: row.migrationKey,
		sourceFingerprint: row.sourceFingerprint,
		importedRecords: row.importedRecords,
		degraded: row.degraded === null ? null : row.degraded !== 0,
		completedAt: row.completedAt,
	}
}

function decodeSignals(mask: number): string[] {
	const order = ["task_active", "provider_active", "request_start", "stream_tokens", "exact_usage"] as const
	return order.filter((_, index) => (mask & (1 << index)) !== 0)
}

function quoteIdentifier(identifier: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(identifier)) {
		throw new Error(`Unsafe SQLite identifier in E2E metrics reader: ${identifier}`)
	}
	return `"${identifier}"`
}
