import type { ApiRateMetricPoint, ApiRateMetricsResolution, ApiRateTokenQuality } from "./api-rate-metrics-types"
import type { ApiRequestRoundRecord, ApiRequestRoundStatus } from "./api-request-round-types"
import type { TaskRateMetricPoint, TaskRateUsageQuality } from "./task-rate-metrics-types"

const MILLISECONDS_PER_MINUTE = 60_000
const RESOLUTION_MILLISECONDS: Record<ApiRateMetricsResolution, number> = {
	minute: MILLISECONDS_PER_MINUTE,
	hour: 60 * MILLISECONDS_PER_MINUTE,
	day: 24 * 60 * MILLISECONDS_PER_MINUTE,
}

export interface DurationRpmAggregate {
	roundCount: number
	durationMs: number
	requestsPerMinute?: number
}

export interface RoundUsageAggregate {
	inputTokens?: number
	outputTokens?: number
	thoughtsTokens?: number
	cacheWriteTokens?: number
	cacheReadTokens?: number
	cacheHitRate?: number
	cacheUsageAvailable: boolean
	usageAvailable: boolean
	providerDurationMs?: number
	providerRoundCount: number
	completedRoundCount: number
	failedRoundCount: number
	cancelledRoundCount: number
	abortedRoundCount: number
	requestsPerMinute?: number
	rpmBasis: "provider_duration" | "unavailable"
	usageQuality: TaskRateUsageQuality
	totalCost?: number
	currency?: string
}

export function calculateRoundCacheHitRate(round: ApiRequestRoundRecord): number | undefined {
	if (!round.cacheUsageReported) return undefined
	const inputTokens = round.inputTokens
	const cacheWriteTokens = round.cacheWriteTokens
	const cacheReadTokens = round.cacheReadTokens
	if (inputTokens === undefined || cacheWriteTokens === undefined || cacheReadTokens === undefined) return undefined
	const denominator = inputTokens + cacheWriteTokens + cacheReadTokens
	if (!Number.isFinite(denominator) || denominator <= 0) return undefined
	return cacheReadTokens / denominator
}

export function calculateDurationRpm(rounds: readonly ApiRequestRoundRecord[]): DurationRpmAggregate {
	let roundCount = 0
	let durationMs = 0
	for (const round of rounds) {
		const duration = round.providerDurationMs
		if (duration === undefined || !Number.isFinite(duration) || duration <= 0) continue
		roundCount += 1
		durationMs += duration
	}
	return {
		roundCount,
		durationMs,
		...(roundCount > 0 && durationMs > 0
			? { requestsPerMinute: Math.round((roundCount * MILLISECONDS_PER_MINUTE) / durationMs) }
			: {}),
	}
}

export function aggregateRoundUsage(rounds: readonly ApiRequestRoundRecord[]): RoundUsageAggregate {
	const duration = calculateDurationRpm(rounds)
	const statusCounts: Record<ApiRequestRoundStatus, number> = {
		completed: 0,
		failed: 0,
		cancelled: 0,
		aborted: 0,
	}
	let usageCount = 0
	let inputTokens = 0
	let outputTokens = 0
	let thoughtsTokens = 0
	let cacheWriteTokens = 0
	let cacheReadTokens = 0
	let cacheNumerator = 0
	let cacheDenominator = 0
	let totalCost = 0
	let costAvailable = false
	let currency: string | undefined
	let currencyMixed = false
	let usageQuality: TaskRateUsageQuality = "none"

	for (const round of rounds) {
		statusCounts[round.status] += 1
		if (!hasUsage(round)) continue
		usageCount += 1
		inputTokens += round.inputTokens
		outputTokens += round.outputTokens
		thoughtsTokens += round.thoughtsTokens ?? 0
		cacheWriteTokens += round.cacheWriteTokens ?? 0
		cacheReadTokens += round.cacheReadTokens ?? 0
		usageQuality = mergeUsageQuality(usageQuality, round.usageQuality)

		if (round.totalCost !== undefined && Number.isFinite(round.totalCost) && round.totalCost >= 0) {
			totalCost += round.totalCost
			costAvailable = true
		}
		if (round.currency) {
			if (currency === undefined) currency = round.currency
			else if (currency !== round.currency) currencyMixed = true
		}

		const cacheInput = getCacheInput(round)
		if (cacheInput) {
			cacheNumerator += cacheInput.read
			cacheDenominator += cacheInput.denominator
		}
	}

	return {
		...(usageCount > 0 ? { inputTokens, outputTokens, thoughtsTokens, cacheWriteTokens, cacheReadTokens } : {}),
		...(cacheDenominator > 0 ? { cacheHitRate: cacheNumerator / cacheDenominator } : {}),
		cacheUsageAvailable: cacheDenominator > 0,
		usageAvailable: usageCount > 0,
		...(duration.durationMs > 0 ? { providerDurationMs: duration.durationMs } : {}),
		providerRoundCount: duration.roundCount,
		completedRoundCount: statusCounts.completed,
		failedRoundCount: statusCounts.failed,
		cancelledRoundCount: statusCounts.cancelled,
		abortedRoundCount: statusCounts.aborted,
		...(duration.requestsPerMinute === undefined ? {} : { requestsPerMinute: duration.requestsPerMinute }),
		rpmBasis: duration.requestsPerMinute === undefined ? "unavailable" : "provider_duration",
		usageQuality,
		...(costAvailable ? { totalCost } : {}),
		...(currency !== undefined && !currencyMixed ? { currency } : {}),
	}
}

export function createRoundMetricPoints(rounds: readonly ApiRequestRoundRecord[], limit = 60): TaskRateMetricPoint[] {
	const selected = [...rounds]
		.sort((left, right) => left.completedAtMs - right.completedAtMs || left.providerAttempt - right.providerAttempt)
		.slice(-Math.max(1, Math.trunc(limit)))
	return selected.map((round) => {
		const aggregate = aggregateRoundUsage([round])
		return {
			bucketStartMs: round.completedAtMs,
			bucketEndMs: round.completedAtMs + 1,
			requestCount: 1,
			...(aggregate.usageAvailable ? { tokenCount: totalUsageTokens(aggregate) } : {}),
			...(toTokenQuality(aggregate.usageQuality) === undefined
				? {}
				: { tokenQuality: toTokenQuality(aggregate.usageQuality) }),
			...aggregate,
			status: round.status,
			roundId: round.roundId,
			logicalRequestId: round.logicalRequestId,
			apiIndex: round.apiIndex,
			taskAttempt: round.taskAttempt,
			providerAttempt: round.providerAttempt,
			startedAtMs: round.startedAtMs,
			completedAtMs: round.completedAtMs,
		}
	})
}

export function aggregateRoundBuckets(
	rounds: readonly ApiRequestRoundRecord[],
	resolution: ApiRateMetricsResolution,
	startMs: number,
	endMs: number,
): TaskRateMetricPoint[] {
	const bucketMs = RESOLUTION_MILLISECONDS[resolution]
	const buckets = new Map<number, ApiRequestRoundRecord[]>()
	for (const round of rounds) {
		if (round.completedAtMs < startMs || round.completedAtMs >= endMs) continue
		const bucketStartMs = Math.floor(round.completedAtMs / bucketMs) * bucketMs
		const bucket = buckets.get(bucketStartMs) ?? []
		bucket.push(round)
		buckets.set(bucketStartMs, bucket)
	}
	return [...buckets.entries()]
		.sort(([left], [right]) => left - right)
		.map(([bucketStartMs, bucketRounds]) => {
			const aggregate = aggregateRoundUsage(bucketRounds)
			return {
				bucketStartMs,
				bucketEndMs: bucketStartMs + bucketMs,
				requestCount: aggregate.providerRoundCount,
				...(aggregate.usageAvailable ? { tokenCount: totalUsageTokens(aggregate) } : {}),
				...(toTokenQuality(aggregate.usageQuality) === undefined
					? {}
					: { tokenQuality: toTokenQuality(aggregate.usageQuality) }),
				...aggregate,
			}
		})
}

export function mergeActiveSecondAndRoundPoints(
	activePoints: readonly ApiRateMetricPoint[],
	roundPoints: readonly TaskRateMetricPoint[],
): TaskRateMetricPoint[] {
	const points = new Map<number, TaskRateMetricPoint>()
	for (const active of activePoints) {
		points.set(active.bucketStartMs, fromActivePoint(active))
	}
	for (const round of roundPoints) {
		const active = points.get(round.bucketStartMs)
		if (!active) {
			points.set(round.bucketStartMs, round)
			continue
		}
		points.set(round.bucketStartMs, {
			...round,
			activeSeconds: active.activeSeconds,
			requestCount: active.requestCount,
			tokenCount: active.tokenCount,
			tokensPerMinute: active.tokensPerMinute,
			tokenQuality: active.tokenQuality,
			provisional: active.provisional,
		})
	}
	return [...points.values()].sort((left, right) => left.bucketStartMs - right.bucketStartMs)
}

function fromActivePoint(point: ApiRateMetricPoint): TaskRateMetricPoint {
	return {
		...point,
		cacheUsageAvailable: false,
		usageAvailable: false,
		providerRoundCount: 0,
		completedRoundCount: 0,
		failedRoundCount: 0,
		cancelledRoundCount: 0,
		abortedRoundCount: 0,
		rpmBasis: point.requestsPerMinute > 0 ? "legacy_active_seconds" : "unavailable",
		usageQuality: "none",
	}
}

function hasUsage(round: ApiRequestRoundRecord): round is ApiRequestRoundRecord & { inputTokens: number; outputTokens: number } {
	return (
		round.usageQuality !== "none" &&
		Number.isFinite(round.inputTokens) &&
		(round.inputTokens ?? -1) >= 0 &&
		Number.isFinite(round.outputTokens) &&
		(round.outputTokens ?? -1) >= 0
	)
}

function getCacheInput(round: ApiRequestRoundRecord): { read: number; denominator: number } | undefined {
	if (!round.cacheUsageReported) return undefined
	const input = round.inputTokens
	const write = round.cacheWriteTokens
	const read = round.cacheReadTokens
	if (input === undefined || write === undefined || read === undefined) return undefined
	const denominator = input + write + read
	return Number.isFinite(denominator) && denominator > 0 ? { read, denominator } : undefined
}

function mergeUsageQuality(current: TaskRateUsageQuality, next: ApiRequestRoundRecord["usageQuality"]): TaskRateUsageQuality {
	if (current === "none") return next
	return current === next ? current : "mixed"
}

function toTokenQuality(quality: TaskRateUsageQuality): ApiRateTokenQuality | undefined {
	switch (quality) {
		case "exact":
			return "exact"
		case "estimated":
			return "estimated"
		case "legacy":
			return "estimated"
		case "mixed":
			return "mixed"
		default:
			return undefined
	}
}

/** Thoughts are a share of output, so they are not a separate term. */
function totalUsageTokens(aggregate: RoundUsageAggregate): number {
	return (
		(aggregate.inputTokens ?? 0) +
		(aggregate.outputTokens ?? 0) +
		(aggregate.cacheWriteTokens ?? 0) +
		(aggregate.cacheReadTokens ?? 0)
	)
}
