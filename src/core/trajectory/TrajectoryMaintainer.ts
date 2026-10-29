import type { UiAsk } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import {
    isCurrentTrajectory,
    stampOf,
    type TrajectoryJob,
    type TrajectoryMeta,
    type TrajectoryMetaUpdate,
    type TrajectoryRowStore,
    type TrajectorySnapshot,
    type TrajectoryTurn,
    type TrajectoryTurnInput,
    type TrajectoryWriteResult,
} from "../storage/trajectory/TrajectoryRowStore"
import type { CommittedUiMessages } from "./CommittedUiMessages"
import {
    carryAfterTurn,
    closeOpenTurn,
    EMPTY_FOLD_CARRY,
    type FoldCarry,
    type FoldedTurn,
    foldTrajectory,
} from "./foldTrajectory"

/**
 * Version of the fold rules; stored turns built by another version are discarded and rebuilt.
 *
 * 2: renamed tools are counted under their current name instead of their former row key.
 */
export const TRAJECTORY_BUILDER_VERSION = 2

/** Rows read per slice, so a catch-up never holds a long history in memory. */
export const TRAJECTORY_SLICE_ROWS = 500

/** How often a fold violation may be dropped because the head moved before it is believed. */
const MAX_UNSTABLE_VIOLATION_RETRIES = 3
const INITIAL_BACKOFF_MS = 250
const MAX_BACKOFF_MS = 4_000
const FOREIGN_JOB_POLL_MS = 1_000
const FOREIGN_JOB_TAKEOVER_MS = 5_000

/** The parts of the trajectory store the maintainer uses. */
export type TrajectoryStore = Pick<
    TrajectoryRowStore,
    "readMeta" | "readSnapshot" | "readTurn" | "findTurnContaining" | "replaceFrom" | "updateMeta" | "clear" | "close"
>

/** Whether this window may write the task's trajectory now; asked before every write transaction. */
export interface TrajectoryWriteAccess {
    writable(): boolean
}

export interface MaintainerClock {
    now(): number
    /** Resolves after `ms`, or early when `signal` aborts. */
    sleep(ms: number, signal: AbortSignal): Promise<void>
}

const REAL_CLOCK: MaintainerClock = {
    now: () => Date.now(),
    sleep: (ms, signal) =>
        new Promise<void>((resolve) => {
            if (signal.aborted) return resolve()
            const timer = setTimeout(done, ms)
            function done() {
                clearTimeout(timer)
                signal.removeEventListener("abort", done)
                resolve()
            }
            signal.addEventListener("abort", done, { once: true })
        }),
}

export interface TrajectoryMaintainerOptions {
    readonly instanceId: string
    readonly messages: CommittedUiMessages
    readonly openStore: () => Promise<TrajectoryStore>
    readonly clock?: MaintainerClock
}

/**
 * How a catch-up ended. `ready` and `error` are durable; `not_writable` and
 * `stopped` leave the cache for another window or a later run.
 */
export type CatchUpOutcome = "ready" | "error" | "not_writable" | "stopped"

type PassOutcome =
    | { readonly kind: "done"; readonly outcome: CatchUpOutcome }
    | { readonly kind: "rejected" }
    | { readonly kind: "foreign_job"; readonly revision: number }
    | { readonly kind: "again" }

const AGAIN: PassOutcome = { kind: "again" }
const REJECTED: PassOutcome = { kind: "rejected" }

function done(outcome: CatchUpOutcome): PassOutcome {
    return { kind: "done", outcome }
}

function toFolded(turn: TrajectoryTurn): FoldedTurn {
    return { ...turn, tailAskKind: turn.tailAskKind as UiAsk | null }
}

function toInput(turn: FoldedTurn): TrajectoryTurnInput {
    return { ...turn, toolUsage: turn.toolUsage.map((usage) => ({ ...usage })) }
}

function carryOf(job: TrajectoryJob): FoldCarry {
    return job.carry as unknown as FoldCarry
}

function jobWith(job: Omit<TrajectoryJob, "carry">, carry: FoldCarry): TrajectoryJob {
    return { ...job, carry: carry as unknown as Record<string, unknown> }
}

/** Every storage layer reports a closed handle as "... is closed"; task deletion closes them under a running job. */
function isClosedStorage(error: unknown): boolean {
    return error instanceof Error && /\bis closed\b|\bnot open\b/i.test(error.message)
}

/**
 * Keeps one task's `trajectory.db` equal to the fold of its committed chat rows.
 *
 * Correctness does not depend on who runs: every write is a compare-and-set on
 * the meta stamp, the log head is read before the rows it covers, and a ts
 * violation found by the fold is believed only when the head did not move
 * around the scan. A loser of a compare-and-set retries with backoff, and a job
 * another maintainer stopped advancing is taken over from its persisted cursor.
 */
export class TrajectoryMaintainer {
    private readonly clock: MaintainerClock
    private readonly abort = new AbortController()
    // The open in flight or done: catch-up and a stream's first read may both open
    // first, and a second handle would be a second writer of `trajectory.db`.
    private storeOpening: Promise<TrajectoryStore> | undefined
    /** Revision of this maintainer's last write; a job at another revision belongs to someone else. */
    private ownedRevision: number | undefined
    private takeOverRevision: number | undefined
    private lastPublished = -1
    private readonly listeners = new Set<(meta: TrajectoryMeta) => void>()
    private running: Promise<CatchUpOutcome> | undefined
    private rerun = false

    constructor(private readonly options: TrajectoryMaintainerOptions) {
        this.clock = options.clock ?? REAL_CLOCK
    }

    /** Called after every applied write, in increasing revision order. */
    onDidWrite(listener: (meta: TrajectoryMeta) => void): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    /**
     * Bring the cache up to the current log head. Concurrent calls share one run;
     * a call during a run makes that run check the head once more before it ends.
     */
    catchUp(access: TrajectoryWriteAccess): Promise<CatchUpOutcome> {
        if (this.running) {
            this.rerun = true
            return this.running
        }
        const run = this.runUntilSettled(access).finally(() => {
            this.running = undefined
        })
        this.running = run
        return run
    }

    /**
     * Meta and the turns written after `sinceRevision`, from the store this maintainer
     * writes, so a reader in this process never needs a second handle. Opens
     * `trajectory.db` on first use: call it only while the opening may write.
     */
    async readSnapshot(sinceRevision: number): Promise<TrajectorySnapshot> {
        return (await this.openStore()).readSnapshot(sinceRevision)
    }

    /** Stop after the current slice and close `trajectory.db`. */
    async close(): Promise<void> {
        this.abort.abort()
        await this.running?.catch(() => undefined)
        const opening = this.storeOpening
        this.storeOpening = undefined
        const store = await opening?.catch(() => undefined)
        await store?.close().catch(() => undefined)
    }

    private get stopped(): boolean {
        return this.abort.signal.aborted
    }

    private async runUntilSettled(access: TrajectoryWriteAccess): Promise<CatchUpOutcome> {
        let outcome: CatchUpOutcome
        do {
            this.rerun = false
            outcome = await this.runOnce(access)
        } while (this.rerun && outcome === "ready" && !this.stopped)
        return outcome
    }

    private async runOnce(access: TrajectoryWriteAccess): Promise<CatchUpOutcome> {
        let backoff = INITIAL_BACKOFF_MS
        let watched: { revision: number; since: number } | undefined
        try {
            while (!this.stopped) {
                const pass = await this.pass(access)
                if (pass.kind === "done") return pass.outcome
                if (pass.kind === "again") continue
                if (pass.kind === "rejected") {
                    await this.clock.sleep(backoff, this.abort.signal)
                    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
                    continue
                }
                if (!watched || watched.revision !== pass.revision) watched = { revision: pass.revision, since: this.clock.now() }
                if (this.clock.now() - watched.since >= FOREIGN_JOB_TAKEOVER_MS) {
                    this.takeOverRevision = pass.revision
                    continue
                }
                await this.clock.sleep(FOREIGN_JOB_POLL_MS, this.abort.signal)
            }
            return "stopped"
        } catch (error) {
            if (this.stopped || isClosedStorage(error)) return "stopped"
            Logger.warn(
                `[trajectory] TrajectoryCatchUpFailed: instance=${this.options.instanceId} ${error instanceof Error ? error.message : String(error)}`,
            )
            return "stopped"
        }
    }

    private async openStore(): Promise<TrajectoryStore> {
        // A closed maintainer must not reopen the file its close just released.
        if (this.stopped) throw new Error(`Trajectory maintainer of ${this.options.instanceId} is closed`)
        this.storeOpening ??= this.options.openStore().catch((error: unknown) => {
            // A failed open is retried by the next caller rather than cached.
            this.storeOpening = undefined
            throw error
        })
        return this.storeOpening
    }

    /** One attempt; any compare-and-set rejection ends it so the caller can back off. */
    private async pass(access: TrajectoryWriteAccess): Promise<PassOutcome> {
        if (!access.writable()) return done("not_writable")
        const store = await this.openStore()
        const head = await this.options.messages.log.head()
        const meta = await store.readMeta()

        if (this.needsRebuild(meta, head.logId, head.headSeq)) {
            if (!access.writable()) return done("not_writable")
            const cleared = await this.write(
                store.clear({ logId: head.logId, builderVersion: TRAJECTORY_BUILDER_VERSION }, meta ? stampOf(meta) : null),
            )
            return cleared ? AGAIN : REJECTED
        }
        const current = meta as TrajectoryMeta
        if (current.state === "error") {
            // Another process may have written the error; a connected stream
            // still shows the last ready revision until it is told.
            this.publish(current)
            return done("error")
        }
        if (head.violationTs !== null) return this.persistError(access, store, current, head.violationTs)

        if (current.job) {
            const foreign = this.ownedRevision !== current.revision && this.takeOverRevision !== current.revision
            if (foreign) return { kind: "foreign_job", revision: current.revision }
            return this.runJob(access, store, current, current.job, head.headSeq)
        }
        if (current.state === "ready" && current.appliedCommitSeq === head.headSeq) {
            this.publish(current)
            return done("ready")
        }
        if (current.state === "building") {
            // A fresh build: fold everything up to the head read above.
            return this.runJob(
                access,
                store,
                current,
                jobWith({ fromSeq: 0, nextOrdinal: 0, targetSeq: head.headSeq }, EMPTY_FOLD_CARRY),
                head.headSeq,
            )
        }

        const since = await this.options.messages.log.since(current.appliedCommitSeq)
        if (since.logId !== current.logId) return AGAIN
        const violation = since.tsViolation ?? since.violationTs
        if (violation !== null) return this.persistError(access, store, current, violation)
        if (since.minFirstChangedOrdinal === null) {
            if (!access.writable()) return done("not_writable")
            const applied = await this.write(
                store.updateMeta({ state: "ready", appliedCommitSeq: since.headSeq, job: null, errorTs: null }, stampOf(current)),
            )
            return applied ? done("ready") : REJECTED
        }
        const job = await this.jobFrom(store, since.minFirstChangedOrdinal, since.headSeq)
        return this.runJob(access, store, current, job, since.headSeq)
    }

    private needsRebuild(meta: TrajectoryMeta | null, logId: string | null, headSeq: number): boolean {
        if (!meta || !isCurrentTrajectory(meta, TRAJECTORY_BUILDER_VERSION)) return true
        if (meta.logId !== logId) return true
        // A head behind what was applied means the history was replaced under the same log.
        return meta.appliedCommitSeq > headSeq
    }

    /**
     * The job that refolds from the turn holding ordinal `x - 1`: `x` itself may be an
     * anchor that was removed or reclassified, whose rows then rejoin the turn before it.
     */
    private async jobFrom(store: TrajectoryStore, firstChanged: number, targetSeq: number): Promise<TrajectoryJob> {
        const fromStart = jobWith({ fromSeq: 0, nextOrdinal: 0, targetSeq }, EMPTY_FOLD_CARRY)
        if (firstChanged <= 0) return fromStart
        const turn = await store.findTurnContaining(firstChanged - 1)
        // Rows before the first anchor shape how it is classified, so the first turn refolds from ordinal 0.
        if (!turn || turn.seq === 0) return fromStart
        const previous = await store.readTurn(turn.seq - 1)
        if (!previous) return fromStart
        return jobWith({ fromSeq: turn.seq, nextOrdinal: turn.anchorOrdinal, targetSeq }, carryAfterTurn(toFolded(previous)))
    }

    /** Rebase a resumed job when commits after its target changed rows it already folded. */
    private async rebaseIfNeeded(store: TrajectoryStore, job: TrajectoryJob, headSeq: number): Promise<TrajectoryJob> {
        if (headSeq <= job.targetSeq) return job
        const since = await this.options.messages.log.since(job.targetSeq)
        const changed = since.minFirstChangedOrdinal
        if (changed !== null && changed < job.nextOrdinal) return this.jobFrom(store, Math.min(changed, job.nextOrdinal), headSeq)
        return { ...job, targetSeq: headSeq }
    }

    private async runJob(
        access: TrajectoryWriteAccess,
        store: TrajectoryStore,
        initial: TrajectoryMeta,
        startJob: TrajectoryJob,
        headSeq: number,
    ): Promise<PassOutcome> {
        let meta = initial
        let job = await this.rebaseIfNeeded(store, startJob, headSeq)
        let unstableViolations = 0
        while (!this.stopped) {
            const rows = await this.options.messages.rows.readRange(job.nextOrdinal, job.nextOrdinal + TRAJECTORY_SLICE_ROWS)
            const fold = foldTrajectory(rows, carryOf(job))
            if (fold.provisionalViolation && unstableViolations < MAX_UNSTABLE_VIOLATION_RETRIES) {
                const after = await this.options.messages.log.head()
                if (after.headSeq === job.targetSeq) return this.persistError(access, store, meta, fold.provisionalViolation.ts)
                // The rows moved under the scan; the violation may be an artifact of reading two versions.
                unstableViolations++
                const since = await this.options.messages.log.since(job.targetSeq)
                const changed = Math.min(since.minFirstChangedOrdinal ?? job.nextOrdinal, job.nextOrdinal)
                job = await this.jobFrom(store, changed, after.headSeq)
                continue
            }

            if (!access.writable()) return done("not_writable")
            const last = rows.length < TRAJECTORY_SLICE_ROWS
            let result: TrajectoryWriteResult
            if (last) {
                const closing = closeOpenTurn(fold.carry)
                const turns = closing ? [...fold.turns, closing] : fold.turns
                result = await store.replaceFrom(
                    job.fromSeq,
                    turns.map(toInput),
                    { state: "ready", appliedCommitSeq: job.targetSeq, job: null, errorTs: null },
                    stampOf(meta),
                )
            } else {
                const next = jobWith(
                    {
                        fromSeq: job.fromSeq + fold.turns.length,
                        nextOrdinal: job.nextOrdinal + rows.length,
                        targetSeq: job.targetSeq,
                    },
                    fold.carry,
                )
                const update: TrajectoryMetaUpdate = {
                    state: "building",
                    appliedCommitSeq: meta.appliedCommitSeq,
                    job: next,
                    errorTs: null,
                }
                result = await store.replaceFrom(job.fromSeq, fold.turns.map(toInput), update, stampOf(meta))
                job = next
            }
            if (!this.accept(result)) return REJECTED
            meta = result.meta as TrajectoryMeta
            if (last) return done("ready")
            await new Promise<void>((resolve) => setImmediate(resolve))
        }
        return done("stopped")
    }

    private async persistError(
        access: TrajectoryWriteAccess,
        store: TrajectoryStore,
        meta: TrajectoryMeta,
        ts: number,
    ): Promise<PassOutcome> {
        if (!access.writable()) return done("not_writable")
        const applied = await this.write(
            store.updateMeta({ state: "error", appliedCommitSeq: meta.appliedCommitSeq, job: null, errorTs: ts }, stampOf(meta)),
        )
        if (!applied) return REJECTED
        Logger.warn(`[trajectory] TrajectoryTsOrderError: instance=${this.options.instanceId} ts=${ts}`)
        return done("error")
    }

    private async write(pending: Promise<TrajectoryWriteResult>): Promise<boolean> {
        return this.accept(await pending)
    }

    private accept(result: TrajectoryWriteResult): boolean {
        if (!result.applied) return false
        this.ownedRevision = result.meta.revision
        this.takeOverRevision = undefined
        this.publish(result.meta)
        return true
    }

    private publish(meta: TrajectoryMeta): void {
        if (meta.revision <= this.lastPublished) return
        this.lastPublished = meta.revision
        for (const listener of [...this.listeners]) {
            try {
                listener(meta)
            } catch (error) {
                Logger.warn(`[trajectory] TrajectoryListenerFailed: ${error instanceof Error ? error.message : String(error)}`)
            }
        }
    }
}
