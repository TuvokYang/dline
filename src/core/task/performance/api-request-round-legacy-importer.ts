import type { UnifyStore } from "@core/storage/backend/api/UnifyStore"
import { asc, desc, eq, latestPerGroup } from "@core/storage/backend/api/UnifyStoreQuery"
import { ApiRequestRoundEntity } from "./api-request-round-entity"
import { ApiRequestRoundLegacyImportEntity } from "./api-request-round-legacy-import-entity"
import { type LegacyUiMessageSource, parseLegacyUsageMessages } from "./api-request-round-legacy-usage-parser"

const LEGACY_IMPORT_SCHEMA_VERSION = 1
const LEGACY_IMPORT_MARKER_KEY = "marker:legacy-ui-message-usage-v1"

export interface ApiRequestRoundLegacyImportOptions {
	readonly taskId: string
	readonly exactStore: UnifyStore<ApiRequestRoundEntity>
	readonly legacyStore: UnifyStore<ApiRequestRoundLegacyImportEntity>
	readonly source?: LegacyUiMessageSource
	readonly clock?: () => number
}

export interface ApiRequestRoundLegacyImportResult {
	readonly degraded: boolean
	readonly importedRoundCount: number
	readonly importedAggregateCount: number
}

/** Import legacy UIMessage usage once without inventing Provider duration or per-round aggregate identity. */
export async function importApiRequestRoundLegacyUsage(
	options: ApiRequestRoundLegacyImportOptions,
): Promise<ApiRequestRoundLegacyImportResult> {
	const marker = await options.legacyStore.query({
		where: eq(ApiRequestRoundLegacyImportEntity.storage.fields.recordKey, LEGACY_IMPORT_MARKER_KEY),
		limit: 1,
	})
	if (marker.records[0]) return toImportResult(marker.records[0])
	if (!options.source) return emptyImportResult()

	const exactFields = ApiRequestRoundEntity.storage.fields
	const earliestExact = await options.exactStore.query({
		where: eq(exactFields.taskId, options.taskId),
		select: latestPerGroup({ groupBy: [exactFields.roundId], orderBy: [desc(exactFields.revision)] }),
		orderBy: [asc(exactFields.startedAtMs), asc(exactFields.roundId)],
		limit: 1,
	})
	const earliestExactRound = earliestExact.records[0]
	const cutoffMs = earliestExactRound?.startedAtMs
	const cutoffApiIndex = earliestExactRound?.apiIndex
	const parsed = parseLegacyUsageMessages(options.taskId, options.source.getAll())
	const rounds =
		cutoffMs === undefined || cutoffApiIndex === undefined
			? parsed.rounds
			: parsed.rounds.filter(({ messageTs, apiIndex }) => messageTs < cutoffMs && apiIndex < cutoffApiIndex)
	const aggregates =
		cutoffMs === undefined ? parsed.aggregates : parsed.aggregates.filter(({ messageTs }) => messageTs < cutoffMs)
	const overlapExcluded = rounds.length !== parsed.rounds.length || aggregates.length !== parsed.aggregates.length
	const importedAtMs = readClock(options.clock ?? Date.now)
	const rows = [
		...rounds.map(
			(round) =>
				new ApiRequestRoundLegacyImportEntity({
					recordKey: `legacy-round:${round.sourceKey}`,
					schemaVersion: LEGACY_IMPORT_SCHEMA_VERSION,
					taskId: options.taskId,
					kind: "legacy_round",
					sourceKey: round.sourceKey,
					messageTs: round.messageTs,
					roundId: round.roundId,
					logicalRequestId: round.logicalRequestId,
					apiIndex: round.apiIndex,
					inputTokens: round.inputTokens,
					outputTokens: round.outputTokens,
					cacheWriteTokens: round.cacheWriteTokens,
					cacheReadTokens: round.cacheReadTokens,
					cacheUsageReported: round.cacheUsageReported,
					totalCost: round.totalCost ?? null,
					currency: round.currency ?? null,
					aggregateKind: null,
					sourceFingerprint: null,
					importedRoundCount: 0,
					importedAggregateCount: 0,
					degraded: false,
					importedAtMs,
				}),
		),
		...aggregates.map(
			(aggregate) =>
				new ApiRequestRoundLegacyImportEntity({
					recordKey: `aggregate:${aggregate.sourceKey}`,
					schemaVersion: LEGACY_IMPORT_SCHEMA_VERSION,
					taskId: options.taskId,
					kind: "aggregate",
					sourceKey: aggregate.sourceKey,
					messageTs: aggregate.messageTs,
					roundId: null,
					logicalRequestId: null,
					apiIndex: null,
					inputTokens: aggregate.inputTokens,
					outputTokens: aggregate.outputTokens,
					cacheWriteTokens: aggregate.cacheWriteTokens,
					cacheReadTokens: aggregate.cacheReadTokens,
					cacheUsageReported: aggregate.cacheUsageReported,
					totalCost: aggregate.totalCost ?? null,
					currency: aggregate.currency ?? null,
					aggregateKind: aggregate.aggregateKind,
					sourceFingerprint: null,
					importedRoundCount: 0,
					importedAggregateCount: 0,
					degraded: false,
					importedAtMs,
				}),
		),
	]
	const degraded = parsed.degraded || overlapExcluded
	const markerRow = new ApiRequestRoundLegacyImportEntity({
		recordKey: LEGACY_IMPORT_MARKER_KEY,
		schemaVersion: LEGACY_IMPORT_SCHEMA_VERSION,
		taskId: options.taskId,
		kind: "marker",
		sourceKey: null,
		messageTs: importedAtMs,
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
		sourceFingerprint: parsed.sourceFingerprint,
		importedRoundCount: rounds.length,
		importedAggregateCount: aggregates.length,
		degraded,
		importedAtMs,
	})
	return options.legacyStore.transaction(async (transaction) => {
		const existing = (
			await transaction.query({
				where: eq(ApiRequestRoundLegacyImportEntity.storage.fields.recordKey, LEGACY_IMPORT_MARKER_KEY),
				limit: 1,
			})
		)[0]
		if (existing) return toImportResult(existing)
		await transaction.insert([...rows, markerRow])
		return { degraded, importedRoundCount: rounds.length, importedAggregateCount: aggregates.length }
	})
}

function toImportResult(entity: ApiRequestRoundLegacyImportEntity): ApiRequestRoundLegacyImportResult {
	return {
		degraded: entity.degraded,
		importedRoundCount: entity.importedRoundCount,
		importedAggregateCount: entity.importedAggregateCount,
	}
}

function emptyImportResult(): ApiRequestRoundLegacyImportResult {
	return { degraded: false, importedRoundCount: 0, importedAggregateCount: 0 }
}

function readClock(clock: () => number): number {
	const value = clock()
	if (!Number.isFinite(value) || value < 0)
		throw new Error("Legacy API request round import clock must be non-negative and finite")
	return value
}
