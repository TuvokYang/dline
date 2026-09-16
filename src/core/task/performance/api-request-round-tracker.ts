import { performance } from "node:perf_hooks"
import { taskTraceSource } from "@/services/telemetry/service/task-trace-context"
import { aggregateRoundUsage } from "./api-request-round-aggregator"
import {
	API_REQUEST_ROUND_SCHEMA_VERSION,
	type ApiRequestRoundCumulativeUsage,
	type ApiRequestRoundRecord,
	type ApiRequestRoundRepository,
	type ApiRequestRoundStatus,
	type ApiRequestRoundUsage,
} from "./api-request-round-types"

export interface BeginApiRequestRound {
	readonly logicalRequestId: string
	readonly apiIndex: number
	readonly taskAttempt: number
}

export interface ApiRequestRoundHandle {
	readonly roundId: string
	readonly logicalRequestId: string
	readonly apiIndex: number
	readonly taskAttempt: number
	readonly providerAttempt: number
	readonly startedAtMs: number
	readonly startedMonotonicMs: number
}

interface MutableRoundState extends ApiRequestRoundHandle {
	readonly startedAtMs: number
	readonly startedMonotonicMs: number
	terminalRecord?: ApiRequestRoundRecord
	latestRevision: number
}

export interface ApiRequestRoundTrackerOptions {
	readonly taskId: string
	readonly repository: ApiRequestRoundRepository
	readonly wallClock?: () => number
	readonly monotonicClock?: () => number
	readonly onChanged?: () => void
}

export interface ApiRequestRoundSnapshot {
	readonly requestsPerMinute?: number
	readonly rpmBasis: "provider_duration" | "unavailable"
	readonly providerRoundCount: number
	readonly totalTokensIn?: number
	readonly totalTokensOut?: number
	readonly totalCacheWrites?: number
	readonly totalCacheReads?: number
	readonly totalCost?: number
	readonly cacheHitRate?: number
	readonly cacheUsageAvailable: boolean
	readonly currency?: string
}

/** Converts actual Provider sends into revisioned, durable round records. */
const RATE_ROUND_LIMIT = 60

export class ApiRequestRoundTracker {
	private readonly wallClock: () => number
	private readonly monotonicClock: () => number
	private readonly nextProviderAttempt = new Map<string, number>()
	private readonly rounds = new Map<string, MutableRoundState>()
	private recoveredRounds: ApiRequestRoundRecord[] = []
	private recoveredCumulative: ApiRequestRoundCumulativeUsage = {
		degraded: false,
		cacheNumerator: 0,
		cacheDenominator: 0,
	}
	private initialization: Promise<void> | undefined
	private writeSequence: Promise<void> = Promise.resolve()
	private closing = false

	constructor(private readonly options: ApiRequestRoundTrackerOptions) {
		this.wallClock = options.wallClock ?? Date.now
		this.monotonicClock = options.monotonicClock ?? performance.now.bind(performance)
	}

	initialize(): Promise<void> {
		this.initialization ??= Promise.all([
			this.options.repository.readRecent(RATE_ROUND_LIMIT),
			this.options.repository.readCumulativeUsage(),
		]).then(([records, cumulative]) => {
			this.recoveredRounds = records
			this.recoveredCumulative = cumulative
		})
		return this.initialization
	}

	beginRound(input: BeginApiRequestRound): ApiRequestRoundHandle {
		if (this.closing) throw new Error("API request round tracker is closing")
		assertIdentity(input)
		const providerAttempt = this.nextProviderAttempt.get(input.logicalRequestId) ?? 0
		this.nextProviderAttempt.set(input.logicalRequestId, providerAttempt + 1)
		const roundId = `${this.options.taskId}:${input.logicalRequestId}:provider:${providerAttempt}`
		const state: MutableRoundState = {
			roundId,
			logicalRequestId: input.logicalRequestId,
			apiIndex: input.apiIndex,
			taskAttempt: input.taskAttempt,
			providerAttempt,
			startedAtMs: readClock(this.wallClock, "wall clock"),
			startedMonotonicMs: readClock(this.monotonicClock, "monotonic clock"),
			latestRevision: -1,
		}
		this.rounds.set(roundId, state)
		return toHandle(state)
	}

	finishRound(handle: ApiRequestRoundHandle, status: ApiRequestRoundStatus): ApiRequestRoundRecord {
		const state = this.requireState(handle)
		if (state.terminalRecord) return state.terminalRecord
		const completedAtMs = readClock(this.wallClock, "wall clock")
		const completedMonotonicMs = readClock(this.monotonicClock, "monotonic clock")
		if (completedAtMs < state.startedAtMs) throw new Error("API request round wall clock moved before start")
		if (completedMonotonicMs < state.startedMonotonicMs)
			throw new Error("API request round monotonic clock moved before start")
		const record: ApiRequestRoundRecord = {
			schemaVersion: API_REQUEST_ROUND_SCHEMA_VERSION,
			taskId: this.options.taskId,
			roundId: state.roundId,
			revision: 0,
			logicalRequestId: state.logicalRequestId,
			apiIndex: state.apiIndex,
			taskAttempt: state.taskAttempt,
			providerAttempt: state.providerAttempt,
			startedAtMs: state.startedAtMs,
			completedAtMs,
			providerDurationMs: Math.max(1, completedMonotonicMs - state.startedMonotonicMs),
			status,
			cacheUsageReported: false,
			usageQuality: "none",
		}
		state.terminalRecord = record
		state.latestRevision = 0
		this.enqueue(record)
		this.options.onChanged?.()
		return record
	}

	attachExactUsage(handle: ApiRequestRoundHandle, usage: ApiRequestRoundUsage): void {
		const state = this.requireState(handle)
		const terminal = state.terminalRecord
		if (!terminal) throw new Error("API request round usage cannot be attached before terminal status")
		assertUsage(usage)
		const revision = state.latestRevision + 1
		const record: ApiRequestRoundRecord = {
			...terminal,
			revision,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			thoughtsTokens: usage.thoughtsTokens ?? 0,
			cacheWriteTokens: usage.cacheWriteTokens ?? 0,
			cacheReadTokens: usage.cacheReadTokens ?? 0,
			cacheUsageReported: usage.cacheUsageReported,
			...(usage.totalCost === undefined ? {} : { totalCost: usage.totalCost }),
			...(usage.currency === undefined ? {} : { currency: usage.currency }),
			usageQuality: "exact",
		}
		state.terminalRecord = record
		state.latestRevision = revision
		this.enqueue(record)
		this.options.onChanged?.()
		taskTraceSource(this.options.taskId)?.event("task.usage.updated", {
			api_index: handle.apiIndex,
			task_attempt: handle.taskAttempt,
			provider_attempt: handle.providerAttempt,
			usage_quality: "exact",
		})
	}

	getSnapshot(): ApiRequestRoundSnapshot {
		const currentRounds = [...this.rounds.values()]
			.map((state) => state.terminalRecord)
			.filter((record): record is ApiRequestRoundRecord => record !== undefined)
		const canonicalRounds = mergeCanonicalRounds(this.recoveredRounds, currentRounds)
		const rate = aggregateRoundUsage(canonicalRounds.slice(-RATE_ROUND_LIMIT))
		const cumulative = this.recoveredCumulative.degraded
			? undefined
			: mergeCumulativeUsage(this.recoveredCumulative, currentRounds)
		return {
			...(rate.requestsPerMinute === undefined ? {} : { requestsPerMinute: rate.requestsPerMinute }),
			rpmBasis: rate.rpmBasis,
			providerRoundCount: rate.providerRoundCount,
			...(cumulative?.inputTokens === undefined
				? {}
				: {
						totalTokensIn: cumulative.inputTokens,
						totalTokensOut: cumulative.outputTokens ?? 0,
						totalCacheWrites: cumulative.cacheWriteTokens ?? 0,
						totalCacheReads: cumulative.cacheReadTokens ?? 0,
					}),
			...(cumulative?.totalCost === undefined ? {} : { totalCost: cumulative.totalCost }),
			...(cumulative === undefined || cumulative.cacheDenominator <= 0
				? {}
				: { cacheHitRate: (cumulative.cacheNumerator / cumulative.cacheDenominator) * 100 }),
			cacheUsageAvailable: cumulative !== undefined && cumulative.cacheDenominator > 0,
			...(cumulative?.currency === undefined ? {} : { currency: cumulative.currency }),
		}
	}

	async waitForPersistence(): Promise<void> {
		await this.writeSequence
		await this.options.repository.waitForWrites()
	}

	async close(): Promise<void> {
		if (!this.closing) {
			this.closing = true
			for (const state of this.rounds.values()) {
				if (!state.terminalRecord) this.finishRound(toHandle(state), "aborted")
			}
		}
		await this.waitForPersistence()
		await this.options.repository.close()
	}

	private enqueue(record: ApiRequestRoundRecord): void {
		this.writeSequence = this.writeSequence.then(() => this.options.repository.append([record]))
	}

	private requireState(handle: ApiRequestRoundHandle): MutableRoundState {
		const state = this.rounds.get(handle.roundId)
		if (!state || !sameHandle(state, handle)) throw new Error("Unknown or mismatched API request round handle")
		return state
	}
}

function mergeCumulativeUsage(
	base: ApiRequestRoundCumulativeUsage,
	currentRounds: readonly ApiRequestRoundRecord[],
): ApiRequestRoundCumulativeUsage {
	let inputTokens = base.inputTokens
	let outputTokens = base.outputTokens
	let cacheWriteTokens = base.cacheWriteTokens
	let cacheReadTokens = base.cacheReadTokens
	let cacheNumerator = base.cacheNumerator
	let cacheDenominator = base.cacheDenominator
	let totalCost = base.totalCost
	let currency = base.currency
	let mixedCurrency = false
	for (const round of currentRounds) {
		if (round.usageQuality === "none" || round.inputTokens === undefined || round.outputTokens === undefined) continue
		inputTokens = (inputTokens ?? 0) + round.inputTokens
		outputTokens = (outputTokens ?? 0) + round.outputTokens
		cacheWriteTokens = (cacheWriteTokens ?? 0) + (round.cacheWriteTokens ?? 0)
		cacheReadTokens = (cacheReadTokens ?? 0) + (round.cacheReadTokens ?? 0)
		if (round.cacheUsageReported) {
			const denominator = round.inputTokens + (round.cacheWriteTokens ?? 0) + (round.cacheReadTokens ?? 0)
			if (denominator > 0) {
				cacheNumerator += round.cacheReadTokens ?? 0
				cacheDenominator += denominator
			}
		}
		if (round.totalCost !== undefined) totalCost = (totalCost ?? 0) + round.totalCost
		if (round.currency) {
			if (currency === undefined) currency = round.currency
			else if (currency !== round.currency) mixedCurrency = true
		}
	}
	return {
		degraded: false,
		...(inputTokens === undefined ? {} : { inputTokens }),
		...(outputTokens === undefined ? {} : { outputTokens }),
		...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
		...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
		cacheNumerator,
		cacheDenominator,
		...(totalCost === undefined ? {} : { totalCost }),
		...(currency === undefined || mixedCurrency ? {} : { currency }),
	}
}

function mergeCanonicalRounds(
	recoveredRounds: readonly ApiRequestRoundRecord[],
	currentRounds: readonly ApiRequestRoundRecord[],
): ApiRequestRoundRecord[] {
	const canonical = new Map<string, ApiRequestRoundRecord>()
	for (const round of [...recoveredRounds, ...currentRounds]) {
		const existing = canonical.get(round.roundId)
		if (!existing || round.revision > existing.revision) canonical.set(round.roundId, round)
	}
	return [...canonical.values()].sort(
		(left, right) => left.completedAtMs - right.completedAtMs || left.providerAttempt - right.providerAttempt,
	)
}

function toHandle(state: MutableRoundState): ApiRequestRoundHandle {
	return {
		roundId: state.roundId,
		logicalRequestId: state.logicalRequestId,
		apiIndex: state.apiIndex,
		taskAttempt: state.taskAttempt,
		providerAttempt: state.providerAttempt,
		startedAtMs: state.startedAtMs,
		startedMonotonicMs: state.startedMonotonicMs,
	}
}

function sameHandle(state: MutableRoundState, handle: ApiRequestRoundHandle): boolean {
	return (
		state.logicalRequestId === handle.logicalRequestId &&
		state.apiIndex === handle.apiIndex &&
		state.taskAttempt === handle.taskAttempt &&
		state.providerAttempt === handle.providerAttempt &&
		state.startedAtMs === handle.startedAtMs &&
		state.startedMonotonicMs === handle.startedMonotonicMs
	)
}

function assertIdentity(input: BeginApiRequestRound): void {
	if (!input.logicalRequestId) throw new Error("API request round logicalRequestId is required")
	for (const [name, value] of [
		["apiIndex", input.apiIndex],
		["taskAttempt", input.taskAttempt],
	] as const) {
		if (!Number.isSafeInteger(value) || value < 0) throw new Error(`API request round ${name} must be a non-negative integer`)
	}
}

function assertUsage(usage: ApiRequestRoundUsage): void {
	for (const [name, value] of [
		["inputTokens", usage.inputTokens],
		["outputTokens", usage.outputTokens],
		["thoughtsTokens", usage.thoughtsTokens],
		["cacheWriteTokens", usage.cacheWriteTokens],
		["cacheReadTokens", usage.cacheReadTokens],
	] as const) {
		if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
			throw new Error(`API request round ${name} must be a non-negative integer`)
		}
	}
	if (usage.totalCost !== undefined && (!Number.isFinite(usage.totalCost) || usage.totalCost < 0)) {
		throw new Error("API request round totalCost must be non-negative and finite")
	}
}

function readClock(clock: () => number, label: string): number {
	const value = clock()
	if (!Number.isFinite(value) || value < 0) throw new Error(`API request round ${label} must be non-negative and finite`)
	return value
}
