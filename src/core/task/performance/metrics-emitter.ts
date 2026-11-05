/**
 * The Task-side adapter that turns settled observations into neutral events.
 *
 * This is the only place a Task talks to metrics. It freezes the identity (workspace,
 * profile, provider, model, key fingerprint, round) at the moment the fact happened,
 * so a later Profile switch cannot rewrite who a historical number belonged to.
 *
 * Every method is synchronous and returns `void` on purpose. Metrics are not part of a
 * Task's business durability: awaiting a write here would make a turn depend on a disk.
 */

import type { MetricsQueueSink } from "@core/metrics/EventQueue"
import { offerGlobalMetrics } from "@core/metrics/GlobalMetricsRuntime"
import type { EmittedUsageQuality, MetricsEvent, UsageEvent } from "@shared/metrics/events"
import { usageKeyFingerprint } from "@shared/metrics/identity"
import type { PerformanceQuality } from "@shared/metrics/types"

/** Identity that is stable for one Task opening. */
export interface FrozenMetricsIdentity {
    readonly workspaceId: string
    readonly taskId: string
    readonly profileId: string
    readonly providerId: string
    readonly modelId: string
    /** The API key *fingerprint*, never the key itself. */
    readonly apiKey?: string
}

/** One settled usage observation for a single attempt. */
export interface SettledUsageObservation {
    readonly eventId: string
    readonly observedAtMs: number
    readonly roundId: string
    readonly logicalRequestId: string
    readonly sequence: number
    readonly inputTokens: number
    readonly outputTokens: number
    readonly thoughtsTokens?: number
    readonly cacheWriteTokens?: number
    readonly cacheReadTokens?: number
    readonly usageReported: boolean
    readonly cost?: number
    readonly currency?: string
    readonly costComplete: boolean
    readonly currencyMixed: boolean
    readonly usageQuality: EmittedUsageQuality
}

/** One settled performance observation. */
export interface SettledPerformanceObservation {
    readonly eventId: string
    readonly observedAtMs: number
    readonly roundId: string
    readonly logicalRequestId: string
    readonly sequence: number
    readonly factKind: "provider" | "execution"
    readonly executionId?: string
    readonly providerDurationMs?: number
    readonly executionDurationMs?: number
    readonly generationDurationMs?: number
    readonly ttftMs?: number
    readonly status: "completed" | "failed" | "cancelled" | "aborted"
    readonly perfQuality: PerformanceQuality
}

export interface MetricsEmitTarget {
    /** Another write path, used only when this observation must bypass the Task's own sink. */
    readonly sink?: MetricsQueueSink
    /** Overrides the model for one observation, used when a round switched models. */
    readonly modelId?: string
    readonly providerId?: string
    /**
     * Overrides the Profile that served this observation.
     *
     * A Task can switch Profile between sends, and the one that was frozen when the
     * Task opened is then not the one that served this request. The override is what
     * keeps the row attributed to the Profile that actually spent the tokens.
     */
    readonly profileId?: string
    /** The API key fingerprint of the Profile that served this observation. */
    readonly keyFingerprint?: string
}

/**
 * One Task's unified metrics write path.
 *
 * The owner starts it once and releases it *before* the Task's storage ownership is
 * handed over, because a worker still holding `metrics.db` would keep the file
 * undeletable on Windows.
 */
export interface TaskMetricsAttachment {
    readonly emitter: TaskMetricsEmitter
    /** Start the background writer. Must not be awaited on a hot path. */
    start(): void
    /** Stop the writer within its budget and report whether it really released. */
    release(): Promise<{ readonly released: boolean; readonly reason?: string }>
}

/**
 * Build one Task's attachment from a flush host.
 *
 * The emitter is created immediately (it is pure bookkeeping), while the worker is
 * started only when a caller asks for it. That keeps a Task that never records a
 * metric from paying worker startup or creating a database.
 */
export function attachTaskMetrics(options: {
    readonly identity: FrozenMetricsIdentity
    readonly host: {
        emit(event: MetricsEvent): void
        start(): Promise<void>
        stop(): Promise<{ released: boolean; reason?: string }>
    }
}): TaskMetricsAttachment {
    const { identity, host } = options
    return {
        emitter: new TaskMetricsEmitter(identity, {
            offer: (event) => {
                host.emit(event)
                return true
            },
        }),
        start() {
            void host.start().catch(() => undefined)
        },
        async release() {
            const result = await host.stop()
            return result.released
                ? { released: true }
                : { released: false, reason: result.reason ?? "metrics writer did not stop" }
        },
    }
}

/**
 * Emit events for one Task opening.
 *
 * A missing sink is a no-op, so a Task created before metrics are wired (or after they
 * were revoked) keeps working instead of failing on an absent dependency.
 */
export class TaskMetricsEmitter {
    private readonly identity: FrozenMetricsIdentity
    private readonly sink: MetricsQueueSink | undefined

    constructor(identity: FrozenMetricsIdentity, sink: MetricsQueueSink | undefined) {
        this.identity = identity
        this.sink = sink
    }

    /** The fingerprint of the key this Task is running with. */
    get keyFingerprint(): string {
        return usageKeyFingerprint(this.identity.apiKey)
    }

    /** Emit one settled usage snapshot. */
    emitUsage(observation: SettledUsageObservation, target?: MetricsEmitTarget): void {
        this.emit(
            {
                kind: "usage",
                ...this.identityOf(observation, target),
                inputTokens: observation.inputTokens,
                outputTokens: observation.outputTokens,
                ...(observation.thoughtsTokens === undefined ? {} : { thoughtsTokens: observation.thoughtsTokens }),
                ...(observation.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: observation.cacheWriteTokens }),
                ...(observation.cacheReadTokens === undefined ? {} : { cacheReadTokens: observation.cacheReadTokens }),
                usageReported: observation.usageReported,
                ...(observation.cost === undefined ? {} : { cost: observation.cost }),
                ...(observation.currency === undefined ? {} : { currency: observation.currency }),
                costComplete: observation.costComplete,
                currencyMixed: observation.currencyMixed,
                usageQuality: observation.usageQuality,
            },
            target,
        )
    }

    /** Emit one settled performance fact. */
    emitPerformance(observation: SettledPerformanceObservation, target?: MetricsEmitTarget): void {
        this.emit(
            {
                kind: "performance",
                ...this.identityOf(observation, target),
                factKind: observation.factKind,
                ...(observation.executionId === undefined ? {} : { executionId: observation.executionId }),
                ...(observation.providerDurationMs === undefined ? {} : { providerDurationMs: observation.providerDurationMs }),
                ...(observation.executionDurationMs === undefined
                    ? {}
                    : { executionDurationMs: observation.executionDurationMs }),
                ...(observation.generationDurationMs === undefined
                    ? {}
                    : { generationDurationMs: observation.generationDurationMs }),
                ...(observation.ttftMs === undefined ? {} : { ttftMs: observation.ttftMs }),
                status: observation.status,
                perfQuality: observation.perfQuality,
            },
            target,
        )
    }

    private emit(event: MetricsEvent, target: MetricsEmitTarget | undefined): void {
        const sink = target?.sink ?? this.sink
        sink?.offer(event)
        // The same fact belongs to both levels: the Task level records what this Task
        // did, and the global level accumulates what every Task of this process did.
        // Offering the already-built event keeps one identity for both rows, so the
        // global receipt deduplicates a retry by the same key the Task's own does.
        // A target that bypasses the Task's sink keeps the fact local on purpose.
        if (!target?.sink) offerGlobalMetrics(event)
    }

    private identityOf(
        observation: SettledUsageObservation | SettledPerformanceObservation,
        target: MetricsEmitTarget | undefined,
    ) {
        return {
            eventId: observation.eventId,
            observedAtMs: observation.observedAtMs,
            sequence: observation.sequence,
            workspaceId: this.identity.workspaceId,
            taskId: this.identity.taskId,
            profileId: target?.profileId ?? this.identity.profileId,
            providerId: target?.providerId ?? this.identity.providerId,
            modelId: target?.modelId ?? this.identity.modelId,
            keyFingerprint: target?.keyFingerprint ?? this.keyFingerprint,
            logicalRequestId: observation.logicalRequestId,
            roundId: observation.roundId,
        }
    }
}

/** Convert an emitted usage event back for tests and diagnostics. */
export function usageEventOf(observation: SettledUsageObservation, identity: FrozenMetricsIdentity): UsageEvent {
    const emitter = new TaskMetricsEmitter(identity, undefined)
    return {
        kind: "usage",
        eventId: observation.eventId,
        observedAtMs: observation.observedAtMs,
        sequence: observation.sequence,
        workspaceId: identity.workspaceId,
        taskId: identity.taskId,
        profileId: identity.profileId,
        providerId: identity.providerId,
        modelId: identity.modelId,
        keyFingerprint: emitter.keyFingerprint,
        logicalRequestId: observation.logicalRequestId,
        roundId: observation.roundId,
        inputTokens: observation.inputTokens,
        outputTokens: observation.outputTokens,
        ...(observation.thoughtsTokens === undefined ? {} : { thoughtsTokens: observation.thoughtsTokens }),
        ...(observation.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: observation.cacheWriteTokens }),
        ...(observation.cacheReadTokens === undefined ? {} : { cacheReadTokens: observation.cacheReadTokens }),
        usageReported: observation.usageReported,
        ...(observation.cost === undefined ? {} : { cost: observation.cost }),
        ...(observation.currency === undefined ? {} : { currency: observation.currency }),
        costComplete: observation.costComplete,
        currencyMixed: observation.currencyMixed,
        usageQuality: observation.usageQuality,
    }
}
