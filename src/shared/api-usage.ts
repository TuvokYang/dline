export interface ApiUsageTokenCounts {
	readonly inputTokens: number
	readonly outputTokens: number
	readonly cacheWriteTokens?: number
	readonly cacheReadTokens?: number
	readonly thoughtsTokens?: number
}

export interface ApiUsageStatistics {
	readonly totalInputTokens: number
	readonly totalTokens: number
	readonly cacheHit: boolean
	readonly cacheHitRatePercent: number
}

/**
 * Derive stable usage statistics from one provider request.
 *
 * Cache hit rate is token-weighted and matches the task UI contract:
 * cache-read tokens divided by all input-side tokens. Invalid or negative
 * provider values contribute zero rather than corrupting telemetry totals.
 */
export function calculateApiUsageStatistics(usage: ApiUsageTokenCounts): ApiUsageStatistics {
	const inputTokens = nonNegativeFinite(usage.inputTokens)
	const outputTokens = nonNegativeFinite(usage.outputTokens)
	const cacheWriteTokens = nonNegativeFinite(usage.cacheWriteTokens)
	const cacheReadTokens = nonNegativeFinite(usage.cacheReadTokens)
	const totalInputTokens = inputTokens + cacheWriteTokens + cacheReadTokens
	const cacheHitRatePercent = totalInputTokens > 0 ? roundToTwoDecimals((cacheReadTokens / totalInputTokens) * 100) : 0

	return {
		totalInputTokens,
		// `thoughtsTokens` is a share of `outputTokens`, never an additional term.
		totalTokens: totalInputTokens + outputTokens,
		cacheHit: cacheReadTokens > 0,
		cacheHitRatePercent,
	}
}

function nonNegativeFinite(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0
}

function roundToTwoDecimals(value: number): number {
	return Math.round(value * 100) / 100
}
