import { findExistingTaskMetricsDatabase } from "@core/storage/task-metrics-database"
import type { UiMessage } from "@shared/ExtensionMessage"
import type { ProviderAttemptObserver } from "@shared/provider-attempt-observer"
import type { ProviderAttemptScopeInput, ProviderAttemptUsageInput } from "@/services/telemetry/service/task-trace-context"
import type { TaskState } from "../kernel"
import type { ChecklistChange } from "../telemetry/ChecklistDiff"
import { toolCallOutcome, type UsageToolCall } from "../telemetry/UsageToolCalls"
import type { ApiRateSnapshot } from "./api-rate-tracker"
import { ApiRequestRoundLifecycle } from "./api-request-round-lifecycle"
import { TaskApiRequestRoundRepository } from "./api-request-round-repository"
import { ApiRequestRoundTracker } from "./api-request-round-tracker"
import { ApiResponseExecutionLifecycle } from "./api-response-execution-lifecycle"
import { TaskApiResponseExecutionRepository } from "./api-response-execution-repository"
import type { FinalizedProviderAttemptPort } from "./provider-request-round-port"
import { type ProviderExecutionBlock, TaskProviderRequestRoundOwner } from "./TaskProviderRequestRoundOwner"
import { TaskApiRateMetricsRepository } from "./task-api-rate-metrics-repository"
import { TaskApiRateMetricsService } from "./task-api-rate-metrics-service"
import { TaskRateMetricsQueryService } from "./task-rate-metrics-query-service"
import type { TaskRateMetricsQuery, TaskRateMetricsQueryResult } from "./task-rate-metrics-types"

export interface TaskPerformanceOwnerOptions {
    readonly taskId: string
    readonly readState: () => Readonly<TaskState>
    readonly legacyMessages: () => readonly UiMessage[]
    readonly onChanged?: () => void
    readonly finalizedAttempts?: FinalizedProviderAttemptPort
    /** Current allowed remote Usage generation, sampled once at each real Provider send admission. */
    readonly readUsagePolicyGeneration?: () => number | undefined
    readonly projectUsageModelId?: (provider: string, wireModelId: string) => string
    /** An explicit metrics database, used as is instead of the task's own layout. */
    readonly location?: string
    /**
     * Read what a past run recorded without writing: no legacy import, no wrapper
     * migration, no compaction, and a read-only database connection.
     */
    readonly readOnly?: boolean
    /**
     * Resolve the tool identity of one invocation reference.
     *
     * The kernel records the call, not its tool, so usage resolves the name from
     * the stored invocation. A missing resolver only costs the per-tool breakdown;
     * the outcome totals stay exact because the block itself is still counted.
     */
    readonly resolveInvocationToolName?: (invocationRef: string) => Promise<string | undefined>
}

/** Owns every task-local rate metric lifecycle and its durable repositories. */
export class TaskPerformanceOwner {
    private readonly rounds: TaskProviderRequestRoundOwner
    private readonly activeMetrics: TaskApiRateMetricsService
    private readonly roundLifecycle: ApiRequestRoundLifecycle
    private readonly queryService: TaskRateMetricsQueryService
    /** The logical round of each turn whose provider request is still open, keyed by turn. */
    private readonly ordinaryRounds = new Map<string, number>()
    /** Non-task ApiHandler invocations keyed by their stable semantic request identity. */
    private readonly auxiliaryAdmissions = new Map<string, ReturnType<TaskProviderRequestRoundOwner["admit"]>>()
    /** Turns whose canonical kernel blocks have been attached to their logical Provider request. */
    private readonly registeredExecutions = new Set<string>()
    /** Turns whose turn-ending interaction already terminalled the logical execution at the user boundary. */
    private readonly awaitingUserTerminals = new Set<string>()
    /** The turn whose request was bound last; its round is open until the run rests. */
    /** Tool identities of settled calls, resolved once per invocation for usage. */
    private readonly callToolNames = new Map<string, string | undefined>()
    /** Checklist changes observed since the last settlement, in the order they happened. */
    private checklistChanges: ChecklistChange[] = []
    private latestOrdinaryTurnId: string | undefined
    private nextOrdinaryApiIndex = 0
    private closed = false

    private readonly options: TaskPerformanceOwnerOptions

    private constructor(options: TaskPerformanceOwnerOptions) {
        this.options = options
        const { taskId, location } = options
        const readOnly = options.readOnly === true
        const activeRepository = new TaskApiRateMetricsRepository({ taskId, location, readOnly })
        const roundRepository = new TaskApiRequestRoundRepository({
            taskId,
            location,
            readOnly,
            ...(readOnly ? {} : { legacySource: { getAll: () => options.legacyMessages() } }),
        })
        const executionRepository = new TaskApiResponseExecutionRepository({ taskId, location, readOnly })
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
            options.finalizedAttempts,
        )
        this.rounds = new TaskProviderRequestRoundOwner({
            lifecycle: this.roundLifecycle,
            readExecutionBlocks: (turnId) => {
                const turn = options.readState().turn
                return turn.turnId === turnId ? turn.blocks : []
            },
            isExecutionCancelling: () => options.readState().halt.status === "stopping",
            resolveExecutionToolCalls: (blocks, awaitingBlockId) => this.toolCallsOfBlocks(blocks, awaitingBlockId),
            readPolicyGeneration: options.readUsagePolicyGeneration,
            projectUsageModelId: options.projectUsageModelId,
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

    /**
     * Open the metrics a past run recorded, for a view that is not running the task.
     *
     * Resolves undefined when the task never recorded metrics, so viewing it
     * creates no task directory and no empty database. The owner is read-only:
     * the view never imports, migrates or compacts the past run's metrics.
     */
    static async openExisting(
        options: Omit<TaskPerformanceOwnerOptions, "location" | "readOnly">,
    ): Promise<TaskPerformanceOwner | undefined> {
        const location = await findExistingTaskMetricsDatabase(options.taskId)
        return location ? TaskPerformanceOwner.open({ ...options, location, readOnly: true }) : undefined
    }

    /**
     * Follow the task loop through committed states.
     *
     * Active seconds accrue only while the loop runs, as dev's loop flag did,
     * so a task waiting on the user or at rest stops adding to the rates.
     *
     * A run at rest also ends its request round, even when the flow stays open
     * for the user's reply to a completion: dev completed the round once that
     * ask was durable, which is what gives the history its request rate.
     */
    committed(state: Readonly<TaskState>, runAtRest = false): void {
        const loopActive = LOOP_ACTIVE_PHASES.has(state.flow.phase)
        this.activeMetrics.setTaskLoopActive(loopActive)
        this.observeCommittedExecution(state)
        this.completeSettledRounds(state.turn.turnId, loopActive && !runAtRest)
    }

    /** Mandatory ApiHandler boundary: obtain the observer without exposing Usage policy or storage to the caller. */
    providerAttemptObserver(input: ProviderAttemptScopeInput): ProviderAttemptObserver {
        const admission =
            input.role === "task" && input.logicalRequestId
                ? this.ordinaryAdmission(input.logicalRequestId, input.taskAttempt)
                : this.auxiliaryAdmission(input)
        return admission.createAttemptObserver(input.taskAttempt, input.adapter)
    }

    private ordinaryAdmission(turnId: string, attempt: number): ReturnType<TaskProviderRequestRoundOwner["admitOrdinary"]> {
        this.latestOrdinaryTurnId = turnId
        let apiIndex = this.ordinaryRounds.get(turnId)
        if (apiIndex === undefined) {
            apiIndex = this.nextOrdinaryApiIndex++
            this.ordinaryRounds.set(turnId, apiIndex)
        }
        return this.rounds.admitOrdinary(apiIndex, attempt)
    }

    private auxiliaryAdmission(input: ProviderAttemptScopeInput): ReturnType<TaskProviderRequestRoundOwner["admit"]> {
        const key = input.logicalRequestId ? `${input.role}:${input.logicalRequestId}` : undefined
        const existing = key ? this.auxiliaryAdmissions.get(key) : undefined
        if (existing) return existing
        const admission = this.rounds.admit({ source: input.role })
        if (key) this.auxiliaryAdmissions.set(key, admission)
        return admission
    }

    /** Attach usage observed by the mandatory ApiHandler wrapper to its existing attempt admission. */
    providerAttemptUsage(input: ProviderAttemptUsageInput): void {
        if (input.role === "task" && input.logicalRequestId) {
            const apiIndex = this.ordinaryRounds.get(input.logicalRequestId)
            if (apiIndex !== undefined) this.rounds.attachOrdinaryExactUsage(apiIndex, input.usage)
            return
        }
        if (!input.logicalRequestId) return
        this.auxiliaryAdmissions.get(`${input.role}:${input.logicalRequestId}`)?.attachExactUsage(input.usage)
    }

    /** Complete an auxiliary logical request at the mandatory ApiHandler terminal boundary. */
    providerRequestCompleted(input: ProviderAttemptScopeInput): void {
        if (input.role === "task" || !input.logicalRequestId) return
        const key = `${input.role}:${input.logicalRequestId}`
        const admission = this.auxiliaryAdmissions.get(key)
        if (!admission) return
        admission.completeProviderOnly()
        this.auxiliaryAdmissions.delete(key)
    }

    /**
     * The tool calls of one settled turn, as usage reports them.
     *
     * The classification comes from the same rule the execution record uses, so
     * the per-tool counters can never contradict the outcomes the fact totals
     * already carry. A name that cannot be resolved keeps its settlement and is
     * reported as unlisted by the caller rather than being dropped.
     */
    /**
     * Record one observed checklist change for the next settlement.
     *
     * The turn that reported it is the turn it belongs to; a change that no
     * request settles is dropped with the counter reset rather than attributed to
     * an unrelated later request.
     */
    observeChecklist(changes: readonly ChecklistChange[]): void {
        if (changes.length === 0) return
        this.checklistChanges.push(...changes)
    }

    /** Take the changes this settlement owns, leaving the next one a clean start. */
    takeChecklistChanges(): readonly ChecklistChange[] | undefined {
        if (this.checklistChanges.length === 0) return undefined
        const changes = this.checklistChanges
        this.checklistChanges = []
        return changes
    }

    async settledToolCalls(turnId: string): Promise<readonly UsageToolCall[]> {
        const turn = this.options.readState().turn
        return turn.turnId === turnId ? this.toolCallsOfBlocks(turn.blocks) : []
    }

    private async toolCallsOfBlocks(
        blocks: readonly ProviderExecutionBlock[],
        awaitingBlockId?: string,
    ): Promise<readonly UsageToolCall[]> {
        const calls: UsageToolCall[] = []
        for (const block of blocks) {
            const toolName = block.invocationRef ? await this.toolNameOf(block.invocationRef) : undefined
            const outcome = toolCallOutcome(block.phase, block.blockId === awaitingBlockId)
            calls.push(toolName === undefined ? { outcome } : { outcome, toolName })
        }
        return calls
    }

    private async toolNameOf(invocationRef: string): Promise<string | undefined> {
        if (this.callToolNames.has(invocationRef)) return this.callToolNames.get(invocationRef)
        const resolver = this.options.resolveInvocationToolName
        if (!resolver) {
            this.callToolNames.set(invocationRef, undefined)
            return undefined
        }
        try {
            const toolName = await resolver(invocationRef)
            this.callToolNames.set(invocationRef, toolName)
            return toolName
        } catch {
            // A call that cannot be read is reported unlisted instead of failing the usage record.
            return undefined
        }
    }

    requestStarted(): void {
        this.activeMetrics.recordRequestStarted()
    }

    requestSettled(usage?: Readonly<Record<string, number>>): void {
        this.activeMetrics.recordProviderRequestFinished()
        if (!usage) return
        // TPM is a generation rate, so only generated output feeds it. Exact per-attempt
        // usage is attached by the mandatory ApiHandler observation boundary.
        this.activeMetrics.recordExactUsage({ outputTokens: finiteUsage(usage.outputTokens) })
    }

    /** Attach logical execution and tool terminal facts from the canonical committed Task state. */
    private observeCommittedExecution(state: Readonly<TaskState>): void {
        const turnId = state.turn.turnId
        if (!turnId) return
        const apiIndex = this.ordinaryRounds.get(turnId)
        if (apiIndex === undefined) return
        const admission = this.rounds.getOrdinary(apiIndex)
        if (!admission) return

        if (state.turn.blocks.length > 0 && !this.registeredExecutions.has(turnId)) {
            this.rounds.registerExecution(admission, {
                turnId,
                toolCount: state.turn.blocks.length,
                turnEndInteractions: state.turn.blocks
                    .filter((block) => block.turnEnding)
                    .map((block) => ({ interactionId: block.blockId, blockId: block.blockId })),
            })
            this.registeredExecutions.add(turnId)
        }

        const interaction = state.dialog.primary
        if (interaction?.turnId !== turnId || interaction.status !== "awaiting" || this.awaitingUserTerminals.has(turnId)) {
            return
        }
        const blockId = interaction.blockId ?? interaction.interactionId
        const terminalBlock = state.turn.blocks.find((block) => block.blockId === blockId && block.turnEnding)
        if (!terminalBlock) return
        this.rounds.completeAtAwaitingUser(turnId, terminalBlock.blockId)
        this.awaitingUserTerminals.add(turnId)
    }

    /**
     * A turn that stopped running ends its round; a cancelled one is dropped.
     *
     * While the run goes on, the turn the state names and the turn whose request
     * was sent last both stay open: the state only names a turn once its reply
     * is ready, so a request still streaming belongs to the latter.
     */
    private completeSettledRounds(currentTurnId: string | undefined, running: boolean): void {
        for (const [turnId, apiIndex] of this.ordinaryRounds) {
            if (running && (turnId === currentTurnId || turnId === this.latestOrdinaryTurnId)) continue
            this.rounds.completeTurn(this.rounds.getOrdinary(apiIndex))
            this.ordinaryRounds.delete(turnId)
            this.registeredExecutions.delete(turnId)
            this.awaitingUserTerminals.delete(turnId)
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
        this.auxiliaryAdmissions.clear()
        this.registeredExecutions.clear()
        this.awaitingUserTerminals.clear()
        await this.rounds.waitForCompletions()
        await Promise.allSettled([this.activeMetrics.dispose(), this.roundLifecycle.close()])
    }
}

const LOOP_ACTIVE_PHASES: ReadonlySet<TaskState["flow"]["phase"]> = new Set(["initializing", "running"])

function finiteUsage(value: number | undefined): number {
    return Number.isFinite(value) && value !== undefined && value > 0 ? value : 0
}
