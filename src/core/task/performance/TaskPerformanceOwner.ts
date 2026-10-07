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
import { findExistingTaskMetricsDatabase } from "./task-metrics-database"
import { TaskRateMetricsQueryService } from "./task-rate-metrics-query-service"
import type { TaskRateMetricsQuery, TaskRateMetricsQueryResult } from "./task-rate-metrics-types"

export interface TaskPerformanceOwnerOptions {
	readonly taskId: string
	readonly readState: () => Readonly<TaskState>
	readonly legacyMessages: () => readonly UiMessage[]
	readonly onChanged?: () => void
	/** An explicit metrics database, used as is instead of the task's own layout. */
	readonly location?: string
}

/** Owns every task-local rate metric lifecycle and its durable repositories. */
export class TaskPerformanceOwner {
	readonly providerRequestRounds: ProviderRequestRoundPort
	/** The same owner as `providerRequestRounds`, with the ordinary-round lifecycle only this class drives. */
	private readonly rounds: TaskProviderRequestRoundOwner
	private readonly activeMetrics: TaskApiRateMetricsService
	private readonly roundLifecycle: ApiRequestRoundLifecycle
	private readonly queryService: TaskRateMetricsQueryService
	/** The logical round of each turn whose provider request is still open, keyed by turn. */
	private readonly ordinaryRounds = new Map<string, number>()
	private nextOrdinaryApiIndex = 0
	private closed = false

	private constructor(options: TaskPerformanceOwnerOptions) {
		const location = options.location
		const activeRepository = new TaskApiRateMetricsRepository({ taskId: options.taskId, location })
		const roundRepository = new TaskApiRequestRoundRepository({
			taskId: options.taskId,
			location,
			legacySource: { getAll: () => options.legacyMessages() },
		})
		const executionRepository = new TaskApiResponseExecutionRepository({ taskId: options.taskId, location })
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
		this.rounds = new TaskProviderRequestRoundOwner({
			lifecycle: this.roundLifecycle,
			readExecutionBlocks: (turnId) => {
				const turn = options.readState().turn
				return turn.turnId === turnId ? turn.blocks : []
			},
			isExecutionCancelling: () => options.readState().halt.status === "stopping",
		})
		this.providerRequestRounds = this.rounds
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

	/**
	 * Open the metrics a past run recorded, for a view that is not running the task.
	 *
	 * Resolves undefined when the task never recorded metrics, so viewing it
	 * creates no task directory and no empty database.
	 */
	static async openExisting(options: Omit<TaskPerformanceOwnerOptions, "location">): Promise<TaskPerformanceOwner | undefined> {
		const location = await findExistingTaskMetricsDatabase(options.taskId)
		return location ? TaskPerformanceOwner.open({ ...options, location }) : undefined
	}

	/**
	 * Follow the task loop through committed states.
	 *
	 * Active seconds accrue only while the loop runs, as dev's loop flag did,
	 * so a task waiting on the user or at rest stops adding to the rates.
	 */
	committed(state: Readonly<TaskState>): void {
		const loopActive = LOOP_ACTIVE_PHASES.has(state.flow.phase)
		this.activeMetrics.setTaskLoopActive(loopActive)
		this.completeSettledRounds(state.turn.turnId, loopActive)
	}

	/**
	 * Bind one attempt of a turn's provider request to the turn's logical round.
	 *
	 * Retries of a turn share its round, so the rates count one request however
	 * often it was sent, as dev's request rounds did.
	 */
	bindOrdinaryAttempt<T>(turnId: string, attempt: number, stream: AsyncIterable<T>): AsyncIterable<T> {
		let apiIndex = this.ordinaryRounds.get(turnId)
		if (apiIndex === undefined) {
			apiIndex = this.nextOrdinaryApiIndex++
			this.ordinaryRounds.set(turnId, apiIndex)
		}
		return this.rounds.admitOrdinary(apiIndex, attempt).bindAttempt(stream, attempt)
	}

	requestStarted(): void {
		this.activeMetrics.recordRequestStarted()
	}

	requestSettled(usage?: Readonly<Record<string, number>>, turnId?: string): void {
		this.activeMetrics.recordProviderRequestFinished()
		if (!usage) return
		const apiIndex = turnId === undefined ? undefined : this.ordinaryRounds.get(turnId)
		if (apiIndex !== undefined) {
			this.rounds.attachOrdinaryExactUsage(apiIndex, {
				inputTokens: finiteUsage(usage.inputTokens),
				outputTokens: finiteUsage(usage.outputTokens),
				thoughtsTokens: finiteUsage(usage.thoughtsTokenCount),
				cacheWriteTokens: finiteUsage(usage.cacheWriteTokens),
				cacheReadTokens: finiteUsage(usage.cacheReadTokens),
				// A provider that says nothing about its cache must not read as a cold one.
				cacheUsageReported: usage.cacheWriteTokens !== undefined || usage.cacheReadTokens !== undefined,
				totalCost: Number.isFinite(usage.totalCost) ? usage.totalCost : undefined,
			})
		}
		this.activeMetrics.recordExactUsage({
			inputTokens: finiteUsage(usage.inputTokens),
			outputTokens: finiteUsage(usage.outputTokens),
			cacheWriteTokens: finiteUsage(usage.cacheWriteTokens),
			cacheReadTokens: finiteUsage(usage.cacheReadTokens),
			thoughtsTokens: finiteUsage(usage.thoughtsTokenCount),
		})
	}

	/** A turn that stopped running ends its round; a cancelled one is dropped. */
	private completeSettledRounds(currentTurnId: string | undefined, loopActive: boolean): void {
		for (const [turnId, apiIndex] of this.ordinaryRounds) {
			if (loopActive && turnId === currentTurnId) continue
			this.rounds.completeTurn(this.rounds.getOrdinary(apiIndex))
			this.ordinaryRounds.delete(turnId)
		}
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

const LOOP_ACTIVE_PHASES: ReadonlySet<TaskState["flow"]["phase"]> = new Set(["initializing", "running"])

function finiteUsage(value: number | undefined): number {
	return Number.isFinite(value) && value !== undefined && value > 0 ? value : 0
}
