import type {
    CompactionExecutionInput,
    CompactionExecutionResult,
    CompactionPort,
} from "../executors/compaction/CompactionCommandExecutor"
import type { ComposeCompactionBarrierPort, RoundReadiness } from "../executors/compose/ProductionComposeAdapter"
import type { TaskState } from "../kernel"
import type { ActiveTaskSession } from "../session/ActiveTaskSession"
import type { LifecycleBarrierPort } from "../session/TaskInputAdmission"
import type { ContextPressureObserverPort } from "../session/TaskProviderRequestReporter"
import type { CompactionTrigger, LifecycleCommand } from "../stores/payload/TaskPayloadEnvelopes"
import { shouldCompactAutomatically } from "./AutomaticCompactionPolicy"
import {
    AUTOMATIC_COMPACTION_FAILED,
    automaticCompactionFailureAwaitsRecovery,
    type CompactionRecoveryPort,
    type CompactionRunOutcome,
} from "./CompactionRecovery"
import type { AdmissionCompaction, AdmissionCompactionPort } from "./FinalContextWindowGuard"
import type { CompactionReviewSlotPort } from "./InteractionCompactionReview"
import { COMPACTION_FAILURE_MESSAGE } from "./MessageStateCompactionFailure"
import { NOTHING_TO_COMPACT, requestTaskCompaction } from "./TaskCompactionRequest"

/** The catalog identity of the manual compaction command and its aliases. */
export const COMPACT_COMMAND_ID = "command.compact"

const ROUND_READY: RoundReadiness = { kind: "ready" }

export { AUTOMATIC_COMPACTION_FAILED } from "./CompactionRecovery"

/** Why a round stopped after the automatic compaction it waited on was cancelled or abandoned. */
export const AUTOMATIC_COMPACTION_WITHDRAWN = "automatic_compaction_withdrawn"

/** Why a round stopped after the `/compact` it owed failed once its retries ran out. */
export const MANUAL_COMPACTION_FAILED = "manual_compaction_failed"

interface CompactionRunResult {
    readonly outcome: CompactionRunOutcome
    /** Why a run that ran failed, in the words its failure card used. */
    readonly error?: string
    /** No run was needed because nothing answered exists to condense. */
    readonly nothingToCompact?: boolean
}

/**
 * Learns when a compaction run has finished.
 *
 * The observer wraps the executor's port rather than the provider service, so
 * settlement means the whole run is done - summary landed in the conversation
 * included - not merely that the provider answered.
 */
export interface CompactionSettlementObserverPort {
    instrument(port: CompactionPort): CompactionPort
}

export interface CompactionRoundBarrierOptions {
    readonly session: () => ActiveTaskSession | undefined
    readonly state: () => Readonly<TaskState>
    /** Whether the user allows the task to compact on its own; defaults to allowed. */
    readonly enabled?: () => boolean
    /** Reports a scheduling failure; compaction must not break the round that waited for it. */
    readonly onFailure?: (message: string) => void
}

interface ObservedPressure {
    readonly contextTokens: number
    readonly compactTriggerTokens: number
}

/**
 * Condenses the conversation at the barrier before the next round is composed.
 *
 * Two causes owe a round a compaction. Context pressure is only knowable after
 * a request settles, so a settled request records what it observed and the
 * next round waits for the summary first - the request that follows is the one
 * that fits. A `/compact` the user placed is carried by the input that named
 * it, so it runs before the round that admits that input, and that round only
 * goes ahead once the compaction did what the user asked.
 *
 * The barrier belongs to compose rather than to user submission, because a
 * round can also be opened by the kernel continuing a turn; a barrier that only
 * guarded submissions would let every continued round skip it.
 */
export class CompactionRoundBarrier
    implements
        ContextPressureObserverPort,
        ComposeCompactionBarrierPort,
        CompactionSettlementObserverPort,
        LifecycleBarrierPort,
        CompactionRecoveryPort,
        AdmissionCompactionPort,
        CompactionReviewSlotPort
{
    private observed: ObservedPressure | undefined
    /** The last round stopped on a failed automatic compaction and has not been retried. */
    private stoppedOnFailure = false
    /** The round being composed already compacted, so it must not summarize its own summary. */
    private compactedThisRound = false
    /** The next round is the failed one the user recovered by explicitly truncating. */
    private recoveredByTruncation = false
    /** A `/compact` typed into a dialog reply, owed to the round that reply opens. */
    private replied: { readonly command: LifecycleCommand; readonly generation: number } | undefined
    /**
     * A `/compact` whose run failed, owed to the round the user retries.
     *
     * Its input was released when the round gave up, so nothing else would
     * carry the command - or the guidance typed with it - into that round.
     * Bound to the generation it failed in, so a stop retires it, and retired
     * when the user dismisses the failure instead of retrying it.
     */
    private failedManual: { readonly command: LifecycleCommand; readonly generation: number } | undefined
    /** A `/compact` performed beside an open dialog, still owed to the round that dialog's answer opens. */
    private beside: string | undefined
    /** Rounds waiting on a run, keyed by the run so a stale one only releases its own waiter. */
    private readonly waiters = new Map<string, RunWaiter>()
    /** The last run that ended before any round waited on it. */
    private unclaimed: { readonly compactionId: string; readonly result: CompactionRunResult } | undefined
    /** Runs a round is held for before it is drafted, so that round cannot end on a dialog first. */
    private readonly holding = new Set<string>()
    /** Reviews waiting for the dialog slot; each re-checks it on every commit and hold. */
    private readonly reviewWaiters = new Set<() => void>()

    constructor(private readonly options: CompactionRoundBarrierOptions) {}

    observe(pressure: ObservedPressure): void {
        this.observed = pressure
    }

    owns(commandId: string): boolean {
        return commandId === COMPACT_COMMAND_ID
    }

    truncationOffered(): boolean {
        return this.stoppedOnFailure || automaticCompactionFailureAwaitsRecovery(this.options.state())
    }

    async settlement(compactionId: string): Promise<CompactionRunOutcome> {
        return (await this.awaitRun(compactionId, new AbortController().signal)).outcome
    }

    truncated(): void {
        this.observed = undefined
        this.stoppedOnFailure = false
        this.recoveredByTruncation = true
    }

    /**
     * Release every round waiting on a run the kernel no longer has in flight.
     *
     * A round waits for its compaction without a deadline, as dev does: the
     * request it is clearing room for must not be sent before the summary lands.
     * A run can still end without reporting back - the kernel expires an
     * abandoned slot when a halt completes, or the executor is fenced before it
     * starts - and only the committed state says so. Completed and failed runs
     * never reach this path: their executor settles the waiter before it submits
     * the terminal event the kernel commits.
     *
     * Committed states are published after their durable write, so one can
     * arrive after a round began waiting yet predate the request it waits on.
     * Its slot then still holds the previous run - a failed `/compact` the user
     * is retrying, say - which says nothing about this run.
     */
    committed(state: Readonly<TaskState>): void {
        if (this.failedManual && dismissedFailure(state)) this.failedManual = undefined
        for (const [compactionId, waiter] of [...this.waiters]) {
            if (state.revision < waiter.since || !isAbandoned(state, compactionId)) continue
            this.waiters.delete(compactionId)
            waiter.release({ outcome: "withdrawn" })
        }
        this.wakeReviews()
    }

    /**
     * Wait until a review of this run may take the dialog slot.
     *
     * A `/compact` performed beside a round in flight produces its summary while
     * that round goes on, and the round may still end on a dialog of its own -
     * one the kernel refuses while a review holds the slot. So the review waits
     * until the round is held for this run, or the task stops running and waits
     * for the user; then the slot is free or holds a waiting dialog the review
     * can interrupt.
     */
    async reviewable(compactionId: string, signal: AbortSignal): Promise<void> {
        while (!reviewSlotOpen(this.options.state(), this.holding.has(compactionId))) {
            if (signal.aborted) throw signal.reason
            await new Promise<void>((resolve) => {
                const wake = () => {
                    this.reviewWaiters.delete(wake)
                    signal.removeEventListener("abort", wake)
                    resolve()
                }
                this.reviewWaiters.add(wake)
                signal.addEventListener("abort", wake, { once: true })
            })
        }
        if (signal.aborted) throw signal.reason
    }

    /**
     * Compact for a round whose complete request measured over the trigger.
     *
     * The round already passed this barrier on the last request's usage; the
     * measurement of the request itself is the final word, but a round that
     * already compacted goes ahead rather than condensing its own summary.
     */
    async compactForAdmission(signal: AbortSignal): Promise<AdmissionCompaction> {
        const session = this.options.session()
        if (!session || this.compactedThisRound || this.options.enabled?.() === false) return { kind: "skipped" }
        this.compactedThisRound = true
        const result = await this.compact(session, "automatic", signal)
        if (result.nothingToCompact) return { kind: "nothing_to_compact" }
        if (result.outcome === "completed") return { kind: "completed" }
        if (result.outcome === "withdrawn") return { kind: "withdrawn" }
        if (result.outcome !== "failed") return { kind: "skipped" }
        this.stoppedOnFailure = true
        return { kind: "failed", error: result.error ?? COMPACTION_FAILURE_MESSAGE }
    }

    /**
     * Hold a `/compact` that arrived in an accepted dialog reply.
     *
     * A reply is not an intake entry, so no round admits it; the command is owed
     * to the round the reply opens instead. It is bound to the generation it was
     * accepted in, so a stop between the reply and that round retires it rather
     * than letting a later, unrelated round carry it out.
     */
    request(command: LifecycleCommand): void {
        if (!this.owns(command.commandId)) return
        this.replied = { command, generation: this.options.state().generation }
    }

    /**
     * Compact now, for a `/compact` sent on its own while a dialog waits.
     *
     * No round is owed anything, so this schedules the run exactly as the header
     * control does and does not wait for it: the summary lands beside the open
     * dialog, whose answer stays the user's. The open turn is not condensed, so
     * the call that dialog answers is still there when the answer arrives.
     */
    async perform(command: LifecycleCommand): Promise<boolean> {
        const session = this.options.session()
        if (!this.owns(command.commandId) || !session) return false
        const guidance = command.premessage.trim()
        try {
            const request = await requestTaskCompaction(session, {
                stateRevision: this.options.state().revision,
                mode: "summarize",
                trigger: "manual",
                ...(guidance ? { guidance } : {}),
            })
            if (!request.accepted) this.options.onFailure?.(`manual compaction not scheduled: ${request.result}`)
            else this.beside = request.compactionId
            return request.accepted
        } catch (error) {
            this.options.onFailure?.(`manual compaction not scheduled: ${error instanceof Error ? error.message : String(error)}`)
            return false
        }
    }

    /**
     * Observe when a compaction run finishes, and how.
     *
     * The barrier waits for the run itself rather than for a kernel revision,
     * because compose and compaction are independent executor domains: a round
     * being composed cannot wait on a revision that includes itself.
     */
    instrument(port: CompactionPort): CompactionPort {
        return {
            run: async (input: CompactionExecutionInput): Promise<CompactionExecutionResult> => {
                let settled: CompactionRunResult = { outcome: "failed" }
                try {
                    const result = await port.run(input)
                    settled = { outcome: "completed" }
                    // The pressure was measured on the conversation this run just
                    // replaced, so it no longer says anything about the next round.
                    this.observed = undefined
                    this.stoppedOnFailure = false
                    return result
                } catch (error) {
                    // A stop is the user's own decision, not a failure.
                    if (input.signal.aborted) settled = { outcome: "withdrawn" }
                    else if (error instanceof Error && error.message.trim())
                        settled = { outcome: "failed", error: error.message.trim() }
                    throw error
                } finally {
                    this.settle(input.compactionId, settled)
                }
            },
        }
    }

    /**
     * Run what the round owes before it is drafted.
     *
     * A compaction the user asked for comes first and replaces any automatic
     * one: it condenses the same conversation, and running both would summarize
     * a summary. Its outcome decides the round - the user asked for a smaller
     * context before going on, so a failed or withdrawn one gives the round up.
     *
     * An automatic run that failed stops the round too: the request it was
     * clearing room for would not fit, and the user is the one to retry. The
     * pressure stays recorded so the round that retries compacts again. One that
     * was cancelled or abandoned stops it the same way, as dev does, rather than
     * sending the request it was meant to make room for.
     *
     * The automatic decision reads only the pressure providers reported, as
     * dev's pre-request check does. What the round adds on top - tool results,
     * the answer replayed as input, the environment - is measured on the
     * complete request by the final context-window guard, which compacts when
     * that request would not fit. Adding a separate estimate of the same growth
     * here compacted rounds whose request still fit.
     */
    async settleBeforeRound(input: {
        readonly signal: AbortSignal
        readonly lifecycle: readonly LifecycleCommand[]
    }): Promise<RoundReadiness> {
        // The dialog stayed answerable while that run went on, so its answer can
        // open a round before the summary lands; the round still goes after it.
        const beside = this.beside
        this.beside = undefined
        const besideCompleted = beside ? (await this.awaitRun(beside, input.signal, true)).outcome === "completed" : false
        if (input.signal.aborted) return { kind: "withdrawn", reason: "manual_compaction_withdrawn" }
        const replied = this.takeReplied()
        const retried = this.takeFailedManual()
        const manual = mergeOwedCompactions([
            ...(retried ? [retried] : []),
            ...input.lifecycle.filter((command) => this.owns(command.commandId)),
            ...(replied ? [replied] : []),
        ])
        const observed = this.observed
        // Consumed whatever the outcome: a refused or failed compaction must not
        // make every later round retry the same request forever.
        this.observed = undefined
        // This is the round the user chose to go on with instead of truncating.
        this.stoppedOnFailure = false
        // A successful explicit truncation belongs to this retried round. Consume
        // it once so the final guard sends the truncated conversation instead of
        // immediately compacting again from the previous request's stale usage.
        this.compactedThisRound = this.recoveredByTruncation || besideCompleted
        this.recoveredByTruncation = false
        const session = this.options.session()
        if (!session) return ROUND_READY
        if (manual) {
            this.compactedThisRound = true
            const result = await this.compact(session, "manual", input.signal, manual.premessage)
            if (result.outcome === "completed") return ROUND_READY
            // A run that failed after its retries is an error the user can retry,
            // as dev offers Retry and Start New Task; a stop or a refused schedule
            // is not, and simply gives the round up.
            if (result.outcome !== "failed") return { kind: "withdrawn", reason: `manual_compaction_${result.outcome}` }
            this.failedManual = { command: manual, generation: this.options.state().generation }
            return {
                kind: "failed",
                reason: MANUAL_COMPACTION_FAILED,
                presentation: result.error ?? COMPACTION_FAILURE_MESSAGE,
            }
        }
        if (!observed || this.options.enabled?.() === false) return ROUND_READY
        if (!shouldCompactAutomatically(this.options.state(), observed)) return ROUND_READY
        this.compactedThisRound = true
        const result = await this.compact(session, "automatic", input.signal)
        if (result.outcome === "withdrawn") return { kind: "withdrawn", reason: AUTOMATIC_COMPACTION_WITHDRAWN }
        if (result.outcome !== "failed") return ROUND_READY
        this.observed ??= observed
        this.stoppedOnFailure = true
        return {
            kind: "failed",
            reason: AUTOMATIC_COMPACTION_FAILED,
            presentation: result.error ?? COMPACTION_FAILURE_MESSAGE,
        }
    }

    /** A reply's command, unless a stop since it was accepted retired it. */
    private takeReplied(): LifecycleCommand | undefined {
        const replied = this.replied
        this.replied = undefined
        return replied && replied.generation === this.options.state().generation ? replied.command : undefined
    }

    /** A failed `/compact`, unless a stop since it failed retired it. */
    private takeFailedManual(): LifecycleCommand | undefined {
        const failed = this.failedManual
        this.failedManual = undefined
        return failed && failed.generation === this.options.state().generation ? failed.command : undefined
    }

    private async compact(
        session: ActiveTaskSession,
        trigger: Exclude<CompactionTrigger, "transition">,
        signal: AbortSignal,
        guidance?: string,
    ): Promise<CompactionRunResult> {
        let compactionId: string
        try {
            const request = await requestTaskCompaction(session, {
                stateRevision: this.options.state().revision,
                mode: "summarize",
                trigger,
                ...(guidance ? { guidance } : {}),
            })
            if (!request.accepted || !request.compactionId) {
                this.options.onFailure?.(`${trigger} compaction not scheduled: ${request.result}`)
                // Nothing settled yet means the context is already as small as it gets.
                return request.result === NOTHING_TO_COMPACT
                    ? { outcome: "completed", nothingToCompact: true }
                    : { outcome: "refused" }
            }
            compactionId = request.compactionId
        } catch (error) {
            this.options.onFailure?.(
                `${trigger} compaction not scheduled: ${error instanceof Error ? error.message : String(error)}`,
            )
            return { outcome: "refused" }
        }
        return await this.awaitRun(compactionId, signal, true)
    }

    /**
     * Wait for one run by identity, with no deadline.
     *
     * A stopped round stops waiting even if the run never reports back, because
     * the stop may have fenced it before it could; a run the kernel has already
     * abandoned releases the round through `committed`. A round that waits holds
     * the run, which is what lets that run's review open.
     */
    private async awaitRun(compactionId: string, signal: AbortSignal, holdsRound = false): Promise<CompactionRunResult> {
        if (!holdsRound) return await this.awaitSettled(compactionId, signal)
        this.holding.add(compactionId)
        this.wakeReviews()
        try {
            return await this.awaitSettled(compactionId, signal)
        } finally {
            this.holding.delete(compactionId)
        }
    }

    private async awaitSettled(compactionId: string, signal: AbortSignal): Promise<CompactionRunResult> {
        const unclaimed = this.unclaimed
        if (unclaimed?.compactionId === compactionId) {
            this.unclaimed = undefined
            return unclaimed.result
        }
        // The live state already holds the accepted request, so it can judge the
        // run now; only commits at least this recent may judge it later.
        const current = this.options.state()
        if (isAbandoned(current, compactionId)) return { outcome: "withdrawn" }
        const settled = new Promise<CompactionRunResult>((release) =>
            this.waiters.set(compactionId, { release, since: current.revision }),
        )
        try {
            return await untilAborted(settled, signal)
        } finally {
            this.waiters.delete(compactionId)
        }
    }

    private wakeReviews(): void {
        for (const wake of [...this.reviewWaiters]) wake()
    }

    private settle(compactionId: string, result: CompactionRunResult): void {
        const waiter = this.waiters.get(compactionId)
        if (waiter) {
            this.waiters.delete(compactionId)
            waiter.release(result)
            return
        }
        this.unclaimed = { compactionId, result }
    }
}

interface RunWaiter {
    readonly release: (result: CompactionRunResult) => void
    /** The live revision when the round began waiting; older commits predate its request. */
    readonly since: number
}

/**
 * Fold every compaction a round owes into the one run it performs.
 *
 * Several accepted inputs, or an input and a dialog reply, can each ask for
 * `/compact` before the same round. They condense the same conversation, so
 * one run serves them all, but each carried its own guidance and taking only
 * the first silently dropped the others. Guidance is kept in causal order.
 */
function mergeOwedCompactions(owed: readonly LifecycleCommand[]): LifecycleCommand | undefined {
    const [first] = owed
    if (!first) return undefined
    const guidance = owed.map((command) => command.premessage.trim()).filter((text) => text.length > 0)
    return { ...first, premessage: guidance.join("\n\n") }
}

/**
 * Whether the kernel's compaction slot shows this run will never report back.
 *
 * The slot has moved on to another run, or holds this one in a terminal status
 * its executor did not settle. An empty slot proves nothing either way, so the
 * round keeps waiting on the run or on its own stop.
 */
function isAbandoned(state: Readonly<TaskState>, compactionId: string): boolean {
    const compaction = state.flow.compaction
    if (!compaction) return false
    if (compaction.compactionId !== compactionId) return true
    return compaction.status !== "scheduled" && compaction.status !== "running"
}

/**
 * Whether a review may take the dialog slot now.
 *
 * A round held for this run waits on it, so nothing else can claim the slot
 * meanwhile. One dialog that waits for the user offers the slot whatever the
 * phase: a tool-owned dialog keeps its round running while it waits, and that
 * round cannot end on another dialog before this one is answered, so the review
 * interrupts it until it is resolved. With no dialog, a round in flight may
 * still end on one, so only a task that waits for the user offers a free slot.
 */
function reviewSlotOpen(state: Readonly<TaskState>, roundHeld: boolean): boolean {
    if (roundHeld) return true
    const primary = state.dialog.primary
    if (primary) return primary.status === "awaiting" && !state.dialog.interrupted
    return state.flow.phase !== "running" && state.flow.phase !== "initializing"
}

/**
 * Whether the user dismissed the failure that stopped the round.
 *
 * Dismissing hands the task back with one ordinary reply instead of retrying
 * the round, so a `/compact` that failed in it is no longer owed to anything.
 */
function dismissedFailure(state: Readonly<TaskState>): boolean {
    return state.flow.phase === "waiting" && state.flow.replyAdmission === "profile_recovery"
}

/** Resolve with the run's result, or as withdrawn as soon as the signal aborts. */
async function untilAborted(promise: Promise<CompactionRunResult>, signal: AbortSignal): Promise<CompactionRunResult> {
    if (signal.aborted) return { outcome: "withdrawn" }
    let release: () => void = () => undefined
    const aborted = new Promise<CompactionRunResult>((resolve) => {
        release = () => resolve({ outcome: "withdrawn" })
    })
    signal.addEventListener("abort", release, { once: true })
    try {
        return await Promise.race([promise, aborted])
    } finally {
        signal.removeEventListener("abort", release)
    }
}
