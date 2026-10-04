import type { UiMessage } from "@shared/ExtensionMessage"
import type { TaskState } from "../kernel"
import type { ApiRateSnapshot } from "./api-rate-tracker"
import { ApiRequestRoundLifecycle } from "./api-request-round-lifecycle"
import { TaskApiRequestRoundRepository } from "./api-request-round-repository"
import { ApiRequestRoundTracker } from "./api-request-round-tracker"
import { ApiResponseExecutionLifecycle } from "./api-response-execution-lifecycle"
import { TaskApiResponseExecutionRepository } from "./api-response-execution-repository"
import type { ProviderRequestRoundPort } from "./provider-request-round-port"
import { TaskProviderRequestRoundOwner } from "./TaskProviderRequestRoundOwner"
import { TaskApiRateMetricsRepository } from "./task-api-rate-metrics-repository"
import { TaskApiRateMetricsService } from "./task-api-rate-metrics-service"
import { TaskRateMetricsQueryService } from "./task-rate-metrics-query-service"
import type { TaskRateMetricsQuery, TaskRateMetricsQueryResult } from "./task-rate-metrics-types"

export interface TaskPerformanceOwnerOptions {
	readonly taskId: string
	readonly readState: () => Readonly<TaskState>
	readonly legacyMessages: () => readonly UiMessage[]
	readonly onChanged?: () => void
}

/** Owns every task-local rate metric lifecycle and its durable repositories. */
export class TaskPerformanceOwner {
	readonly providerRequestRounds: ProviderRequestRoundPort
	private readonly activeMetrics: TaskApiRateMetricsService
	private readonly roundLifecycle: ApiRequestRoundLifecycle
	private readonly queryService: TaskRateMetricsQueryService
	private closed = false

	private constructor(options: TaskPerformanceOwnerOptions) {
		const activeRepository = new TaskApiRateMetricsRepository({ taskId: options.taskId })
		const roundRepository = new TaskApiRequestRoundRepository({
			taskId: options.taskId,
			legacySource: { getAll: () => options.legacyMessages() },
		})
		const executionRepository = new TaskApiResponseExecutionRepository({ taskId: options.taskId })
		this.activeMetrics = new TaskApiRateMetricsService({
			repository: activeRepository,
			taskId: options.taskId,
			onChanged: options.onChanged,
		})
		const executions = new ApiResponseExecutionLifecycle({
			taskId: options.taskId,
			repository: executionRepository,
			onChanged: options.onChanged,
		})
		this.roundLifecycle = new ApiRequestRoundLifecycle(
			new ApiRequestRoundTracker({ taskId: options.taskId, repository: roundRepository, onChanged: options.onChanged }),
			executions,
		)
		this.providerRequestRounds = new TaskProviderRequestRoundOwner({
			lifecycle: this.roundLifecycle,
			readExecutionBlocks: (turnId) => {
				const turn = options.readState().turn
				return turn.turnId === turnId ? turn.blocks : []
			},
			isExecutionCancelling: () => options.readState().halt.status === "stopping",
		})
		this.queryService = new TaskRateMetricsQueryService({
			activeMetrics: this.activeMetrics,
			roundRepository,
			executionRepository,
			waitForRoundPersistence: () => this.roundLifecycle.waitForRoundPersistence(),
			waitForExecutionPersistence: () => this.roundLifecycle.waitForExecutionPersistence(),
			isExecutionDegraded: () => this.roundLifecycle.getExecutionSnapshot().degraded,
			taskId: options.taskId,
		})
	}

	static async open(options: TaskPerformanceOwnerOptions): Promise<TaskPerformanceOwner> {
		const owner = new TaskPerformanceOwner(options)
		try {
			await Promise.all([owner.activeMetrics.initialize(), owner.roundLifecycle.initialize()])
			return owner
		} catch (error) {
			await owner.release().catch(() => undefined)
			throw error
		}
	}

	requestStarted(): void {
		this.activeMetrics.recordRequestStarted()
	}

	requestSettled(usage?: Readonly<Record<string, number>>): void {
		this.activeMetrics.recordProviderRequestFinished()
		if (!usage) return
		this.activeMetrics.recordExactUsage({
			inputTokens: finiteUsage(usage.inputTokens),
			outputTokens: finiteUsage(usage.outputTokens),
			cacheWriteTokens: finiteUsage(usage.cacheWriteTokens),
			cacheReadTokens: finiteUsage(usage.cacheReadTokens),
			thoughtsTokens: finiteUsage(usage.thoughtsTokenCount),
		})
	}

	getSnapshot(): ApiRateSnapshot {
		const active = this.activeMetrics.getSnapshot()
		const provider = this.roundLifecycle.getSnapshot()
		const execution = this.roundLifecycle.getExecutionSnapshot()
		return {
			...active,
			...provider,
			...execution,
			requestsPerMinute: execution.requestsPerMinute ?? provider.requestsPerMinute ?? active.requestsPerMinute,
			rpmBasis:
				execution.rpmBasis !== "unavailable"
					? execution.rpmBasis
					: provider.rpmBasis !== "unavailable"
						? provider.rpmBasis
						: active.requestsPerMinute === undefined
							? "unavailable"
							: "legacy_active_seconds",
		}
	}

	query(query: TaskRateMetricsQuery): Promise<TaskRateMetricsQueryResult> {
		return this.queryService.query(query)
	}

	async release(): Promise<void> {
		if (this.closed) return
		this.closed = true
		await Promise.allSettled([this.activeMetrics.dispose(), this.roundLifecycle.close()])
	}
}

function finiteUsage(value: number | undefined): number {
	return Number.isFinite(value) && value !== undefined && value > 0 ? value : 0
}
