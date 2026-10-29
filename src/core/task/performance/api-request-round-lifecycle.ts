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

    completeProviderOnly(logicalRequestId: string): void {
        const handle = this.takePendingExecution(logicalRequestId)
        if (!handle) return
        this.executions?.completeProviderOnly(handle)
        this.publishLogicalExecution(handle)
    }

    completeTools(
        logicalRequestId: string,
        summary: ApiResponseExecutionToolSummary,
        toolCalls?: readonly UsageToolCall[],
    ): void {
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
        return unsettled
    }

    private completeSupersededExecution(logicalRequestId: string): void {
        const handle = this.takePendingExecution(logicalRequestId)
        if (handle) this.executions?.completeProviderOnly(handle)
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
