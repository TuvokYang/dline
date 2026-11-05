import { registerTaskMetricsWriter } from "@core/metrics/MetricsDeletionGuard"
import type { MetricsQueryService } from "@core/metrics/MetricsQueryService"
import type { MetricsScope } from "@core/metrics/MetricsScope"
import { findExistingTaskMetricsDatabase } from "@core/storage/task-metrics-database"
import type { UiMessage } from "@shared/ExtensionMessage"
import {
    executionPerformanceEventId,
    providerPerformanceEventId,
    usageEventId,
    usageKeyFingerprint,
} from "@shared/metrics/identity"
import type { ProviderAttemptObserver } from "@shared/provider-attempt-observer"
import type { ProviderAttemptScopeInput, ProviderAttemptUsageInput } from "@/services/telemetry/service/task-trace-context"
import type { TaskState } from "../kernel"
import type { ChecklistChange } from "../telemetry/ChecklistDiff"
import { toolCallOutcome, type UsageToolCall } from "../telemetry/UsageToolCalls"
import type { ApiRateSnapshot } from "./api-rate-tracker"
import { ApiRequestRoundLifecycle } from "./api-request-round-lifecycle"
import { TaskApiRequestRoundRepository } from "./api-request-round-repository"
import { ApiRequestRoundTracker } from "./api-request-round-tracker"
import type { ApiRequestRoundRecord } from "./api-request-round-types"
import { ApiResponseExecutionLifecycle } from "./api-response-execution-lifecycle"
import { TaskApiResponseExecutionRepository } from "./api-response-execution-repository"
import type { MetricsEmitTarget, TaskMetricsAttachment } from "./metrics-emitter"
import type { ProviderAttemptUsagePort, ProviderRequestRoundAdmission } from "./provider-request-round-port"
import { type ProviderExecutionBlock, TaskProviderRequestRoundOwner } from "./TaskProviderRequestRoundOwner"
import { TaskApiRateMetricsRepository } from "./task-api-rate-metrics-repository"
import { TaskApiRateMetricsService } from "./task-api-rate-metrics-service"
import { TaskRateMetricsQueryService } from "./task-rate-metrics-query-service"
import type { TaskRateMetricsQuery, TaskRateMetricsQueryResult } from "./task-rate-metrics-types"

/**
 * A settled summary for a caller that ran its tools and found none.
 *
 * It is the explicit deferral release: unlike `completeProviderOnly`, it ends the
 * request through the tools-settled terminal, which is the only path that may
 * close a request that declared `expectTools`.
 */
const NO_TOOL_CALLS = {
    toolCount: 0,
    completedToolCount: 0,
    failedToolCount: 0,
    cancelledToolCount: 0,
} as const

/** Who served one admitted send, when it differs from the Task's opening identity. */
export interface ServingMetricsIdentity {
    readonly profileId: string
    readonly providerId?: string
    readonly modelId?: string
    readonly apiKey?: string
}

/**
 * Turns an already settled round into unified metrics events.
 *
 * The round record *is* the canonical fact: its tokens, cost and duration were
 * decided by the existing usage path, so this adapter only re-expresses them. It
 * never measures a duration again and never re-decides whether usage was reported,
 * because a second opinion would let the unified numbers disagree with the round.
 */
export class TaskMetricsEmission {
    private readonly reportedUsage = new Set<string>()
    private readonly reportedProvider = new Set<string>()
    private readonly reportedExecution = new Set<string>()

    constructor(
        private readonly attachment: TaskMetricsAttachment,
        private readonly taskId: string,
    ) {}

    /** Emit the usage of one settled round that reported exact tokens. */
    usage(record: ApiRequestRoundRecord, target?: MetricsEmitTarget): void {
        if (record.usageQuality !== "exact" || record.inputTokens === undefined || record.outputTokens === undefined) return
        const eventId = usageEventId(record.roundId)
        if (this.reportedUsage.has(eventId)) return
        this.reportedUsage.add(eventId)
        this.attachment.emitter.emitUsage(
            {
                eventId,
                observedAtMs: record.completedAtMs,
                roundId: record.roundId,
                logicalRequestId: record.logicalRequestId,
                sequence: record.revision,
                inputTokens: record.inputTokens,
                outputTokens: record.outputTokens,
                ...(record.thoughtsTokens === undefined ? {} : { thoughtsTokens: record.thoughtsTokens }),
                // Cache segments are only emitted when the Provider reported cache usage.
                // The round stores `0` for an unreported segment, so forwarding that `0`
                // would make "no cache" indistinguishable from "cache reported as zero" and
                // widen the hit-rate denominator with a context the source never counted.
                ...(record.cacheUsageReported && record.cacheWriteTokens !== undefined
                    ? { cacheWriteTokens: record.cacheWriteTokens }
                    : {}),
                ...(record.cacheUsageReported && record.cacheReadTokens !== undefined
                    ? { cacheReadTokens: record.cacheReadTokens }
                    : {}),
                // Reaching here already required exact tokens, so usage *was* reported.
                // `cacheUsageReported` only says whether the cache breakdown came with it;
                // using it as the usage flag dropped every exact request that omitted cache
                // detail, and `accumulateUsage` then skipped the tokens entirely.
                usageReported: true,
                ...(record.totalCost === undefined ? {} : { cost: record.totalCost }),
                ...(record.currency === undefined ? {} : { currency: record.currency }),
                // The round stores one amount per settled send; a missing amount is unknown,
                // not zero, and a mixed currency is already recorded as such by the source.
                costComplete: record.totalCost !== undefined && record.currency !== undefined,
                currencyMixed: false,
                usageQuality: "exact",
            },
            target,
        )
        void this.taskId
    }

    /** Emit the terminal performance fact of one Provider attempt. */
    provider(record: ApiRequestRoundRecord, target?: MetricsEmitTarget): void {
        const eventId = providerPerformanceEventId(record.roundId)
        if (this.reportedProvider.has(eventId)) return
        this.reportedProvider.add(eventId)
        this.attachment.emitter.emitPerformance(
            {
                eventId,
                observedAtMs: record.completedAtMs,
                roundId: record.roundId,
                logicalRequestId: record.logicalRequestId,
                sequence: record.revision,
                factKind: "provider",
                ...(record.providerDurationMs === undefined ? {} : { providerDurationMs: record.providerDurationMs }),
                status: record.status,
                perfQuality: "exact",
            },
            target,
        )
    }

    /** Emit the logical execution fact, which is what the request rate is divided by. */
    execution(
        input: {
            readonly executionId: string
            readonly roundId: string
            readonly logicalRequestId: string
            readonly observedAtMs: number
            readonly durationMs: number
            readonly status: "completed" | "failed" | "cancelled" | "aborted"
        },
        target?: MetricsEmitTarget,
    ): void {
        const eventId = executionPerformanceEventId(input.executionId)
        if (this.reportedExecution.has(eventId)) return
        this.reportedExecution.add(eventId)
        this.attachment.emitter.emitPerformance(
            {
                eventId,
                observedAtMs: input.observedAtMs,
                roundId: input.roundId,
                logicalRequestId: input.logicalRequestId,
                sequence: 0,
                factKind: "execution",
                executionId: input.executionId,
                executionDurationMs: input.durationMs,
                status: input.status,
                perfQuality: "exact",
            },
            target,
        )
    }
}

export interface TaskPerformanceOwnerOptions {
    readonly taskId: string
    readonly readState: () => Readonly<TaskState>
    /**
     * Optional unified metrics write path for this Task.
     *
     * A Task opened without one keeps working and records nothing; metrics are never a
     * precondition for a task's business behaviour.
     */
    readonly metrics?: TaskMetricsAttachment
    /**
     * Where this Task's committed unified numbers can be read.
     *
     * Reads are optional for the same reason writes are: a Task opened before the
     * metrics reader is wired still runs, it just cannot show unified numbers.
     */
    readonly metricsQuery?: MetricsQueryService
    readonly metricsScope?: MetricsScope
    readonly legacyMessages: () => readonly UiMessage[]
    readonly onChanged?: () => void
    /** Ordered Provider attempt facts for remote Usage; the port owns token finalization. */
    readonly attemptUsage?: ProviderAttemptUsagePort
    /** Current allowed remote Usage generation, sampled once at each real Provider send admission. */
    readonly readUsagePolicyGeneration?: () => number | undefined
    /**
     * The Profile an admitted send is actually served under.
     *
     * Read once per admission, not once per Task opening: a Profile switch replaces the
     * handler for the next request, so a number emitted later must name the Profile that
     * spent the tokens rather than whichever one the Task opened with. Returning
     * `undefined` keeps the opening identity, which is right for an assembly that never
     * switches Profiles and for a Task opened before this port was wired.
     */
    readonly readServingIdentity?: () => ServingMetricsIdentity | undefined
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
    private readonly tracker: ApiRequestRoundTracker
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
    /** Unified metrics write path, when the caller supplied one. */
    private metrics: TaskMetricsAttachment | undefined
    /** Re-expresses settled rounds as neutral events; absent when no writer was supplied. */
    private emission: TaskMetricsEmission | undefined
    /** Set when the metrics writer could not be released; a deletion must then refuse. */
    private metricsReleaseFailure: string | undefined
    /** Deregisters this owner from the deletion guard; set once the writer is registered. */
    private forgetDeletionRegistration: (() => void) | undefined

    private readonly options: TaskPerformanceOwnerOptions

    private constructor(options: TaskPerformanceOwnerOptions) {
        this.options = options
        this.metrics = options.metrics
        this.emission = options.metrics ? new TaskMetricsEmission(options.metrics, options.taskId) : undefined
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
        this.tracker = new ApiRequestRoundTracker({
            taskId: options.taskId,
            repository: roundRepository,
            onChanged: options.onChanged,
        })
        this.roundLifecycle = new ApiRequestRoundLifecycle(this.tracker, executions, options.attemptUsage, {
            // The unified level counts the same terminal the Task's own execution table
            // records, so a row here cannot disagree with the execution it came from.
            observe: (execution, roundId) => {
                if (!this.emission) return
                const target = emitTargetOf(this.rounds.servingIdentityOfExecution(execution))
                this.emission.execution(
                    {
                        executionId: execution.executionId,
                        roundId,
                        logicalRequestId: execution.logicalRequestId,
                        // The execution's own terminal time: re-reading a clock here would
                        // make the same execution land in two different buckets.
                        observedAtMs: execution.completedAtMs,
                        durationMs: execution.executionDurationMs,
                        status: execution.status,
                    },
                    target,
                )
            },
        })
        this.rounds = new TaskProviderRequestRoundOwner({
            lifecycle: this.roundLifecycle,
            readExecutionBlocks: (turnId) => {
                const turn = options.readState().turn
                return turn.turnId === turnId ? turn.blocks : []
            },
            isExecutionCancelling: () => options.readState().halt.status === "stopping",
            resolveExecutionToolCalls: (blocks, awaitingBlockId) => this.toolCallsOfBlocks(blocks, awaitingBlockId),
            readPolicyGeneration: options.readUsagePolicyGeneration,
            ...(options.readServingIdentity === undefined ? {} : { readServingIdentity: options.readServingIdentity }),
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
        } catch (error) {
            await owner.release().catch(() => undefined)
            throw error
        }
        // These repositories hold the task's `metrics.db`, including the read-only
        // connection a history view opens. A deletion has no handle on this owner, so
        // the owner announces how to release it where the deletion path can find it.
        owner.forgetDeletionRegistration = registerTaskMetricsWriter(options.taskId, async () => {
            await owner.release()
            return owner.metricsReleaseError === undefined
                ? { released: true }
                : { released: false, reason: owner.metricsReleaseError }
        })
        return owner
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
        // Attempt zero starts a semantic request. Only a positive retry index may
        // reuse its admission; otherwise a later subagent run with the same local
        // request label would revive stale operation state from an earlier run.
        if (existing && input.taskAttempt > 0) return existing
        const admission = this.rounds.admit({ source: input.role })
        // A subagent executes its tools after the Provider stream is drained, so the
        // stream's own completion cannot stand for the request's settlement.
        if (input.role === "subagent") admission.expectTools?.()
        if (key) this.auxiliaryAdmissions.set(key, admission)
        return admission
    }

    /** Attach usage observed by the mandatory ApiHandler wrapper to its existing attempt admission. */
    providerAttemptUsage(input: ProviderAttemptUsageInput): void {
        if (input.role === "task" && input.logicalRequestId) {
            const apiIndex = this.ordinaryRounds.get(input.logicalRequestId)
            if (apiIndex !== undefined) {
                this.rounds.attachOrdinaryExactUsage(apiIndex, input.usage)
                this.emitRoundOf(apiIndex)
            }
            return
        }
        if (!input.logicalRequestId) return
        const admission = this.auxiliaryAdmissions.get(`${input.role}:${input.logicalRequestId}`)
        if (!admission) return
        admission.attachExactUsage(input.usage)
        // An auxiliary request is a real Provider attempt too. Attaching the usage only
        // kept the legacy round record current; without this emission the unified level
        // would miss every subagent attempt, which is exactly the traffic it must count.
        this.emitSettledAdmission(admission)
    }

    /** Re-express one settled auxiliary admission's numbers into unified events. */
    private emitSettledAdmission(admission: ProviderRequestRoundAdmission): void {
        if (!this.emission) return
        const handle = this.rounds.settledAuxiliaryRound(admission)
        if (!handle) return
        const record = this.tracker.roundRecord(handle)
        if (!record) return
        const target = emitTargetOf(this.rounds.servingIdentityOfAdmission(admission))
        this.emission.usage(record, target)
        this.emission.provider(record, target)
    }

    /**
     * Re-express the settled numbers of one ordinary round as unified events.
     *
     * Reading the round back keeps one source of truth: the tokens and the duration
     * here are the ones the round already decided, so a later change to how they are
     * measured needs no second edit in the emission path.
     */
    private emitRoundOf(apiIndex: number): void {
        if (!this.emission) return
        const handle = this.rounds.settledRound(apiIndex)
        if (!handle) return
        const record = this.tracker.roundRecord(handle)
        if (!record) return
        const target = emitTargetOf(this.rounds.servingIdentityOf(apiIndex))
        this.emission.usage(record, target)
        this.emission.provider(record, target)
        // The identity is retained: the same send's logical execution settles later, at
        // the tool or turn boundary, and must still name the Profile that spent the tokens.
        // `completeSettledRounds` forgets it when the turn it belongs to stops running.
    }

    /**
     * Settle a subagent logical request with the tools its send asked for.
     *
     * The Provider stream only produced the calls; the Runner executed them, so
     * this is the boundary that can report the request's tools at all.
     */
    providerLogicalToolsSettled(input: ProviderAttemptUsageInput, toolCalls: readonly UsageToolCall[]): void {
        if (input.role === "task" || !input.logicalRequestId) return
        const key = `${input.role}:${input.logicalRequestId}`
        const admission = this.auxiliaryAdmissions.get(key)
        if (!admission) return
        this.auxiliaryAdmissions.delete(key)
        if (toolCalls.length === 0) {
            // A settled zero-tool summary is the explicit deferral release: the caller
            // ran its tools and found none. `completeProviderOnly` would return early
            // on the still-declared deferral and leave the request open until close.
            admission.completeTools(NO_TOOL_CALLS)
            return
        }
        const completed = toolCalls.filter((call) => call.outcome === "completed").length
        const failed = toolCalls.filter((call) => call.outcome === "failed").length
        const cancelled = toolCalls.filter((call) => call.outcome === "cancelled").length
        admission.completeTools(
            {
                toolCount: toolCalls.length,
                completedToolCount: completed,
                failedToolCount: failed,
                cancelledToolCount: cancelled,
            },
            toolCalls,
        )
    }

    /**
     * The subagent stream ended without asking for a tool.
     *
     * Deferral was only waiting for tools that never came, so the request ends at
     * its Provider terminal instead of staying open for the rest of the run.
     */
    providerLogicalToolsExpected(input: ProviderAttemptScopeInput): void {
        if (input.role !== "subagent" || !input.logicalRequestId) return
        const key = `${input.role}:${input.logicalRequestId}`
        const admission = this.auxiliaryAdmissions.get(key)
        if (!admission) return
        this.auxiliaryAdmissions.delete(key)
        // Same zero-tool settlement as above: the deferral was waiting for tools that
        // never came, so it must be released explicitly instead of by the guard.
        admission.completeTools(NO_TOOL_CALLS)
    }

    /** Complete an auxiliary logical request at the mandatory ApiHandler terminal boundary. */
    providerRequestCompleted(input: ProviderAttemptScopeInput): void {
        // A subagent request owns its tools past the Provider stream; only its own
        // settlement may end it, so the stream boundary is not its terminal.
        if (input.role === "task" || input.role === "subagent" || !input.logicalRequestId) return
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
            this.rounds.forgetServingIdentity(apiIndex)
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

    /**
     * The unified metrics reader for this Task, or `undefined` when none was wired.
     *
     * Reads wait for nothing: they return what has already been committed, so a
     * caller never blocks a turn on a batch that has not landed yet.
     */
    get unifiedMetrics(): MetricsQueryService | undefined {
        return this.options.metricsQuery
    }

    /** The scope those committed rows belong to, when a reader was wired. */
    get unifiedMetricsScope(): MetricsScope | undefined {
        return this.options.metricsScope
    }

    /**
     * Stop recording, then release storage.
     *
     * The metrics writer goes first: a worker still holding `metrics.db` keeps the file
     * and its sidecars undeletable on Windows, so a deletion path that released Task
     * storage before this stop would fail to remove the directory. A writer that cannot
     * confirm it stopped is reported instead of being assumed safe.
     */
    async release(): Promise<void> {
        if (this.closed) return
        this.closed = true
        // A released owner must stop advertising itself: otherwise a later deletion would
        // wait on a writer that already stopped, and report a timeout instead of success.
        this.forgetDeletionRegistration?.()
        this.forgetDeletionRegistration = undefined
        this.auxiliaryAdmissions.clear()
        this.registeredExecutions.clear()
        this.awaitingUserTerminals.clear()
        await this.rounds.waitForCompletions()
        // Close the lifecycle while the writer can still accept events: closing
        // terminalizes unfinished executions and publishes their facts, and a writer
        // released first would discard exactly the executions a stop has to record.
        await this.roundLifecycle.close()
        if (this.metrics) {
            const released = await this.metrics.release().catch(() => ({ released: false, reason: "metrics release failed" }))
            if (!released.released) this.metricsReleaseFailure = released.reason ?? "metrics writer did not stop"
            this.metrics = undefined
        }
        await Promise.allSettled([this.activeMetrics.dispose()])
    }

    /** The unified metrics emitter, or `undefined` when this Task records no metrics. */
    get metricsEmitter(): TaskMetricsAttachment["emitter"] | undefined {
        return this.metrics?.emitter
    }

    /**
     * Why the metrics writer could not be released, if it could not.
     *
     * A deletion path must treat a non-empty value as "do not delete the database yet".
     */
    get metricsReleaseError(): string | undefined {
        return this.metricsReleaseFailure
    }
}

/**
 * Project a frozen serving identity into an emission target.
 *
 * Only the fields that actually differ are overridden. An identity without a provider
 * or model keeps the Task's opening values, because a missing field is not a claim that
 * the provider changed.
 */
function emitTargetOf(identity: ServingMetricsIdentity | undefined): MetricsEmitTarget | undefined {
    if (!identity) return undefined
    return {
        profileId: identity.profileId,
        ...(identity.providerId === undefined ? {} : { providerId: identity.providerId }),
        ...(identity.modelId === undefined ? {} : { modelId: identity.modelId }),
        // The fingerprint always follows the serving Profile, including a credential-less
        // one: an OAuth Profile has no API key, and inheriting the opening Profile's
        // fingerprint would file its tokens under a key this send never used.
        keyFingerprint: usageKeyFingerprint(identity.apiKey),
    }
}

const LOOP_ACTIVE_PHASES: ReadonlySet<TaskState["flow"]["phase"]> = new Set(["initializing", "running"])

function finiteUsage(value: number | undefined): number {
    return Number.isFinite(value) && value !== undefined && value > 0 ? value : 0
}
