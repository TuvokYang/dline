import { Logger } from "@shared/services/Logger"
import { TaskPhase } from "../TaskPhase"
import { aggregateApiRateMetrics } from "./api-rate-metrics-aggregator"
import {
	API_RATE_METRICS_SCHEMA_VERSION,
	type ApiRateExactUsage,
	ApiRateMetricsFileIntegrityError,
	type ApiRateMetricsQuery,
	type ApiRateMetricsQueryResult,
	type ApiRateMetricsReadResult,
	type ApiRateMetricsRepository,
	type ApiRateSecondRecord,
	type ApiRateSignal,
	type ApiRateTokenQuality,
	getApiRateSecondActivitySeconds,
} from "./api-rate-metrics-types"
import type { ApiRateSnapshot } from "./api-rate-tracker"

interface TaskApiRateMetricsServiceOptions {
	repository: ApiRateMetricsRepository
	taskId?: string
	now?: () => number
	onChanged?: () => void
}

interface TokenContribution {
	estimatedTokens: number
	effectiveTokens: number
	quality: ApiRateTokenQuality
}

interface MutableSecondBucket {
	second: number
	signals: Set<ApiRateSignal>
	requestCount: number
	baseEstimatedTokens: number
	baseEffectiveTokens: number
	baseQuality?: ApiRateTokenQuality
	contributions: Map<number, TokenContribution>
	persistedRevision?: number
}

interface RequestLedger {
	id: number
	startSecond: number
	lastProviderSecond: number
	estimatedBySecond: Map<number, number>
}

const MILLISECONDS_PER_SECOND = 1_000
const SECONDS_PER_MINUTE = 60
const MAX_QUERY_POINTS = 512
const MAX_RATE_WINDOW_ACTIVE_SECONDS = 60
const SIGNAL_ORDER: readonly ApiRateSignal[] = ["task_active", "provider_active", "request_start", "stream_tokens", "exact_usage"]
const TASK_RATE_LOOP_PHASES = new Set<TaskPhase>([
	TaskPhase.INITIALIZING,
	TaskPhase.STREAMING,
	TaskPhase.EXECUTING,
	TaskPhase.BETWEEN_TURNS,
	TaskPhase.RESUMING,
])

/** Coordinates task-active seconds, provider-active seconds, and append-only usage corrections for one Task. */
export class TaskApiRateMetricsService {
	private readonly repository: ApiRateMetricsRepository
	private readonly taskId: string
	private readonly now: () => number
	private readonly onChanged?: () => void
	private readonly buckets = new Map<number, MutableSecondBucket>()
	private readonly recentSeconds: number[] = []
	private initialized = false
	private disposed = false
	private taskLoopActive = false
	private providerRequestActive = false
	private lastActiveSecond: number | undefined
	private nextRequestId = 1
	private currentRequest: RequestLedger | undefined
	private currentBucket: MutableSecondBucket | undefined
	private boundaryTimer: ReturnType<typeof setTimeout> | undefined
	private writeSequence: Promise<void> = Promise.resolve()
	private persistenceUnavailable = false

	constructor(options: TaskApiRateMetricsServiceOptions) {
		this.repository = options.repository
		this.taskId = options.taskId ?? "unknown"
		this.now = options.now ?? Date.now
		this.onChanged = options.onChanged
	}

	async initialize(): Promise<void> {
		if (this.initialized) return
		try {
			const recovery = await this.repository.initialize()
			this.lastActiveSecond = recovery.lastActiveSecond
			for (const record of recovery.recentRecords ?? (recovery.lastRecord ? [recovery.lastRecord] : [])) {
				this.buckets.set(record.second, {
					second: record.second,
					signals: new Set(record.signals),
					requestCount: record.requestCount,
					baseEstimatedTokens: record.estimatedTokens,
					baseEffectiveTokens: record.effectiveTokens,
					baseQuality: record.tokenQuality,
					contributions: new Map(),
					persistedRevision: record.revision,
				})
				this.recentSeconds.push(record.second)
			}
			this.persistenceUnavailable = recovery.degraded
			this.initialized = true
		} catch (error) {
			if (error instanceof ApiRateMetricsFileIntegrityError) throw error
			this.persistenceUnavailable = true
			this.initialized = true
			Logger.warn(`[Task ${this.taskId}] Failed to initialize API rate metrics; continuing with in-memory metrics`, error)
		}
		if (this.providerRequestActive) {
			const bucket = this.ensureCurrentBucket()
			this.markCurrentActivity(bucket)
			this.notifyChanged()
		}
	}

	setTaskLoopActive(active: boolean): void {
		if (this.disposed || this.taskLoopActive === active) return
		this.taskLoopActive = active
		if (!this.initialized) return
		if (!active && !this.providerRequestActive) this.sealCurrentBucket()
	}

	trackProviderStream<T>(stream: AsyncIterable<T>): AsyncIterable<T> {
		this.recordRequestStarted()
		const service = this
		return {
			async *[Symbol.asyncIterator]() {
				try {
					for await (const chunk of stream) yield chunk
				} finally {
					service.recordProviderRequestFinished()
				}
			},
		}
	}

	recordRequestStarted(): void {
		if (!this.canRecord()) return
		this.providerRequestActive = false
		this.closeCurrentRequest()
		const bucket = this.ensureCurrentBucket()
		const request: RequestLedger = {
			id: this.nextRequestId++,
			startSecond: bucket.second,
			lastProviderSecond: bucket.second,
			estimatedBySecond: new Map(),
		}
		this.currentRequest = request
		this.providerRequestActive = true
		this.markCurrentActivity(bucket)
		bucket.signals.add("request_start")
		bucket.requestCount += 1
		this.notifyChanged()
	}

	recordEstimatedTokens(tokens: number): void {
		if (!this.canRecord()) return
		const roundedTokens = sanitizeTokenCount(tokens)
		if (roundedTokens <= 0) return
		const request = this.findOpenRequest()
		if (!request) return
		const bucket = this.ensureCurrentBucket()
		this.markCurrentActivity(bucket)
		bucket.signals.add("stream_tokens")
		const contribution = this.getContribution(bucket, request.id)
		contribution.estimatedTokens += roundedTokens
		contribution.effectiveTokens += roundedTokens
		contribution.quality = "estimated"
		request.estimatedBySecond.set(bucket.second, (request.estimatedBySecond.get(bucket.second) ?? 0) + roundedTokens)
		this.notifyChanged()
	}

	recordExactUsage(usage: ApiRateExactUsage): void {
		if (!this.canRecord()) return
		const request = this.findOpenRequest()
		if (!request) return
		const exactBucket = this.ensureCurrentBucket()
		if (this.taskLoopActive) exactBucket.signals.add("task_active")
		exactBucket.signals.add("exact_usage")
		// Exact output replaces the streamed estimates in the seconds that produced them.
		const streamedTokens = sanitizeTokenCount(usage.outputTokens)
		const allocations = new Map<number, number>()
		const weightedAllocations = allocateByLargestRemainder(streamedTokens, request.estimatedBySecond)
		if (weightedAllocations.size === 0) addAllocation(allocations, request.lastProviderSecond, streamedTokens)
		else for (const [second, tokens] of weightedAllocations) addAllocation(allocations, second, tokens)

		const affectedSeconds = new Set<number>([...request.estimatedBySecond.keys(), ...allocations.keys()])
		for (const second of affectedSeconds) {
			const bucket = this.requireBucket(second)
			const contribution = this.getContribution(bucket, request.id)
			contribution.effectiveTokens = allocations.get(second) ?? 0
			contribution.quality = "exact"
		}
		this.currentRequest = undefined

		const correctionRecords: ApiRateSecondRecord[] = []
		for (const second of [...affectedSeconds].sort((left, right) => left - right)) {
			const bucket = this.requireBucket(second)
			if (bucket === this.currentBucket || bucket.persistedRevision === undefined) continue
			bucket.persistedRevision += 1
			correctionRecords.push(this.createRecord(bucket, bucket.persistedRevision))
		}
		if (correctionRecords.length > 0) this.enqueueRecords(correctionRecords)
		this.releaseExpiredRequestBuckets(request)
		this.enqueueCompaction()
		this.notifyChanged()
	}

	getSnapshot(): ApiRateSnapshot {
		const window = this.getRateWindow()
		if (window.activeSeconds === 0 && window.providerActiveSeconds === 0) return {}
		return {
			activeSeconds: window.activeSeconds,
			requestsPerMinute: extrapolatePerMinute(window.requestCount, window.activeSeconds),
			tokensPerMinute: extrapolatePerMinute(window.tokenCount, window.providerActiveSeconds),
		}
	}

	async query(query: ApiRateMetricsQuery): Promise<ApiRateMetricsQueryResult> {
		const totalStartedAt = performance.now()
		const waitStartedAt = performance.now()
		await this.waitForPersistence()
		const waitMs = performance.now() - waitStartedAt
		const readStartedAt = performance.now()
		let read: ApiRateMetricsReadResult
		try {
			read = await this.repository.readRange({ startSecond: query.startSecond, endSecond: query.endSecond })
		} catch (error) {
			this.persistenceUnavailable = true
			Logger.warn(`[Task ${this.taskId}] Failed to read API rate metrics; returning in-memory metrics`, error)
			read = { records: [], degraded: true, storageBytes: 0, logicalRecordCount: 0, physicalRecordCount: 0 }
		}
		const readMs = performance.now() - readStartedAt
		const records = [...read.records]
		const provisionalSecond = this.currentBucket?.second
		if (this.currentBucket) {
			const revision = (this.currentBucket.persistedRevision ?? -1) + 1
			records.push(this.createRecord(this.currentBucket, revision))
		}
		const aggregationStartedAt = performance.now()
		const points = aggregateApiRateMetrics(records, { ...query, maxPoints: undefined })
		const aggregationMs = performance.now() - aggregationStartedAt
		const maxPoints = Math.min(MAX_QUERY_POINTS, Math.max(1, Math.trunc(query.maxPoints ?? MAX_QUERY_POINTS)))
		const truncated = points.length > maxPoints
		const selected = truncated ? points.slice(-maxPoints) : points
		if (provisionalSecond !== undefined) {
			const provisionalMs = provisionalSecond * MILLISECONDS_PER_SECOND
			for (const point of selected) {
				if (point.bucketStartMs <= provisionalMs && provisionalMs < point.bucketEndMs) point.provisional = true
			}
		}
		const result = {
			points: selected,
			degraded: read.degraded || this.persistenceUnavailable,
			truncated,
			retentionStartMs: points.at(0)?.bucketStartMs,
		}
		Logger.debug(
			`[Task ${this.taskId}] API rate metrics query: totalMs=${Math.round(performance.now() - totalStartedAt)}, waitMs=${Math.round(waitMs)}, readMs=${Math.round(readMs)}, aggregationMs=${Math.round(aggregationMs)}, records=${records.length}, points=${selected.length}, resolution=${query.resolution}`,
		)
		return result
	}

	async waitForPersistence(): Promise<void> {
		try {
			await this.writeSequence
			await this.repository.waitForWrites()
		} catch (error) {
			this.persistenceUnavailable = true
			Logger.warn(`[Task ${this.taskId}] Failed to flush API rate metrics; continuing without persisted history`, error)
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return
		this.taskLoopActive = false
		this.providerRequestActive = false
		this.closeCurrentRequest()
		this.clearBoundaryTimer()
		this.sealCurrentBucket()
		this.enqueueCompaction()
		this.disposed = true
		await this.waitForPersistence()
		try {
			await this.repository.close()
		} catch (error) {
			this.persistenceUnavailable = true
			Logger.warn(`[Task ${this.taskId}] Failed to close API rate metrics repository`, error)
		}
	}

	private canRecord(): boolean {
		return this.initialized && !this.disposed
	}

	private ensureCurrentBucket(): MutableSecondBucket {
		const second = Math.floor(this.now() / MILLISECONDS_PER_SECOND)
		if (this.currentBucket && this.currentBucket.second !== second) this.sealCurrentBucket()
		let bucket = this.buckets.get(second)
		if (!bucket) {
			bucket = {
				second,
				signals: new Set(),
				requestCount: 0,
				baseEstimatedTokens: 0,
				baseEffectiveTokens: 0,
				contributions: new Map(),
			}
			this.buckets.set(second, bucket)
			this.addRecentSecond(second)
			this.lastActiveSecond = Math.max(this.lastActiveSecond ?? second, second)
		}
		this.currentBucket = bucket
		this.scheduleBoundaryTimer(second)
		return bucket
	}

	private sealCurrentBucket(): void {
		const bucket = this.currentBucket
		if (!bucket) return
		this.currentBucket = undefined
		this.clearBoundaryTimer()
		const revision = (bucket.persistedRevision ?? -1) + 1
		bucket.persistedRevision = revision
		this.enqueueRecords([this.createRecord(bucket, revision)])
	}

	private scheduleBoundaryTimer(second: number): void {
		this.clearBoundaryTimer()
		const delay = Math.max(1, (second + 1) * MILLISECONDS_PER_SECOND - this.now() + 1)
		this.boundaryTimer = setTimeout(() => {
			this.boundaryTimer = undefined
			if (this.currentBucket?.second !== second) return
			this.sealCurrentBucket()
			if (!this.providerRequestActive) return
			const bucket = this.ensureCurrentBucket()
			this.markCurrentActivity(bucket)
			this.notifyChanged()
		}, delay)
	}

	private clearBoundaryTimer(): void {
		if (!this.boundaryTimer) return
		clearTimeout(this.boundaryTimer)
		this.boundaryTimer = undefined
	}

	private enqueueRecords(records: readonly ApiRateSecondRecord[]): void {
		const queued = this.writeSequence
			.catch(() => undefined)
			.then(() => this.repository.append(records))
			.catch((error) => {
				this.persistenceUnavailable = true
				Logger.warn("[TaskApiRateMetricsService] Failed to persist API rate metrics", error)
			})
		this.writeSequence = queued
	}

	private enqueueCompaction(): void {
		const nowSecond = Math.floor(this.now() / MILLISECONDS_PER_SECOND)
		const queued = this.writeSequence
			.catch(() => undefined)
			.then(() => this.repository.compactIfNeeded(nowSecond))
			.then(() => undefined)
			.catch((error) => {
				this.persistenceUnavailable = true
				Logger.warn("[TaskApiRateMetricsService] Failed to compact API rate metrics", error)
			})
		this.writeSequence = queued
	}

	private createRecord(bucket: MutableSecondBucket, revision: number): ApiRateSecondRecord {
		const aggregate = aggregateBucket(bucket)
		const window = this.getRateWindow()
		return {
			schemaVersion: API_RATE_METRICS_SCHEMA_VERSION,
			kind: "second",
			second: bucket.second,
			revision,
			signals: SIGNAL_ORDER.filter((signal) => bucket.signals.has(signal)),
			requestCount: bucket.requestCount,
			estimatedTokens: aggregate.estimatedTokens,
			effectiveTokens: aggregate.effectiveTokens,
			tokenQuality: aggregate.quality,
			runningActiveSeconds: window.activeSeconds,
			runningProviderActiveSeconds: window.providerActiveSeconds,
			runningRequestCount: window.requestCount,
			runningTokenCount: window.tokenCount,
			requestsPerMinute: extrapolatePerMinute(window.requestCount, window.activeSeconds),
			tokensPerMinute: extrapolatePerMinute(window.tokenCount, window.providerActiveSeconds),
		}
	}

	private markCurrentActivity(bucket: MutableSecondBucket): void {
		if (this.taskLoopActive) bucket.signals.add("task_active")
		if (!this.providerRequestActive) return
		bucket.signals.add("provider_active")
		if (this.currentRequest) this.currentRequest.lastProviderSecond = bucket.second
	}

	recordProviderRequestFinished(): void {
		if (!this.providerRequestActive) return
		this.providerRequestActive = false
		if (!this.taskLoopActive) this.sealCurrentBucket()
		this.notifyChanged()
	}

	private getContribution(bucket: MutableSecondBucket, requestId: number): TokenContribution {
		let contribution = bucket.contributions.get(requestId)
		if (!contribution) {
			contribution = { estimatedTokens: 0, effectiveTokens: 0, quality: "estimated" }
			bucket.contributions.set(requestId, contribution)
		}
		return contribution
	}

	private requireBucket(second: number): MutableSecondBucket {
		const bucket = this.buckets.get(second)
		if (!bucket) throw new Error(`API rate metrics bucket is missing for second ${second}`)
		return bucket
	}

	private addRecentSecond(second: number): void {
		if (this.recentSeconds.includes(second)) return
		this.recentSeconds.push(second)
		this.recentSeconds.sort((left, right) => left - right)
		while (this.recentSeconds.length > MAX_RATE_WINDOW_ACTIVE_SECONDS) {
			const expiredSecond = this.recentSeconds.shift()
			if (expiredSecond !== undefined && !this.isSecondReferencedByOpenRequest(expiredSecond)) {
				this.buckets.delete(expiredSecond)
			}
		}
	}

	private getRateWindow(): { activeSeconds: number; providerActiveSeconds: number; requestCount: number; tokenCount: number } {
		let activeSeconds = 0
		let providerActiveSeconds = 0
		let requestCount = 0
		let tokenCount = 0
		for (const second of this.recentSeconds) {
			const bucket = this.buckets.get(second)
			if (!bucket) continue
			const activity = getApiRateSecondActivitySeconds([...bucket.signals])
			const aggregate = aggregateBucket(bucket)
			activeSeconds += activity.activeSeconds
			providerActiveSeconds += activity.providerActiveSeconds
			requestCount += bucket.requestCount
			tokenCount += aggregate.effectiveTokens
		}
		return { activeSeconds, providerActiveSeconds, requestCount, tokenCount }
	}

	private isSecondReferencedByOpenRequest(second: number): boolean {
		return (
			this.currentRequest !== undefined &&
			(this.currentRequest.startSecond === second ||
				this.currentRequest.lastProviderSecond === second ||
				this.currentRequest.estimatedBySecond.has(second))
		)
	}

	private releaseExpiredRequestBuckets(request: RequestLedger): void {
		const referencedSeconds = new Set([request.startSecond, request.lastProviderSecond, ...request.estimatedBySecond.keys()])
		for (const second of referencedSeconds) {
			if (!this.recentSeconds.includes(second) && !this.isSecondReferencedByOpenRequest(second)) {
				this.buckets.delete(second)
			}
		}
	}

	private closeCurrentRequest(): void {
		const request = this.currentRequest
		if (!request) return
		this.currentRequest = undefined
		this.releaseExpiredRequestBuckets(request)
	}

	private findOpenRequest(): RequestLedger | undefined {
		return this.currentRequest
	}

	private notifyChanged(): void {
		this.onChanged?.()
	}
}

function aggregateBucket(bucket: MutableSecondBucket): {
	estimatedTokens: number
	effectiveTokens: number
	quality: ApiRateTokenQuality
} {
	let estimatedTokens = bucket.baseEstimatedTokens
	let effectiveTokens = bucket.baseEffectiveTokens
	const qualities: ApiRateTokenQuality[] = bucket.baseQuality ? [bucket.baseQuality] : []
	for (const contribution of bucket.contributions.values()) {
		estimatedTokens += contribution.estimatedTokens
		effectiveTokens += contribution.effectiveTokens
		qualities.push(contribution.quality)
	}
	if (qualities.length === 0) qualities.push(bucket.signals.has("exact_usage") ? "exact" : "estimated")
	return {
		estimatedTokens,
		effectiveTokens,
		quality: qualities.every((quality) => quality === qualities[0]) ? qualities[0] : "mixed",
	}
}

function allocateByLargestRemainder(totalTokens: number, weights: ReadonlyMap<number, number>): Map<number, number> {
	const positiveWeights = [...weights.entries()].filter(([, weight]) => weight > 0)
	const totalWeight = positiveWeights.reduce((total, [, weight]) => total + weight, 0)
	if (totalTokens <= 0 || totalWeight <= 0) return new Map()
	const allocations = positiveWeights.map(([second, weight]) => {
		const exact = (totalTokens * weight) / totalWeight
		const floor = Math.floor(exact)
		return { second, tokens: floor, remainder: exact - floor }
	})
	let remaining = totalTokens - allocations.reduce((total, allocation) => total + allocation.tokens, 0)
	allocations.sort((left, right) => right.remainder - left.remainder || left.second - right.second)
	for (let index = 0; index < allocations.length && remaining > 0; index += 1) {
		allocations[index].tokens += 1
		remaining -= 1
	}
	return new Map(allocations.map(({ second, tokens }) => [second, tokens]))
}

function addAllocation(allocations: Map<number, number>, second: number, tokens: number): void {
	if (tokens <= 0) return
	allocations.set(second, (allocations.get(second) ?? 0) + tokens)
}

function sanitizeTokenCount(tokens: number): number {
	return Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : 0
}

function extrapolatePerMinute(value: number, activeSeconds: number): number {
	return activeSeconds > 0 ? Math.round((value * SECONDS_PER_MINUTE) / activeSeconds) : 0
}

export function isTaskRateMetricsLoopActive(phase: TaskPhase): boolean {
	return TASK_RATE_LOOP_PHASES.has(phase)
}
