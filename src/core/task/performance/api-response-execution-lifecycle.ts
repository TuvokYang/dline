import { performance } from "node:perf_hooks"
import type { ApiRequestRoundHandle } from "./api-request-round-tracker"
import type { ApiRequestRoundRecord } from "./api-request-round-types"
import { calculateExecutionDurationRpm } from "./api-response-execution-aggregator"
import {
    API_RESPONSE_EXECUTION_SCHEMA_VERSION,
    type ApiResponseExecutionRecord,
    type ApiResponseExecutionRepository,
    type ApiResponseExecutionSnapshot,
    type ApiResponseExecutionStatus,
    type ApiResponseExecutionTerminalKind,
    type ApiResponseExecutionToolSummary,
} from "./api-response-execution-types"

interface MutableExecutionState {
    readonly handle: ApiRequestRoundHandle
    providerTerminal?: ApiRequestRoundRecord
    terminalRecord?: ApiResponseExecutionRecord
}

export interface ApiResponseExecutionLifecycleOptions {
    readonly taskId: string
    readonly repository: ApiResponseExecutionRepository
    readonly wallClock?: () => number
    readonly monotonicClock?: () => number
    readonly onChanged?: () => void
}

const NO_TOOLS: ApiResponseExecutionToolSummary = {
    toolCount: 0,
    completedToolCount: 0,
    failedToolCount: 0,
    cancelledToolCount: 0,
}

/** Coordinates Provider transport facts with Task-owned complete execution terminals. */
export class ApiResponseExecutionLifecycle {
    private readonly wallClock: () => number
    private readonly monotonicClock: () => number
    private readonly executions = new Map<string, MutableExecutionState>()
    private readonly persistedExecutions = new Map<string, ApiResponseExecutionRecord>()
    private recoveredExecutions: ApiResponseExecutionRecord[] = []
    private initialization: Promise<void> | undefined
    private writeSequence: Promise<void> = Promise.resolve()
    private recoveryDegraded = false
    private persistenceUnavailable = false
    private closing = false

    constructor(private readonly options: ApiResponseExecutionLifecycleOptions) {
        this.wallClock = options.wallClock ?? Date.now
        this.monotonicClock = options.monotonicClock ?? performance.now.bind(performance)
    }

    initialize(): Promise<void> {
        this.initialization ??= this.options.repository.readRecent(60).then(
            (records) => {
                this.recoveredExecutions = records
            },
            (error) => {
                this.recoveryDegraded = true
                throw error
            },
        )
        return this.initialization
    }

    getSnapshot(): ApiResponseExecutionSnapshot {
        const aggregate = calculateExecutionDurationRpm(
            mergeCanonicalExecutions(this.recoveredExecutions, [...this.persistedExecutions.values()]).slice(-60),
        )
        const degraded = this.recoveryDegraded || this.persistenceUnavailable
        return {
            ...(degraded || aggregate.requestsPerMinute === undefined ? {} : { requestsPerMinute: aggregate.requestsPerMinute }),
            rpmBasis: degraded || aggregate.executionCount === 0 ? "unavailable" : "execution_duration",
            executionCount: aggregate.executionCount,
            ...(aggregate.executionDurationMs > 0 ? { executionDurationMs: aggregate.executionDurationMs } : {}),
            degraded,
        }
    }

    begin(handle: ApiRequestRoundHandle): void {
        if (this.closing) throw new Error("API response execution lifecycle is closing")
        if (this.executions.has(handle.roundId)) throw new Error("API response execution already exists")
        assertHandle(handle)
        this.executions.set(handle.roundId, { handle })
    }

    providerTerminal(handle: ApiRequestRoundHandle, record: ApiRequestRoundRecord): void {
        const state = this.requireState(handle)
        if (state.providerTerminal) return
        assertProviderTerminal(handle, record)
        state.providerTerminal = record
        if (record.status !== "completed") {
            this.finishAtProviderTerminal(state, record.status)
        }
    }

    completeProviderOnly(handle: ApiRequestRoundHandle): void {
        const state = this.requireState(handle)
        if (state.terminalRecord) return
        const provider = this.requireProviderTerminal(state)
        this.finishAtProviderTerminal(state, provider.status)
    }

    completeTools(handle: ApiRequestRoundHandle, summary: ApiResponseExecutionToolSummary): void {
        this.finishAtCurrentTime(handle, "tools_settled", summary)
    }

    completeTurnEndAwaitingUser(handle: ApiRequestRoundHandle, summary: ApiResponseExecutionToolSummary): void {
        this.finishAtCurrentTime(handle, "turn_end_awaiting_user", summary)
    }

    /** Return the immutable terminal record after the owning completion boundary has run. */
    terminal(handle: ApiRequestRoundHandle): ApiResponseExecutionRecord | undefined {
        return this.requireState(handle).terminalRecord
    }

    async waitForPersistence(): Promise<void> {
        await this.writeSequence
        try {
            await this.options.repository.waitForWrites()
        } catch {
            this.persistenceUnavailable = true
        }
    }

    async abortOpenExecutions(): Promise<void> {
        for (const state of this.executions.values()) {
            if (!state.terminalRecord) this.abort(state)
        }
        await this.waitForPersistence()
    }

    async close(): Promise<void> {
        if (!this.closing) {
            this.closing = true
            for (const state of this.executions.values()) {
                if (!state.terminalRecord) this.abort(state)
            }
        }
        await this.waitForPersistence()
        await this.options.repository.close()
    }

    private finishAtProviderTerminal(state: MutableExecutionState, status: ApiResponseExecutionStatus): void {
        if (state.terminalRecord) return
        const provider = this.requireProviderTerminal(state)
        this.persist(
            state,
            this.createRecord({
                state,
                provider,
                completedAtMs: provider.completedAtMs,
                executionDurationMs: requireProviderDuration(provider),
                status,
                terminalKind: "provider_only",
                summary: NO_TOOLS,
            }),
        )
    }

    private finishAtCurrentTime(
        handle: ApiRequestRoundHandle,
        terminalKind: Exclude<ApiResponseExecutionTerminalKind, "provider_only">,
        summary: ApiResponseExecutionToolSummary,
    ): void {
        const state = this.requireState(handle)
        if (state.terminalRecord) return
        const provider = this.requireProviderTerminal(state)
        assertToolSummary(summary)
        const completedAtMs = readClock(this.wallClock, "wall clock")
        const completedMonotonicMs = readClock(this.monotonicClock, "monotonic clock")
        if (completedAtMs < provider.completedAtMs || completedMonotonicMs < handle.startedMonotonicMs) {
            throw new Error("API response execution completion moved before its Provider terminal")
        }
        this.persist(
            state,
            this.createRecord({
                state,
                provider,
                completedAtMs,
                executionDurationMs: Math.max(
                    requireProviderDuration(provider),
                    completedMonotonicMs - handle.startedMonotonicMs,
                ),
                status: statusFrom(provider.status, summary),
                terminalKind,
                summary,
            }),
        )
    }

    private abort(state: MutableExecutionState): void {
        const completedAtMs = readClock(this.wallClock, "wall clock")
        const completedMonotonicMs = readClock(this.monotonicClock, "monotonic clock")
        const elapsed = Math.max(1, completedMonotonicMs - state.handle.startedMonotonicMs)
        const provider = state.providerTerminal
        const providerDurationMs = provider ? requireProviderDuration(provider) : elapsed
        const providerCompletedAtMs = provider?.completedAtMs ?? completedAtMs
        this.persist(
            state,
            this.createRecord({
                state,
                provider:
                    provider ??
                    ({
                        completedAtMs: providerCompletedAtMs,
                        providerDurationMs,
                    } as ApiRequestRoundRecord),
                completedAtMs: Math.max(completedAtMs, providerCompletedAtMs),
                executionDurationMs: Math.max(providerDurationMs, elapsed),
                status: "aborted",
                terminalKind: "provider_only",
                summary: NO_TOOLS,
            }),
        )
    }

    private createRecord(input: {
        readonly state: MutableExecutionState
        readonly provider: Pick<ApiRequestRoundRecord, "completedAtMs" | "providerDurationMs">
        readonly completedAtMs: number
        readonly executionDurationMs: number
        readonly status: ApiResponseExecutionStatus
        readonly terminalKind: ApiResponseExecutionTerminalKind
        readonly summary: ApiResponseExecutionToolSummary
    }): ApiResponseExecutionRecord {
        const { handle } = input.state
        return {
            schemaVersion: API_RESPONSE_EXECUTION_SCHEMA_VERSION,
            taskId: this.options.taskId,
            executionId: handle.roundId,
            revision: 0,
            roundId: handle.roundId,
            logicalRequestId: handle.logicalRequestId,
            apiIndex: handle.apiIndex,
            taskAttempt: handle.taskAttempt,
            providerAttempt: handle.providerAttempt,
            startedAtMs: handle.startedAtMs,
            providerCompletedAtMs: input.provider.completedAtMs,
            completedAtMs: input.completedAtMs,
            providerDurationMs: requireProviderDuration(input.provider),
            executionDurationMs: Math.max(1, input.executionDurationMs),
            status: input.status,
            terminalKind: input.terminalKind,
            ...input.summary,
        }
    }

    private persist(state: MutableExecutionState, record: ApiResponseExecutionRecord): void {
        if (state.terminalRecord) return
        state.terminalRecord = record
        const write = this.writeSequence.then(() => this.options.repository.append([record]))
        this.writeSequence = write.then(
            () => {
                this.persistedExecutions.set(record.executionId, record)
                this.options.onChanged?.()
            },
            () => {
                this.persistenceUnavailable = true
                this.options.onChanged?.()
            },
        )
    }

    private requireState(handle: ApiRequestRoundHandle): MutableExecutionState {
        const state = this.executions.get(handle.roundId)
        if (!state || !sameHandle(state.handle, handle)) throw new Error("Unknown or mismatched API response execution handle")
        return state
    }

    private requireProviderTerminal(state: MutableExecutionState): ApiRequestRoundRecord {
        if (!state.providerTerminal) throw new Error("API response execution Provider terminal is required")
        return state.providerTerminal
    }
}

function mergeCanonicalExecutions(
    recovered: readonly ApiResponseExecutionRecord[],
    current: readonly ApiResponseExecutionRecord[],
): ApiResponseExecutionRecord[] {
    const records = new Map<string, ApiResponseExecutionRecord>()
    for (const record of [...recovered, ...current]) {
        const existing = records.get(record.executionId)
        if (!existing || record.revision > existing.revision) records.set(record.executionId, record)
    }
    return [...records.values()].sort(
        (left, right) =>
            left.completedAtMs - right.completedAtMs ||
            left.providerAttempt - right.providerAttempt ||
            left.executionId.localeCompare(right.executionId),
    )
}

function statusFrom(
    providerStatus: ApiResponseExecutionStatus,
    summary: ApiResponseExecutionToolSummary,
): ApiResponseExecutionStatus {
    if (providerStatus !== "completed") return providerStatus
    if (summary.cancelledToolCount > 0) return "cancelled"
    if (summary.failedToolCount > 0) return "failed"
    return "completed"
}

function assertHandle(handle: ApiRequestRoundHandle): void {
    if (!handle.roundId || !handle.logicalRequestId) throw new Error("API response execution handle identity is incomplete")
    for (const [name, value] of [
        ["apiIndex", handle.apiIndex],
        ["taskAttempt", handle.taskAttempt],
        ["providerAttempt", handle.providerAttempt],
    ] as const) {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new Error(`API response execution handle ${name} must be a non-negative integer`)
        }
    }
    readValue(handle.startedAtMs, "startedAtMs")
    readValue(handle.startedMonotonicMs, "startedMonotonicMs")
}

function assertProviderTerminal(handle: ApiRequestRoundHandle, record: ApiRequestRoundRecord): void {
    if (
        record.taskId === "" ||
        record.roundId !== handle.roundId ||
        record.logicalRequestId !== handle.logicalRequestId ||
        record.apiIndex !== handle.apiIndex ||
        record.taskAttempt !== handle.taskAttempt ||
        record.providerAttempt !== handle.providerAttempt
    ) {
        throw new Error("API response execution Provider terminal does not match its handle")
    }
    requireProviderDuration(record)
}

function assertToolSummary(summary: ApiResponseExecutionToolSummary): void {
    for (const [name, value] of [
        ["toolCount", summary.toolCount],
        ["completedToolCount", summary.completedToolCount],
        ["failedToolCount", summary.failedToolCount],
        ["cancelledToolCount", summary.cancelledToolCount],
    ] as const) {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new Error(`API response execution ${name} must be a non-negative integer`)
        }
    }
    if (summary.toolCount === 0) throw new Error("API response execution tool summary must contain a tool")
    if (summary.completedToolCount + summary.failedToolCount + summary.cancelledToolCount !== summary.toolCount) {
        throw new Error("API response execution tool summary must be fully settled")
    }
}

function requireProviderDuration(record: Pick<ApiRequestRoundRecord, "providerDurationMs">): number {
    const duration = record.providerDurationMs
    if (duration === undefined || !Number.isFinite(duration) || duration < 1) {
        throw new Error("API response execution requires a valid Provider duration")
    }
    return duration
}

function sameHandle(left: ApiRequestRoundHandle, right: ApiRequestRoundHandle): boolean {
    return (
        left.logicalRequestId === right.logicalRequestId &&
        left.apiIndex === right.apiIndex &&
        left.taskAttempt === right.taskAttempt &&
        left.providerAttempt === right.providerAttempt &&
        left.startedAtMs === right.startedAtMs &&
        left.startedMonotonicMs === right.startedMonotonicMs
    )
}

function readClock(clock: () => number, label: string): number {
    return readValue(clock(), label)
}

function readValue(value: number, label: string): number {
    if (!Number.isFinite(value) || value < 0) throw new Error(`API response execution ${label} must be non-negative and finite`)
    return value
}
