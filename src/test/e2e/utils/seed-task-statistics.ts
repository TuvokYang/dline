import path from "node:path"
import { SqliteUnifyStoreBackend } from "../../../core/storage/backend/sqlite/SqliteUnifyStore"
import { ApiRateMetricsEntity, toApiRateMetricsEntity } from "../../../core/task/performance/api-rate-metrics-record-codec"
import {
	API_RATE_METRICS_SCHEMA_VERSION,
	type ApiRateMetricsFileRecord,
	type ApiRateSecondRecord,
} from "../../../core/task/performance/api-rate-metrics-types"
import { ApiRequestRoundEntity, toApiRequestRoundEntity } from "../../../core/task/performance/api-request-round-entity"
import { ApiRequestRoundLegacyImportEntity } from "../../../core/task/performance/api-request-round-legacy-import-entity"
import type { ApiRequestRoundRecord } from "../../../core/task/performance/api-request-round-types"
import {
	ApiResponseExecutionEntity,
	toApiResponseExecutionEntity,
} from "../../../core/task/performance/api-response-execution-entity"
import type { ApiResponseExecutionRecord } from "../../../core/task/performance/api-response-execution-types"

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const LEGACY_IMPORT_MARKER_KEY = "marker:legacy-ui-message-usage-v1"

interface SeedRoundInput {
	readonly inputTokens: number
	readonly outputTokens: number
	readonly cacheWriteTokens: number
	readonly cacheReadTokens: number
	readonly providerDurationMs: number
	readonly executionDurationMs: number
}

const SEEDED_ROUNDS: readonly SeedRoundInput[] = [
	{
		inputTokens: 1_200,
		outputTokens: 200,
		cacheWriteTokens: 0,
		cacheReadTokens: 0,
		providerDurationMs: 1_000,
		executionDurationMs: 4_000,
	},
	{
		inputTokens: 800,
		outputTokens: 300,
		cacheWriteTokens: 0,
		cacheReadTokens: 400,
		providerDurationMs: 2_000,
		executionDurationMs: 8_000,
	},
	{
		inputTokens: 1_600,
		outputTokens: 100,
		cacheWriteTokens: 0,
		cacheReadTokens: 800,
		providerDurationMs: 3_000,
		executionDurationMs: 12_000,
	},
]

export interface SeedTaskStatisticsResult {
	readonly completedAtMs: readonly number[]
	readonly expectedHeaderRpm: number
	readonly expectedCacheHitPercent: number
	readonly totalTokens: readonly number[]
}

/** Seed deterministic Task statistics through current class-first SQLite entities. */
export async function seedTaskStatistics(
	dlineDocsDir: string,
	taskId: string,
	nowMs = Date.now(),
): Promise<SeedTaskStatisticsResult> {
	const databasePath = path.join(dlineDocsDir, "tasks", taskId, `${taskId}.db`)
	const database = await new SqliteUnifyStoreBackend().open(databasePath)
	const roundStore = await database.openStore(ApiRequestRoundEntity)
	const executionStore = await database.openStore(ApiResponseExecutionEntity)
	const activeStore = await database.openStore(ApiRateMetricsEntity)
	const legacyStore = await database.openStore(ApiRequestRoundLegacyImportEntity)
	try {
		const currentHourStartMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS
		const latestRoundIndex = SEEDED_ROUNDS.length - 1
		const latestRound = SEEDED_ROUNDS[latestRoundIndex]
		const latestExecutionTailMs = Math.max(
			0,
			(latestRound?.executionDurationMs ?? 0) - (latestRound?.providerDurationMs ?? 0),
		)
		const latestProviderCompletedAtMs = currentHourStartMs - latestExecutionTailMs - 1
		const completedAtMs = SEEDED_ROUNDS.map((_, index) =>
			index === latestRoundIndex
				? latestProviderCompletedAtMs
				: currentHourStartMs - (3 - index) * HOUR_MS + 30 * MINUTE_MS,
		)
		const rounds = SEEDED_ROUNDS.map((input, index) => createRound(taskId, index, completedAtMs[index] ?? 0, input))
		const executions = rounds.map((round, index) => createExecution(round, SEEDED_ROUNDS[index]?.executionDurationMs ?? 1))
		const activeRecords = createActiveRecords(taskId, rounds, nowMs)
		await roundStore.replaceAll(rounds.map(toApiRequestRoundEntity))
		await executionStore.replaceAll(executions.map(toApiResponseExecutionEntity))
		await activeStore.replaceAll(activeRecords.map(toApiRateMetricsEntity))
		await legacyStore.replaceAll([createLegacyMarker(taskId, nowMs)])

		const durationMs = SEEDED_ROUNDS.reduce((total, round) => total + round.executionDurationMs, 0)
		const cacheReadTokens = SEEDED_ROUNDS.reduce((total, round) => total + round.cacheReadTokens, 0)
		const cacheDenominator = SEEDED_ROUNDS.reduce(
			(total, round) => total + round.inputTokens + round.cacheWriteTokens + round.cacheReadTokens,
			0,
		)
		return {
			completedAtMs: executions.map(({ completedAtMs: executionCompletedAtMs }) => executionCompletedAtMs),
			expectedHeaderRpm: Math.round((SEEDED_ROUNDS.length * MINUTE_MS) / durationMs),
			expectedCacheHitPercent: (cacheReadTokens / cacheDenominator) * 100,
			totalTokens: rounds.map(totalRoundTokens),
		}
	} finally {
		await roundStore.close()
		await executionStore.close()
		await activeStore.close()
		await legacyStore.close()
		await database.close()
	}
}

function createRound(taskId: string, index: number, completedAtMs: number, input: SeedRoundInput): ApiRequestRoundRecord {
	return {
		schemaVersion: 1,
		taskId,
		roundId: `${taskId}:e2e-statistics:provider:${index}`,
		revision: 0,
		logicalRequestId: `e2e-statistics-${index + 1}`,
		apiIndex: index,
		taskAttempt: 0,
		providerAttempt: index,
		startedAtMs: completedAtMs - input.providerDurationMs,
		completedAtMs,
		providerDurationMs: input.providerDurationMs,
		status: "completed",
		inputTokens: input.inputTokens,
		outputTokens: input.outputTokens,
		thoughtsTokens: 0,
		cacheWriteTokens: input.cacheWriteTokens,
		cacheReadTokens: input.cacheReadTokens,
		cacheUsageReported: true,
		totalCost: 0.01 * (index + 1),
		currency: "USD",
		usageQuality: "exact",
	}
}

function createExecution(round: ApiRequestRoundRecord, executionDurationMs: number): ApiResponseExecutionRecord {
	return {
		schemaVersion: 1,
		taskId: round.taskId,
		executionId: round.roundId,
		revision: 0,
		roundId: round.roundId,
		logicalRequestId: round.logicalRequestId,
		apiIndex: round.apiIndex,
		taskAttempt: round.taskAttempt,
		providerAttempt: round.providerAttempt,
		startedAtMs: round.startedAtMs,
		providerCompletedAtMs: round.completedAtMs,
		completedAtMs: round.startedAtMs + executionDurationMs,
		providerDurationMs: round.providerDurationMs,
		executionDurationMs,
		status: "completed",
		terminalKind: "tools_settled",
		toolCount: 1,
		completedToolCount: 1,
		failedToolCount: 0,
		cancelledToolCount: 0,
	}
}

function createActiveRecords(
	taskId: string,
	rounds: readonly ApiRequestRoundRecord[],
	nowMs: number,
): ApiRateMetricsFileRecord[] {
	let runningTokenCount = 0
	const seconds: ApiRateSecondRecord[] = rounds.map((round, index) => {
		const effectiveTokens = totalRoundTokens(round)
		runningTokenCount += effectiveTokens
		const activeSeconds = index + 1
		return {
			schemaVersion: API_RATE_METRICS_SCHEMA_VERSION,
			kind: "second",
			second: Math.floor(round.completedAtMs / 1_000),
			revision: 0,
			signals: ["provider_active", "request_start", "exact_usage"],
			requestCount: 1,
			estimatedTokens: effectiveTokens,
			effectiveTokens,
			tokenQuality: "exact",
			runningActiveSeconds: activeSeconds,
			runningProviderActiveSeconds: activeSeconds,
			runningRequestCount: activeSeconds,
			runningTokenCount,
			requestsPerMinute: 60,
			tokensPerMinute: Math.round((runningTokenCount * 60) / activeSeconds),
		}
	})
	return [
		{
			schemaVersion: API_RATE_METRICS_SCHEMA_VERSION,
			kind: "meta",
			taskId,
			createdAt: nowMs,
		},
		...seconds,
	]
}

function createLegacyMarker(taskId: string, nowMs: number): ApiRequestRoundLegacyImportEntity {
	return new ApiRequestRoundLegacyImportEntity({
		recordKey: LEGACY_IMPORT_MARKER_KEY,
		schemaVersion: 1,
		taskId,
		kind: "marker",
		sourceKey: null,
		messageTs: nowMs,
		roundId: null,
		logicalRequestId: null,
		apiIndex: null,
		inputTokens: null,
		outputTokens: null,
		cacheWriteTokens: null,
		cacheReadTokens: null,
		cacheUsageReported: false,
		totalCost: null,
		currency: null,
		aggregateKind: null,
		sourceFingerprint: "e2e-task-statistics-v1",
		importedRoundCount: 0,
		importedAggregateCount: 0,
		degraded: false,
		importedAtMs: nowMs,
	})
}

function totalRoundTokens(round: ApiRequestRoundRecord): number {
	return (
		(round.inputTokens ?? 0) +
		(round.outputTokens ?? 0) +
		(round.thoughtsTokens ?? 0) +
		(round.cacheWriteTokens ?? 0) +
		(round.cacheReadTokens ?? 0)
	)
}
