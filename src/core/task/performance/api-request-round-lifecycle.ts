import type { ProviderAttemptObserver, ProviderAttemptTerminalStatus } from "@shared/provider-attempt-observer"
import { type ApiRequestRoundHandle, type ApiRequestRoundSnapshot, ApiRequestRoundTracker } from "./api-request-round-tracker"
import type { ApiRequestRoundUsage } from "./api-request-round-types"
import type { ApiResponseExecutionLifecycle } from "./api-response-execution-lifecycle"
import type { ApiResponseExecutionSnapshot, ApiResponseExecutionToolSummary } from "./api-response-execution-types"

export interface ApiRequestRoundScopeInput {
    readonly logicalRequestId: string
    readonly apiIndex: number
    readonly taskAttempt: number
}

/** Bridges transport-level attempt observation to Task-local round persistence. */
export class ApiRequestRoundLifecycle {
    private readonly latestTerminal = new Map<string, ApiRequestRoundHandle>()
    private readonly pendingCompletedExecution = new Map<string, ApiRequestRoundHandle>()

    constructor(
        private readonly tracker: ApiRequestRoundTracker,
        private readonly executions?: ApiResponseExecutionLifecycle,
    ) {}

    createObserver(input: ApiRequestRoundScopeInput): ProviderAttemptObserver<ApiRequestRoundHandle> {
        return {
            beginAttempt: () => {
                this.completeSupersededExecution(input.logicalRequestId)
                const handle = this.tracker.beginRound(input)
                this.executions?.begin(handle)
                return handle
            },
            finishAttempt: (handle, status) => {
                const record = this.tracker.finishRound(handle, toRoundStatus(status))
                this.latestTerminal.set(input.logicalRequestId, handle)
                this.executions?.providerTerminal(handle, record)
                if (status === "completed") this.pendingCompletedExecution.set(input.logicalRequestId, handle)
            },
        }
    }

    attachExactUsage(logicalRequestId: string, usage: ApiRequestRoundUsage): void {
        const handle = this.latestTerminal.get(logicalRequestId)
        if (!handle) return
        this.tracker.attachExactUsage(handle, usage)
    }

    completeProviderOnly(logicalRequestId: string): void {
        const handle = this.takePendingExecution(logicalRequestId)
        if (handle) this.executions?.completeProviderOnly(handle)
    }

    completeTools(logicalRequestId: string, summary: ApiResponseExecutionToolSummary): void {
        const handle = this.takePendingExecution(logicalRequestId)
        if (handle) this.executions?.completeTools(handle, summary)
    }

    completeTurnEndAwaitingUser(logicalRequestId: string, summary: ApiResponseExecutionToolSummary): void {
        const handle = this.takePendingExecution(logicalRequestId)
        if (handle) this.executions?.completeTurnEndAwaitingUser(handle, summary)
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
        await Promise.all([this.tracker.close(), this.executions?.close()])
    }

    private completeSupersededExecution(logicalRequestId: string): void {
        const handle = this.takePendingExecution(logicalRequestId)
        if (handle) this.executions?.completeProviderOnly(handle)
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
