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
	readonly messagesComplete?: () => boolean
	/** Indexed compatibility totals until the canonical persisted summary is read. */
	readonly historicalUsage?: Readonly<ApiMetrics>
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
	private rates!: TaskApiRateMetricsService
	private rounds!: ApiRequestRoundLifecycle
	private queries!: TaskRateMetricsQueryService
	private readOnly: boolean
	private recordingAdmission?: Promise<void>
	private initialization?: Promise<void>
	private closePromise?: Promise<void>
	private snapshot?: Readonly<ApiRateSnapshot>
	private readonly pendingReads = new Set<Promise<unknown>>()
	private readonly legacyUsage = new LegacyMessageUsageReader()
	private usageRepository!: TaskUsageSummaryRepository
	private usage?: ApiMetrics
	private summaryLoaded = false
	private pendingUsage?: ApiMetrics
	private usageWrites: Promise<void> = Promise.resolve()
	private predecessor?: Promise<void>

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
		this.readOnly = options.readOnly === true
		if (!this.readOnly) this.claimRecordingOwnership()
		this.createResources()
		// Consumers retain these facades across read-only admission into execution.
		this.recorder = {
			rates: {
				recordEstimatedTokens: (...args) => this.rates.recordEstimatedTokens(...args),
				recordExactUsage: (...args) => this.rates.recordExactUsage(...args),
				setTaskLoopActive: (...args) => this.rates.setTaskLoopActive(...args),
				trackProviderStream: (...args) => this.rates.trackProviderStream(...args),
				getSnapshot: () => this.rates.getSnapshot(),
			},
			rounds: {
				createObserver: (...args) => this.rounds.createObserver(...args),
				attachExactUsage: (...args) => this.rounds.attachExactUsage(...args),
				completeProviderOnly: (...args) => this.rounds.completeProviderOnly(...args),
				completeTools: (...args) => this.rounds.completeTools(...args),
				completeTurnEndAwaitingUser: (...args) => this.rounds.completeTurnEndAwaitingUser(...args),
				abortOpenExecutions: (...args) => this.rounds.abortOpenExecutions(...args),
			},
		}
		this.reader = {
			readStateMetrics: (messages, revision) => this.readUsageMetrics(messages, revision, false),
			readHistoryMetrics: (messages, revision) => this.readUsageMetrics(messages, revision, true),
			getSnapshot: () => this.getSnapshot(),
			readUsageSummary: () => this.readSummary(),
			query: (query) => this.read(() => this.queries.query(query)),
		}
	}

	private claimRecordingOwnership(): void {
		const key = ownerKey(this.options.taskId)
		const previous = liveOwners.get(key)
		if (previous && previous !== this && !previous.closePromise) throw new Error("Task metrics already has a live owner")
		this.predecessor = previous?.closePromise
		liveOwners.set(key, this)
	}

	private createResources(): void {
		const options = this.options
		this.usageRepository = new TaskUsageSummaryRepository(options.taskId, this.readOnly)
		const onChanged = () => {
			this.snapshot = undefined
			options.onChanged?.()
		}
		this.rates = new TaskApiRateMetricsService({
			taskId: options.taskId,
			repository: new TaskApiRateMetricsRepository({ taskId: options.taskId, readOnly: this.readOnly }),
			onChanged,
		})
		const roundRepository = new TaskApiRequestRoundRepository({
			taskId: options.taskId,
			readOnly: this.readOnly,
			...(options.legacySource ? { legacySource: options.legacySource } : {}),
		})
		const executionRepository = new TaskApiResponseExecutionRepository({ taskId: options.taskId, readOnly: this.readOnly })
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
	}

	/** Admit recording on this owner only after the Task has obtained execution permission. */
	enableRecording(): Promise<void> {
		if (this.closePromise) return Promise.reject(new Error("Task metrics owner is closed"))
		if (!this.readOnly) return Promise.resolve()
		if (this.recordingAdmission) return this.recordingAdmission
		const reads = [...this.pendingReads]
		const admission = (async () => {
			await this.initialization?.catch(() => undefined)
			await Promise.allSettled(reads)
			await this.closeResources()
			if (this.closePromise) throw new Error("Task metrics owner is closed")
			this.claimRecordingOwnership()
			this.readOnly = false
			this.initialization = undefined
			this.snapshot = undefined
			this.createResources()
		})().catch((error) => {
			if (this.recordingAdmission === admission) this.recordingAdmission = undefined
			throw error
		})
		this.recordingAdmission = admission
		return admission
	}

	initialize(): Promise<void> {
		if (this.closePromise) return Promise.reject(new Error("Task metrics owner is closed"))
		return this.recordingAdmission
			? this.recordingAdmission.then(() => this.initializeResources())
			: this.initializeResources()
	}

	private initializeResources(): Promise<void> {
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
			await this.recordingAdmission?.catch(() => undefined)
			await this.initialization?.catch(() => undefined)
			await Promise.allSettled([...this.pendingReads])
			await this.usageWrites
			await this.closeResources()
		})().finally(() => {
			if (liveOwners.get(key) === this) liveOwners.delete(key)
		})
		return this.closePromise
	}

	private async closeResources(): Promise<void> {
		const results = await Promise.allSettled([this.rates.dispose(), this.rounds.close(), this.usageRepository.close()])
		const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
		if (failure) throw failure.reason
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
		if (this.options.messagesComplete?.() === false) {
			return this.usage ?? this.options.historicalUsage ?? { totalTokensIn: 0, totalTokensOut: 0, totalCost: 0 }
		}
		const metrics = history
			? this.legacyUsage.readHistoryMetrics(messages, revision)
			: this.legacyUsage.readStateMetrics(messages, revision)
		if (!history && !sameUsage(this.usage, metrics)) {
			this.usage = metrics
			this.snapshot = undefined
			if (!this.readOnly && !this.closePromise) {
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
				if (!this.usage && persisted) {
					this.usage = persisted
					this.snapshot = undefined
				}
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
