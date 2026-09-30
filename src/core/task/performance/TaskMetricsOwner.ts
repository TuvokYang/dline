import path from "node:path"
import { getDlineDocumentsPathSync } from "@core/storage/documents-path"
import type { ClineMessage } from "@shared/ExtensionMessage"
import type { ApiMetrics } from "@shared/getApiMetrics"
import { Logger } from "@shared/services/Logger"
import type { ApiRateMetricsQuery, ApiRateMetricsQueryResult } from "./api-rate-metrics-types"
import type { ApiRateSnapshot } from "./api-rate-tracker"
import type { LegacyUiMessageSource } from "./api-request-round-legacy-usage-parser"
import { ApiRequestRoundLifecycle } from "./api-request-round-lifecycle"
import { TaskApiRequestRoundRepository } from "./api-request-round-repository"
import { ApiRequestRoundTracker } from "./api-request-round-tracker"
import { ApiResponseExecutionLifecycle } from "./api-response-execution-lifecycle"
import { TaskApiResponseExecutionRepository } from "./api-response-execution-repository"
import { TaskApiRateMetricsRepository } from "./task-api-rate-metrics-repository"
import { TaskApiRateMetricsService } from "./task-api-rate-metrics-service"
import { TaskRateMetricsQueryService } from "./task-rate-metrics-query-service"
import type { TaskRateMetricsQuery, TaskRateMetricsQueryResult } from "./task-rate-metrics-types"
import { LegacyMessageUsageReader, type TaskUsageMessages, type TaskUsageReader } from "./task-usage-reader"
import { TaskUsageSummaryRepository } from "./task-usage-summary-repository"

export interface TaskMetricsReader extends TaskUsageReader {
	getSnapshot(): Readonly<ApiRateSnapshot>
	readUsageSummary(): Promise<Readonly<ApiMetrics> | undefined>
	query(query: TaskRateMetricsQuery): Promise<TaskRateMetricsQueryResult>
}

export interface TaskMetricsOwnerOptions {
	readonly taskId: string
	readonly legacySource?: LegacyUiMessageSource
	readonly onChanged?: () => void
	readonly readOnly?: boolean
}

const liveOwners = new Map<string, TaskMetricsOwner>()

/** Owns one Task's metrics resources; read consumers never receive repositories or lifetime methods. */
export class TaskMetricsOwner {
	/** Scoped TaskHistory consumption; a cold read never creates a writer or imports history. */
	static async readUsage(taskId: string, legacyMessages?: readonly ClineMessage[]): Promise<Readonly<ApiMetrics> | undefined> {
		const owner = liveOwners.get(ownerKey(taskId))
		if (owner && !owner.closePromise) {
			const usage = await owner.readSummary()
			if (usage) return usage
		}
		await owner?.closePromise
		const repository = new TaskUsageSummaryRepository(taskId, true)
		try {
			const persisted = await repository.read().catch(() => undefined)
			if (persisted) return persisted
			if (legacyMessages) return new LegacyMessageUsageReader().readStateMetrics(() => [...legacyMessages], 0)
			return undefined
		} finally {
			await repository.close()
		}
	}
	private readonly rates: TaskApiRateMetricsService
	private readonly rounds: ApiRequestRoundLifecycle
	private readonly queries: TaskRateMetricsQueryService
	private initialization?: Promise<void>
	private closePromise?: Promise<void>
	private snapshot?: Readonly<ApiRateSnapshot>
	private readonly pendingReads = new Set<Promise<unknown>>()
	private readonly legacyUsage = new LegacyMessageUsageReader()
	private readonly usageRepository: TaskUsageSummaryRepository
	private usage?: ApiMetrics
	private summaryLoaded = false
	private pendingUsage?: ApiMetrics
	private usageWrites: Promise<void> = Promise.resolve()
	private readonly predecessor?: Promise<void>

	readonly reader: TaskMetricsReader
	readonly recorder: {
		readonly rates: Pick<
			TaskApiRateMetricsService,
			"recordEstimatedTokens" | "recordExactUsage" | "setTaskLoopActive" | "trackProviderStream" | "getSnapshot"
		>
		readonly rounds: Pick<
			ApiRequestRoundLifecycle,
			| "createObserver"
			| "attachExactUsage"
			| "completeProviderOnly"
			| "completeTools"
			| "completeTurnEndAwaitingUser"
			| "abortOpenExecutions"
		>
	}

	constructor(private readonly options: TaskMetricsOwnerOptions) {
		this.usageRepository = new TaskUsageSummaryRepository(options.taskId, options.readOnly)
		if (!options.readOnly) {
			const key = ownerKey(options.taskId)
			const previous = liveOwners.get(key)
			if (previous && !previous.closePromise) throw new Error("Task metrics already has a live owner")
			this.predecessor = previous?.closePromise
			liveOwners.set(key, this)
		}
		const onChanged = () => {
			this.snapshot = undefined
			options.onChanged?.()
		}
		this.rates = new TaskApiRateMetricsService({
			taskId: options.taskId,
			repository: new TaskApiRateMetricsRepository({ taskId: options.taskId, readOnly: options.readOnly }),
			onChanged,
		})
		const roundRepository = new TaskApiRequestRoundRepository({
			taskId: options.taskId,
			readOnly: options.readOnly,
			...(options.legacySource ? { legacySource: options.legacySource } : {}),
		})
		const executionRepository = new TaskApiResponseExecutionRepository({ taskId: options.taskId, readOnly: options.readOnly })
		this.rounds = new ApiRequestRoundLifecycle(
			new ApiRequestRoundTracker({ taskId: options.taskId, repository: roundRepository, onChanged }),
			new ApiResponseExecutionLifecycle({ taskId: options.taskId, repository: executionRepository, onChanged }),
		)
		this.queries = new TaskRateMetricsQueryService({
			taskId: options.taskId,
			activeMetrics: this.rates,
			roundRepository,
			executionRepository,
			waitForRoundPersistence: () => this.rounds.waitForRoundPersistence(),
			waitForExecutionPersistence: () => this.rounds.waitForExecutionPersistence(),
			isExecutionDegraded: () => this.rounds.getExecutionSnapshot().degraded,
		})
		this.recorder = { rates: this.rates, rounds: this.rounds }
		this.reader = {
			readStateMetrics: (messages, revision) => this.readUsageMetrics(messages, revision, false),
			readHistoryMetrics: (messages, revision) => this.readUsageMetrics(messages, revision, true),
			getSnapshot: () => this.getSnapshot(),
			readUsageSummary: () => this.readSummary(),
			query: (query) => this.read(() => this.queries.query(query)),
		}
	}

	initialize(): Promise<void> {
		if (this.closePromise) return Promise.reject(new Error("Task metrics owner is closed"))
		this.initialization ??= Promise.resolve(this.predecessor)
			.then(() =>
				Promise.all([
					this.rates.initialize(),
					this.rounds.initializeRounds().catch((error) => {
						Logger.warn(`[Task ${this.options.taskId}] Failed to recover API request round metrics`, error)
					}),
					this.rounds.initializeExecutions().catch((error) => {
						Logger.warn(`[Task ${this.options.taskId}] Failed to recover API response execution metrics`, error)
					}),
				]),
			)
			.then(() => {
				this.snapshot = undefined
				this.options.onChanged?.()
			})
		return this.initialization
	}

	queryApiRates(query: ApiRateMetricsQuery): Promise<ApiRateMetricsQueryResult> {
		return this.read(() => this.rates.query(query))
	}

	close(): Promise<void> {
		const key = ownerKey(this.options.taskId)
		this.closePromise ??= (async () => {
			await this.initialization?.catch(() => undefined)
			await Promise.allSettled([...this.pendingReads])
			await this.usageWrites
			const results = await Promise.allSettled([this.rates.dispose(), this.rounds.close(), this.usageRepository.close()])
			const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
			if (failure) throw failure.reason
		})().finally(() => {
			if (liveOwners.get(key) === this) liveOwners.delete(key)
		})
		return this.closePromise
	}

	private read<T>(operation: () => Promise<T>): Promise<T> {
		const pending = this.initialize().then(operation)
		this.pendingReads.add(pending)
		void pending.then(
			() => this.pendingReads.delete(pending),
			() => this.pendingReads.delete(pending),
		)
		return pending
	}

	private readUsageMetrics(messages: TaskUsageMessages, revision: number, history: boolean): ApiMetrics {
		const metrics = history
			? this.legacyUsage.readHistoryMetrics(messages, revision)
			: this.legacyUsage.readStateMetrics(messages, revision)
		if (!history && !sameUsage(this.usage, metrics)) {
			this.usage = metrics
			this.snapshot = undefined
			if (!this.options.readOnly && !this.closePromise) {
				this.pendingUsage = metrics
				this.usageWrites = this.usageWrites
					.then(async () => {
						await this.predecessor
						const pending = this.pendingUsage
						this.pendingUsage = undefined
						if (pending) await this.usageRepository.write(pending)
					})
					.catch((error) => Logger.warn(`[Task ${this.options.taskId}] Failed to persist Task usage summary`, error))
			}
		}
		return metrics
	}

	private readSummary(): Promise<Readonly<ApiMetrics> | undefined> {
		if (this.closePromise) return Promise.reject(new Error("Task metrics owner is closed"))
		const pending = (async () => {
			if (this.usage) return this.usage
			if (!this.summaryLoaded) {
				const repository = new TaskUsageSummaryRepository(this.options.taskId, true)
				let persisted: ApiMetrics | undefined
				try {
					persisted = await repository.read().catch(() => undefined)
				} finally {
					await repository.close()
				}
				// A live message projection may have arrived while the database was opening.
				this.usage ??= persisted
				this.summaryLoaded = true
			}
			return this.usage
		})()
		this.pendingReads.add(pending)
		void pending.then(
			() => this.pendingReads.delete(pending),
			() => this.pendingReads.delete(pending),
		)
		return pending
	}

	private getSnapshot(): Readonly<ApiRateSnapshot> {
		if (this.snapshot) return this.snapshot
		const active = this.rates.getSnapshot()
		const rounds = this.rounds.getSnapshot()
		const executions = this.rounds.getExecutionSnapshot()
		this.snapshot = Object.freeze({
			...(active.activeSeconds === undefined ? {} : { activeSeconds: active.activeSeconds }),
			...(active.tokensPerMinute === undefined ? {} : { tokensPerMinute: active.tokensPerMinute }),
			...(executions.requestsPerMinute === undefined ? {} : { requestsPerMinute: executions.requestsPerMinute }),
			rpmBasis: executions.rpmBasis,
			executionCount: executions.executionCount,
			...(executions.executionDurationMs === undefined ? {} : { executionDurationMs: executions.executionDurationMs }),
			providerRoundCount: rounds.providerRoundCount,
			...(rounds.totalTokensIn === undefined ? {} : { totalTokensIn: rounds.totalTokensIn }),
			...(rounds.totalTokensOut === undefined ? {} : { totalTokensOut: rounds.totalTokensOut }),
			...(rounds.totalCacheWrites === undefined ? {} : { totalCacheWrites: rounds.totalCacheWrites }),
			...(rounds.totalCacheReads === undefined ? {} : { totalCacheReads: rounds.totalCacheReads }),
			...(rounds.totalCost === undefined ? {} : { totalCost: rounds.totalCost }),
			...(rounds.cacheHitRate === undefined ? {} : { cacheHitRate: rounds.cacheHitRate }),
			cacheUsageAvailable: rounds.cacheUsageAvailable,
			...(rounds.currency === undefined ? {} : { currency: rounds.currency }),
			...(this.usage
				? {
						totalTokensIn: this.usage.totalTokensIn,
						totalTokensOut: this.usage.totalTokensOut,
						totalCacheWrites: this.usage.totalCacheWrites,
						totalCacheReads: this.usage.totalCacheReads,
						totalCost: this.usage.totalCost,
						cacheHitRate: this.usage.cacheHitRate,
						currency: this.usage.currency,
					}
				: {}),
		})
		return this.snapshot
	}
}

function ownerKey(taskId: string): string {
	const key = path.resolve(getDlineDocumentsPathSync(), "tasks", taskId)
	return process.platform === "win32" ? key.toLowerCase() : key
}

function sameUsage(left: ApiMetrics | undefined, right: ApiMetrics): boolean {
	return (
		left !== undefined &&
		Object.is(left.totalTokensIn, right.totalTokensIn) &&
		Object.is(left.totalTokensOut, right.totalTokensOut) &&
		Object.is(left.totalCacheWrites, right.totalCacheWrites) &&
		Object.is(left.totalCacheReads, right.totalCacheReads) &&
		Object.is(left.totalCost, right.totalCost) &&
		Object.is(left.cacheHitRate, right.cacheHitRate) &&
		left.currency === right.currency
	)
}
