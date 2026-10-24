import type {
    ProviderAttemptIdentity,
    ProviderAttemptObserver,
    ProviderAttemptTerminalStatus,
} from "@shared/provider-attempt-observer"
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
import type { FinalizedProviderAttempt, FinalizedProviderAttemptPort } from "./provider-request-round-port"

export interface ApiRequestRoundScopeInput {
    readonly logicalRequestId: string
    readonly apiIndex: number
    readonly taskAttempt: number
    readonly role?: ProviderAttemptRole
    readonly policyGeneration?: number
}

/** Bridges transport-level attempt observation to Task-local round persistence. */
export class ApiRequestRoundLifecycle {
    private readonly pendingFinalization = new Map<string, FinalizedProviderAttempt>()
    private readonly finalizedRoundIds = new Set<string>()
    private readonly pendingCompletedExecution = new Map<string, ApiRequestRoundHandle>()

    constructor(
        private readonly tracker: ApiRequestRoundTracker,
        private readonly executions?: ApiResponseExecutionLifecycle,
        private readonly finalizedAttempts?: FinalizedProviderAttemptPort,
    ) {}

    createObserver(input: ApiRequestRoundScopeInput): ProviderAttemptObserver<ApiRequestRoundHandle> {
        return {
            beginAttempt: (identity?: ProviderAttemptIdentity) => {
                this.finalizePendingAttempt(input.logicalRequestId)
                this.completeSupersededExecution(input.logicalRequestId)
                const handle = this.tracker.beginRound({ ...input, ...identity })
                this.executions?.begin(handle)
                return handle
            },
            finishAttempt: (handle, status) => {
                const record = this.tracker.finishRound(handle, toRoundStatus(status))
                this.pendingFinalization.set(input.logicalRequestId, { handle, record })
                this.executions?.providerTerminal(handle, record)
                this.pendingCompletedExecution.set(input.logicalRequestId, handle)
            },
        }
    }

    attachExactUsage(handle: ApiRequestRoundHandle, usage: ApiRequestRoundUsage): void {
        if (this.finalizedRoundIds.has(handle.roundId)) {
            throw new Error("API request round usage cannot revise a finalized attempt")
        }
        const record = this.tracker.attachExactUsage(handle, usage)
        const pending = this.pendingFinalization.get(handle.logicalRequestId)
        if (!pending || pending.handle.roundId !== handle.roundId) {
            throw new Error("API request round usage has no matching pending finalization")
        }
        this.pendingFinalization.set(handle.logicalRequestId, { handle, record })
    }

    completeProviderOnly(logicalRequestId: string): void {
        const handle = this.takePendingExecution(logicalRequestId)
        if (handle) this.executions?.completeProviderOnly(handle)
        this.finalizePendingAttempt(logicalRequestId, this.terminalExecution(handle))
    }

    completeTools(
        logicalRequestId: string,
        summary: ApiResponseExecutionToolSummary,
        toolCalls?: readonly UsageToolCall[],
    ): void {
        const handle = this.takePendingExecution(logicalRequestId)
        if (handle) this.executions?.completeTools(handle, summary)
        this.finalizePendingAttempt(logicalRequestId, this.terminalExecution(handle), toolCalls)
    }

    completeTurnEndAwaitingUser(
        logicalRequestId: string,
        summary: ApiResponseExecutionToolSummary,
        toolCalls?: readonly UsageToolCall[],
    ): void {
        const handle = this.takePendingExecution(logicalRequestId)
        if (handle) this.executions?.completeTurnEndAwaitingUser(handle, summary)
        this.finalizePendingAttempt(logicalRequestId, this.terminalExecution(handle), toolCalls)
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

    async abortOpenExecutions(): Promise<void> {
        this.pendingCompletedExecution.clear()
        await this.executions?.abortOpenExecutions()
    }

    async close(): Promise<void> {
        for (const logicalRequestId of [...this.pendingFinalization.keys()]) this.finalizePendingAttempt(logicalRequestId)
        for (const attempt of this.tracker.abortOpenRounds()) {
            this.executions?.providerTerminal(attempt.handle, attempt.record)
            this.publishFinalized(attempt)
        }
        await Promise.all([this.tracker.close(), this.executions?.close()])
    }

    private completeSupersededExecution(logicalRequestId: string): void {
        const handle = this.takePendingExecution(logicalRequestId)
        if (handle) this.executions?.completeProviderOnly(handle)
    }

    private finalizePendingAttempt(
        logicalRequestId: string,
        logicalExecution?: ApiResponseExecutionRecord,
        logicalToolCalls?: readonly UsageToolCall[],
    ): void {
        const attempt = this.pendingFinalization.get(logicalRequestId)
        if (!attempt) return
        this.pendingFinalization.delete(logicalRequestId)
        this.publishFinalized({
            ...attempt,
            ...(logicalExecution ? { logicalExecution } : {}),
            ...(logicalToolCalls ? { logicalToolCalls: [...logicalToolCalls] } : {}),
        })
    }

    private publishFinalized(attempt: FinalizedProviderAttempt): void {
        if (this.finalizedRoundIds.has(attempt.handle.roundId)) return
        this.finalizedRoundIds.add(attempt.handle.roundId)
        try {
            this.finalizedAttempts?.recordFinalizedAttempt(attempt)
        } catch (error) {
            Logger.debug(`[usage] finalized provider attempt could not be recorded: ${String(error)}`)
        }
    }

    private terminalExecution(handle: ApiRequestRoundHandle | undefined): ApiResponseExecutionRecord | undefined {
        return handle ? this.executions?.terminal(handle) : undefined
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
