import type {
    PendingAttemptFinalization,
    UsageAttemptFinalizationStore,
} from "@/core/storage/telemetry-remote/UsageAttemptFinalizationStore"
import type {
    PendingUsageAttemptObservation,
    PendingUsageLogicalClaim,
} from "@/core/storage/telemetry-remote/UsageObservationSpool"
import type { ApiRequestRoundHandle } from "@/core/task/performance/api-request-round-tracker"
import type { ApiRequestRoundRecord } from "@/core/task/performance/api-request-round-types"
import type {
    ProviderAttemptRevision,
    ProviderAttemptUsageEvent,
    ProviderLogicalExecution,
} from "@/core/task/performance/provider-request-round-port"
import type { UsageFailureClass } from "../contracts/usageBodySchema"
import { projectFinalizedAttempt, projectLogicalExecution, type UsageAttemptObservation } from "./attemptProjection"

/** Bounded wait for a later exact-usage revision after a Provider terminal (usage-client-interface §4). */
export const DEFAULT_TOKEN_FINALIZATION_DEADLINE_MS = 10_000
/** A foreign shard's entry is recovered only this long after its deadline, so a live owner always finalizes first. */
export const TOKEN_FINALIZATION_RECOVERY_GRACE_MS = 60_000
/** Persistence is coalesced: the normal path (terminal, usage, final within milliseconds) writes nothing. */
export const FINALIZATION_PERSIST_DELAY_MS = 1_000
/** How long a failed spool append waits before its retry; the attempt stays recoverable meanwhile. */
export const APPEND_RETRY_DELAY_MS = 2_000
/** Retries after the first failure; a host that cannot write at all reports the loss instead of looping. */
const APPEND_RETRY_LIMIT = 3
/** Finalized IDs remembered for loss evidence and late logical claims. */
const REMEMBERED_FINALS = 4_096

/** Fires one attempt's token finalization at its deadline even when no further usage callback arrives. */
export interface UsageAttemptFinalizationClock {
    schedule(observationId: string, deadline: number, finalize: () => void): void
    cancel(observationId: string): void
}

/** Process timers; an unref'd timer never keeps the extension host alive. */
export function timerFinalizationClock(now: () => number = Date.now): UsageAttemptFinalizationClock {
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    return {
        schedule(observationId, deadline, finalize) {
            clearTimeout(timers.get(observationId))
            const timer = setTimeout(
                () => {
                    timers.delete(observationId)
                    finalize()
                },
                Math.max(0, deadline - now()),
            )
            timer.unref?.()
            timers.set(observationId, timer)
        },
        cancel(observationId) {
            clearTimeout(timers.get(observationId))
            timers.delete(observationId)
        },
    }
}

/** Durable destinations of final observations and late logical executions. */
export interface AttemptFinalizerSink {
    appendObservation(observation: PendingUsageAttemptObservation): Promise<void>
    appendLogicalClaim(claim: PendingUsageLogicalClaim): Promise<void>
}

export type AttemptFinalizerLog = (level: "debug" | "warn", message: string) => void

export interface AttemptFinalizerOptions {
    readonly store: Pick<UsageAttemptFinalizationStore, "save" | "readOverdue" | "removeRecovered" | "purge">
    readonly sink: AttemptFinalizerSink
    /** This process's Usage session; it rides on every observation and never leaves the device. */
    readonly localSessionId: string
    readonly now?: () => number
    readonly clock?: UsageAttemptFinalizationClock
    readonly tokenFinalizationDeadlineMs?: number
    readonly persistDelayMs?: number
    /** Delay before a failed spool append is attempted again. */
    readonly appendRetryDelayMs?: number
    readonly log?: AttemptFinalizerLog
}

interface PendingAttempt {
    readonly handle: ApiRequestRoundHandle
    readonly record: ApiRequestRoundRecord
    /** Fixed by the terminal; a later token revision never reclassifies the failure. */
    readonly failureClass?: UsageFailureClass
    readonly deadline: number
    readonly execution?: ProviderLogicalExecution
    readonly observation: UsageAttemptObservation
}

type TerminalEvent = Extract<ProviderAttemptUsageEvent, { kind: "terminal" }>

/**
 * Turns ordered Provider attempt facts into exactly one final observation per
 * real send (usage-client-interface §4, usage-client-lifecycle §8).
 *
 * A terminal opens a bounded finalization window. Within it, only strictly
 * higher token revisions are accepted; the window closes on an explicit final,
 * at its deadline, or at dispose, and the highest accepted revision becomes the
 * observation. A revision after that is loss evidence only. A logical execution
 * that settles inside the window rides on the observation; one that settles
 * later becomes a separate claim. Pending windows are persisted so another host
 * can finish them after a crash.
 */
export class AttemptFinalizer {
    private readonly pending = new Map<string, PendingAttempt>()
    private readonly finalized = new Set<string>()
    private readonly now: () => number
    private readonly clock: UsageAttemptFinalizationClock
    private readonly deadlineMs: number
    private readonly persistDelayMs: number
    private readonly appendRetryMs: number
    private readonly appendRetries = new Set<ReturnType<typeof setTimeout>>()
    /**
     * Observation appends still in flight, by observation ID.
     *
     * A late logical claim names an attempt whose observation carries its token
     * fact. The spool has no shared commit queue across the two append kinds, so a
     * claim that lands first is read by a fold that cannot find its attempt
     * checkpoint yet and is then discarded with the shard. Chaining the claim onto
     * this promise is what makes the dependency durable in-process.
     */
    private readonly observationAppends = new Map<string, Promise<void>>()
    private appending = 0
    private flushAppended: (() => void) | undefined
    private persistTimer: ReturnType<typeof setTimeout> | undefined
    private persistedPending = false
    private persisting: Promise<void> = Promise.resolve()
    private closed = false
    /** Purge revokes callbacks from the old consent epoch without permanently closing intake. */
    private generation = 0

    constructor(private readonly options: AttemptFinalizerOptions) {
        const deadlineMs = options.tokenFinalizationDeadlineMs ?? DEFAULT_TOKEN_FINALIZATION_DEADLINE_MS
        if (!Number.isFinite(deadlineMs) || deadlineMs <= 0)
            throw new Error("Token finalization deadline must be finite and positive")
        this.deadlineMs = deadlineMs
        this.persistDelayMs = options.persistDelayMs ?? FINALIZATION_PERSIST_DELAY_MS
        this.appendRetryMs = options.appendRetryDelayMs ?? APPEND_RETRY_DELAY_MS
        this.now = options.now ?? Date.now
        this.clock = options.clock ?? timerFinalizationClock(this.now)
    }

    record(event: ProviderAttemptUsageEvent): void {
        if (this.closed) return
        switch (event.kind) {
            case "terminal":
                this.terminal(event)
                return
            case "tokens":
                this.revise(event)
                return
            case "tokens_final":
                this.finalize(event.roundId)
                return
            case "logical_execution":
                this.settleLogical(event)
                return
        }
    }

    /** Finish foreign shards' windows whose owner is gone; returns how many observations were recovered. */
    async recoverOverdue(): Promise<number> {
        const now = this.now()
        let recovered = 0
        for (const shard of await this.options.store.readOverdue(now, TOKEN_FINALIZATION_RECOVERY_GRACE_MS)) {
            await Promise.all(shard.entries.map((entry) => this.options.sink.appendObservation(recoveredObservation(entry, now))))
            await this.options.store.removeRecovered(
                shard.shard,
                shard.entries.map((entry) => entry.observationId),
            )
            recovered += shard.entries.length
        }
        return recovered
    }

    /** Write the current pending set now instead of after the coalescing delay. */
    flush(): Promise<void> {
        if (this.persistTimer) {
            clearTimeout(this.persistTimer)
            this.persistTimer = undefined
        }
        this.persist()
        return this.persisting
    }

    /**
     * No revision can follow in a closing host, so every open window is final now.
     * Appends already in flight are awaited: a closing host must not drop the last
     * copy of an attempt it has just finalized.
     */
    async dispose(): Promise<void> {
        if (this.closed) return
        this.closed = true
        for (const observationId of [...this.pending.keys()]) this.finalize(observationId)
        await this.waitForAppends()
        await this.flush()
    }

    /** Drop every open window and its persisted deadline without emitting; intake may resume later. */
    async purge(): Promise<void> {
        this.generation += 1
        for (const observationId of this.pending.keys()) this.clock.cancel(observationId)
        for (const retry of this.appendRetries) clearTimeout(retry)
        this.appendRetries.clear()
        this.pending.clear()
        this.finalized.clear()
        if (this.persistTimer) {
            clearTimeout(this.persistTimer)
            this.persistTimer = undefined
        }
        this.persistedPending = false
        await this.persisting
        await this.waitForAppends()
        this.observationAppends.clear()
        await this.options.store.purge()
    }

    private terminal({ handle, record, failureClass }: TerminalEvent): void {
        const observationId = handle.roundId
        if (this.finalized.has(observationId)) {
            this.log("debug", "usage attempt terminal arrived after finalization; ignored")
            return
        }
        const existing = this.pending.get(observationId)
        if (existing) {
            // Terminal is idempotent; a different second terminal is a producer conflict, never a rewrite.
            if (existing.record.status !== record.status) {
                this.log("warn", `usage attempt terminal conflict (${existing.record.status} then ${record.status}); first kept`)
            }
            return
        }
        const observation = this.project({ handle, record, failureClass })
        if (!observation) return
        const deadline = this.now() + this.deadlineMs
        this.pending.set(observationId, { handle, record, failureClass, deadline, observation })
        this.clock.schedule(observationId, deadline, () => this.finalize(observationId))
        this.schedulePersist()
    }

    private revise({ handle, record }: ProviderAttemptRevision): void {
        const observationId = handle.roundId
        const entry = this.pending.get(observationId)
        if (!entry) {
            if (this.finalized.has(observationId)) {
                this.log("debug", "usage token revision arrived after finalization; kept as loss evidence only")
            }
            return
        }
        if (record.revision <= entry.record.revision) return
        const observation = this.project({ ...entry, handle, record })
        if (!observation) return
        this.pending.set(observationId, { ...entry, handle, record, observation })
        this.schedulePersist()
    }

    private settleLogical(execution: ProviderLogicalExecution): void {
        const observationId = execution.handle.roundId
        const entry = this.pending.get(observationId)
        if (entry) {
            const observation = this.project({ ...entry, execution })
            if (!observation) return
            this.pending.set(observationId, { ...entry, execution, observation })
            this.schedulePersist()
            return
        }
        // An attempt never admitted here (reporting was off, or its projection failed) has no fact to claim.
        if (!this.finalized.has(observationId)) return
        let projected: PendingUsageLogicalClaim["execution"]
        try {
            projected = projectLogicalExecution(execution.handle, execution.execution, execution.toolCalls)
        } catch (error) {
            this.log("warn", `late logical execution was rejected before storage: ${describe(error)}`)
            return
        }
        const claim: PendingUsageLogicalClaim = {
            logicalRequestId: execution.handle.logicalRequestId,
            attemptObservationId: observationId,
            receivedAt: this.now(),
            execution: projected,
        }
        // The finalizer remembers an attempt it already published, and that append is
        // the only place the claim's checkpoint can come from.
        this.track(this.appendClaimAfterObservation(observationId, claim) ?? this.options.sink.appendLogicalClaim(claim))
    }

    /**
     * Close one window and publish its observation.
     *
     * The recovery record is the only copy of an attempt that has not reached the
     * spool yet, so it is released only after the append resolved. A failed append
     * keeps the attempt pending and schedules one bounded retry; the observation ID
     * and revision make the eventual append idempotent, so a retry after a write
     * that did land cannot double-count.
     */
    private finalize(observationId: string): void {
        const entry = this.pending.get(observationId)
        if (!entry) return
        const observation: PendingUsageAttemptObservation = {
            id: observationId,
            revision: entry.record.revision,
            receivedAt: this.now(),
            localSessionId: this.options.localSessionId,
            observation: entry.observation,
        }
        this.pending.delete(observationId)
        this.clock.cancel(observationId)
        this.remember(observationId)
        this.publish(observationId, observation, entry, 0)
        this.schedulePersist()
    }

    private publish(
        observationId: string,
        observation: PendingUsageAttemptObservation,
        entry: PendingAttempt,
        failures: number,
    ): void {
        const generation = this.generation
        this.appendStarted()
        const append = this.options.sink.appendObservation(observation).then(
            () => {
                this.appendSettled()
                if (generation !== this.generation) return
                this.observationAppends.delete(observationId)
                // A retried append succeeded: the spool now holds the only required copy, so the
                // recovery record must stop describing this attempt before its deadline recurs.
                this.releasePending(observationId)
            },
            (error: unknown) => {
                this.appendSettled()
                if (generation !== this.generation) return
                this.observationAppends.delete(observationId)
                this.log("warn", `finalized usage was not stored: ${describe(error)}`)
                if (this.closed || failures >= APPEND_RETRY_LIMIT) {
                    // The window is over and the copy could not be written: keep the loss visible
                    // instead of pretending the attempt was delivered.
                    this.log("warn", "finalized usage was lost: its observation could not be stored")
                    return
                }
                this.restorePending(observationId, entry)
                // A retry that runs after a failed append must still be the copy its claim waits on.
                this.retryAppend(observationId, observation, entry, failures + 1)
            },
        )
        this.observationAppends.set(observationId, append)
    }

    /**
     * Append a late claim only after the observation it names is durable.
     *
     * The claim and the observation are separate files in the spool. A fold that
     * sees the claim without the attempt checkpoint skips it and still discards
     * that shard, so the request would never be reported (usage-client-lifecycle
     * §9). Awaiting the named append here removes that ordering window; a claim
     * whose observation never became durable is not written at all.
     */
    private appendClaimAfterObservation(observationId: string, claim: PendingUsageLogicalClaim): Promise<void> | undefined {
        const appended = this.observationAppends.get(observationId)
        if (!appended) return undefined
        const generation = this.generation
        this.appendStarted()
        appended.then(
            () => this.appendSettled(),
            () => this.appendSettled(),
        )
        return appended.then(() => {
            if (generation !== this.generation) return
            return this.options.sink.appendLogicalClaim(claim)
        })
    }

    /** Make the attempt recoverable again while a failed append is retried. */
    private restorePending(observationId: string, entry: PendingAttempt): void {
        this.finalized.delete(observationId)
        if (this.pending.has(observationId)) return
        this.pending.set(observationId, entry)
        this.clock.schedule(observationId, this.now() + this.deadlineMs, () => this.finalize(observationId))
        this.schedulePersist()
    }

    /** Drop a restored window once its observation is durable; the first attempt already closed it. */
    private releasePending(observationId: string): void {
        if (!this.pending.delete(observationId)) return
        this.clock.cancel(observationId)
        this.schedulePersist()
    }

    private retryAppend(
        observationId: string,
        observation: PendingUsageAttemptObservation,
        entry: PendingAttempt,
        failures: number,
    ): void {
        const timer = setTimeout(() => {
            this.appendRetries.delete(timer)
            if (this.closed) return
            this.publish(observationId, observation, entry, failures)
        }, this.appendRetryMs)
        timer.unref?.()
        this.appendRetries.add(timer)
    }

    /** Appends still running; shutdown waits for them so a closing host does not drop a copy. */
    private appendStarted(): void {
        this.appending += 1
    }

    private appendSettled(): void {
        this.appending -= 1
        if (this.appending === 0) this.flushAppended?.()
    }

    private waitForAppends(): Promise<void> {
        if (this.appending === 0) return Promise.resolve()
        return new Promise<void>((resolve) => {
            this.flushAppended = resolve
        })
    }

    private project({
        handle,
        record,
        failureClass,
        execution,
    }: Pick<PendingAttempt, "handle" | "record" | "failureClass" | "execution">): UsageAttemptObservation | undefined {
        try {
            const observation = projectFinalizedAttempt(handle, record, execution?.execution, execution?.toolCalls)
            // Every failed attempt adds exactly one error; an unclassified failure is `unknown`, never uncounted.
            return record.status === "failed" ? { ...observation, failureClass: failureClass ?? "unknown" } : observation
        } catch (error) {
            this.log("warn", `usage attempt was rejected before storage: ${describe(error)}`)
            return undefined
        }
    }

    private schedulePersist(): void {
        if (this.persistTimer || this.closed) return
        this.persistTimer = setTimeout(() => {
            this.persistTimer = undefined
            this.persist()
        }, this.persistDelayMs)
        this.persistTimer.unref?.()
    }

    private persist(): void {
        const entries: PendingAttemptFinalization[] = [...this.pending.entries()].map(([observationId, entry]) => ({
            observationId,
            deadline: entry.deadline,
            revision: entry.record.revision,
            localSessionId: this.options.localSessionId,
            observation: entry.observation,
        }))
        if (entries.length === 0 && !this.persistedPending) return
        this.persistedPending = entries.length > 0
        this.persisting = this.persisting
            .then(() => this.options.store.save(entries))
            .catch((error: unknown) => this.log("warn", `usage finalization deadlines were not stored: ${describe(error)}`))
    }

    private track(append: Promise<void>): void {
        append.catch((error: unknown) => this.log("warn", `finalized usage was not stored: ${describe(error)}`))
    }

    private remember(observationId: string): void {
        this.finalized.add(observationId)
        if (this.finalized.size <= REMEMBERED_FINALS) return
        const oldest = this.finalized.values().next().value
        if (oldest !== undefined) this.finalized.delete(oldest)
    }

    private log(level: "debug" | "warn", message: string): void {
        this.options.log?.(level, message)
    }
}

function recoveredObservation(entry: PendingAttemptFinalization, now: number): PendingUsageAttemptObservation {
    return {
        id: entry.observationId,
        revision: entry.revision,
        receivedAt: now,
        localSessionId: entry.localSessionId,
        observation: entry.observation,
    }
}

/** Error class and code only: messages may carry paths or provider text. */
function describe(error: unknown): string {
    if (!(error instanceof Error)) return typeof error
    const code = (error as NodeJS.ErrnoException).code
    return code ? `${error.name} ${code}` : error.name
}
