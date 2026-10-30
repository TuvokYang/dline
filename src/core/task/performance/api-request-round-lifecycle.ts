import type {
    ProviderAttemptIdentity,
    ProviderAttemptObserver,
    ProviderAttemptTerminalStatus,
} from "@shared/provider-attempt-observer"
import { usageFailureClassOf } from "@/core/api/observability/provider-failure"
import { endProviderSendSpan, startProviderSendSpan } from "@/core/api/observability/provider-send-span"
import type { SignalSpanHandle } from "@/services/telemetry/service/pipeline-port"
import { Logger } from "@/shared/services/Logger"
import type { UsageToolCall } from "../telemetry/UsageToolCalls"
import {
    type ApiRequestRoundHandle,
    type ApiRequestRoundSnapshot,
    ApiRequestRoundTracker,
    type ProviderAttemptRole,
} from "./api-request-round-tracker"
import type { ApiRequestRoundUsage } from "./api-request-round-types"
import type { ApiResponseExecutionLifecycle } from "./api-response-execution-lifecycle"
import type {
    ApiResponseExecutionRecord,
    ApiResponseExecutionSnapshot,
    ApiResponseExecutionToolSummary,
} from "./api-response-execution-types"
import type { ProviderAttemptUsageEvent, ProviderAttemptUsagePort } from "./provider-request-round-port"

export interface ApiRequestRoundScopeInput {
    readonly logicalRequestId: string
    readonly apiIndex: number
    readonly taskAttempt: number
    readonly role?: ProviderAttemptRole
    readonly policyGeneration?: number
}

/**
 * Bridges transport-level attempt observation to Task-local round persistence
 * and forwards each Provider fact in order. It owns no clock: the usage port
 * decides when tokens are final, so logical settlement never gates a send.
 */
export class ApiRequestRoundLifecycle {
    /** Latest terminal attempt of each logical request, awaiting its logical settlement. */
    private readonly pendingCompletedExecution = new Map<string, ApiRequestRoundHandle>()
    /**
     * Logical requests whose tools run after the Provider stream ends.
     *
     * The owning caller declares this before it sends, so it is request-scoped
     * state: an attempt handle exists only once that send starts, and every retry
     * of the request inherits the same deferral.
     */
    private readonly toolsExpectedRequests = new Set<string>()
    /** The `gen_ai.client.operation` span of each open send. */
    private readonly sendSpans = new WeakMap<ApiRequestRoundHandle, SignalSpanHandle>()

    constructor(
        private readonly tracker: ApiRequestRoundTracker,
        private readonly executions?: ApiResponseExecutionLifecycle,
        private readonly usage?: ProviderAttemptUsagePort,
    ) {}

    createObserver(input: ApiRequestRoundScopeInput): ProviderAttemptObserver<ApiRequestRoundHandle> {
        return {
            beginAttempt: (identity?: ProviderAttemptIdentity) => {
                this.completeSupersededExecution(input.logicalRequestId)
                const handle = this.tracker.beginRound({ ...input, ...identity })
                this.executions?.begin(handle)
                if (this.toolsExpectedRequests.has(input.logicalRequestId)) this.executions?.expectTools(handle)
                const span = startProviderSendSpan(handle)
                if (span) this.sendSpans.set(handle, span)
                return handle
            },
            finishAttempt: (handle, status, failure) => {
                endProviderSendSpan(this.sendSpans.get(handle), status, failure)
                this.sendSpans.delete(handle)
                const record = this.tracker.finishRound(handle, toRoundStatus(status))
                this.executions?.providerTerminal(handle, record)
                this.pendingCompletedExecution.set(input.logicalRequestId, handle)
                this.publish({
                    kind: "terminal",
                    handle,
                    record,
                    ...(record.status === "failed" ? { failureClass: usageFailureClassOf(failure) } : {}),
                })
            },
        }
    }

    /** Record one exact-usage revision; whether it still counts is the usage port's finalization decision. */
    attachExactUsage(handle: ApiRequestRoundHandle, usage: ApiRequestRoundUsage): void {
        const record = this.tracker.attachExactUsage(handle, usage)
        this.publish({ kind: "tokens", handle, record })
    }

    /** No further token revision will come for this send. */
    finalizeTokens(handle: ApiRequestRoundHandle): void {
        this.publish({ kind: "tokens_final", roundId: handle.roundId })
    }

    /**
     * End a request at its Provider terminal only when nothing follows it.
     *
     * A request whose tools run afterwards is still open: taking its handle here
     * would drop the only reference a later settlement needs to find it.
     */
    completeProviderOnly(logicalRequestId: string): void {
        if (this.toolsExpectedRequests.has(logicalRequestId)) return
        const handle = this.takePendingExecution(logicalRequestId)
        if (!handle) return
        this.executions?.completeProviderOnly(handle)
        this.publishLogicalExecution(handle)
    }

    /**
     * Declare that this request runs tools after its Provider stream ends.
     *
     * A declaration that arrives after a send already reached its terminal still
     * defers that send, which is why the handle is marked as well as the request.
     */
    expectTools(logicalRequestId: string): void {
        this.toolsExpectedRequests.add(logicalRequestId)
        const handle = this.pendingCompletedExecution.get(logicalRequestId)
        if (handle) this.executions?.expectTools(handle)
    }

    completeTools(
        logicalRequestId: string,
        summary: ApiResponseExecutionToolSummary,
        toolCalls?: readonly UsageToolCall[],
    ): void {
        this.toolsExpectedRequests.delete(logicalRequestId)
        const handle = this.takePendingExecution(logicalRequestId)
        if (!handle) return
        this.executions?.completeTools(handle, summary)
        this.publishLogicalExecution(handle, toolCalls)
    }

    completeTurnEndAwaitingUser(
        logicalRequestId: string,
        summary: ApiResponseExecutionToolSummary,
        toolCalls?: readonly UsageToolCall[],
    ): void {
        this.toolsExpectedRequests.delete(logicalRequestId)
        const handle = this.takePendingExecution(logicalRequestId)
        if (!handle) return
        this.executions?.completeTurnEndAwaitingUser(handle, summary)
        this.publishLogicalExecution(handle, toolCalls)
    }

    initializeRounds(): Promise<void> {
        return this.tracker.initialize()
    }

    async initializeExecutions(): Promise<void> {
        await this.executions?.initialize()
    }

    async initialize(): Promise<void> {
        await Promise.all([this.initializeRounds(), this.initializeExecutions()])
    }

    getSnapshot(): ApiRequestRoundSnapshot {
        return this.tracker.getSnapshot()
    }

    getExecutionSnapshot(): ApiResponseExecutionSnapshot {
        return this.executions?.getSnapshot() ?? { rpmBasis: "unavailable", executionCount: 0, degraded: false }
    }

    async waitForRoundPersistence(): Promise<void> {
        await this.tracker.waitForPersistence()
    }

    async waitForExecutionPersistence(): Promise<void> {
        await this.executions?.waitForPersistence()
    }

    async waitForPersistence(): Promise<void> {
        await Promise.all([this.tracker.waitForPersistence(), this.executions?.waitForPersistence()])
    }

    /** Owner abort settles every unsettled logical request as aborted (usage-client-lifecycle §7). */
    async abortOpenExecutions(): Promise<void> {
        const unsettled = this.takeUnsettledExecutions()
        await this.executions?.abortOpenExecutions()
        for (const handle of unsettled) this.publishLogicalExecution(handle)
    }

    /**
     * Sends still open at close are aborted; no token revision can follow, so
     * their tokens are final. Every logical request not yet settled ends aborted.
     */
    async close(): Promise<void> {
        const unsettled = this.takeUnsettledExecutions()
        for (const { handle, record } of this.tracker.abortOpenRounds()) {
            this.executions?.providerTerminal(handle, record)
            this.publish({ kind: "terminal", handle, record })
            this.publish({ kind: "tokens_final", roundId: handle.roundId })
            unsettled.push(handle)
        }
        await Promise.all([this.tracker.close(), this.executions?.close()])
        for (const handle of unsettled) this.publishLogicalExecution(handle)
    }

    private takeUnsettledExecutions(): ApiRequestRoundHandle[] {
        const unsettled = [...this.pendingCompletedExecution.values()]
        this.pendingCompletedExecution.clear()
        this.toolsExpectedRequests.clear()
        return unsettled
    }

    /**
     * A retried send supersedes the attempt that already reached its Provider
     * terminal, because only the last attempt of a request produces the result.
     *
     * A request that runs tools after its stream is different: the retry
     * interrupted it before those tools could run, so reporting it as a
     * completed request that happened to use none would be a false claim.
     */
    private completeSupersededExecution(logicalRequestId: string): void {
        const handle = this.pendingCompletedExecution.get(logicalRequestId)
        if (!handle) return
        if (!this.toolsExpectedRequests.has(logicalRequestId)) {
            this.executions?.completeProviderOnly(handle)
            this.pendingCompletedExecution.delete(logicalRequestId)
            return
        }
        try {
            this.executions?.abortExecution(handle)
        } catch (error) {
            Logger.debug(`[usage] superseded execution of ${handle.roundId} could not be aborted: ${String(error)}`)
            return
        }
        this.pendingCompletedExecution.delete(logicalRequestId)
        // The interrupted send is a real execution, so its fact is still reported.
        this.publishLogicalExecution(handle)
    }

    private publishLogicalExecution(handle: ApiRequestRoundHandle, toolCalls?: readonly UsageToolCall[]): void {
        let execution: ApiResponseExecutionRecord | undefined
        try {
            execution = this.executions?.terminal(handle)
        } catch (error) {
            Logger.debug(`[usage] logical execution of ${handle.roundId} is unavailable: ${String(error)}`)
            return
        }
        if (!execution) return
        this.publish({ kind: "logical_execution", handle, execution, ...(toolCalls ? { toolCalls: [...toolCalls] } : {}) })
    }

    /** Usage is an observer: a failing consumer never breaks the Task's own round persistence. */
    private publish(event: ProviderAttemptUsageEvent): void {
        try {
            this.usage?.recordAttemptEvent(event)
        } catch (error) {
            Logger.debug(`[usage] provider attempt ${event.kind} could not be recorded: ${String(error)}`)
        }
    }

    private takePendingExecution(logicalRequestId: string): ApiRequestRoundHandle | undefined {
        const handle = this.pendingCompletedExecution.get(logicalRequestId)
        if (handle) this.pendingCompletedExecution.delete(logicalRequestId)
        return handle
    }
}

function toRoundStatus(status: ProviderAttemptTerminalStatus): ProviderAttemptTerminalStatus {
    return status
}
