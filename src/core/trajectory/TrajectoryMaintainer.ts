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
import type { CommitHead, CommittedUiMessages } from "./CommittedUiMessages"
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
 * 3: obsolete filtered-anchor payloads.
 * 4: every committed user interval is retained, independently of timestamp identity.
 */
export const TRAJECTORY_BUILDER_VERSION = 4

/** Rows read per slice, so a catch-up never holds a long history in memory. */
export const TRAJECTORY_SLICE_ROWS = 500

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
 * How a catch-up ended.
 *
 * `ready` is the durable result the cache now holds. `not_writable` and
 * `stopped` are ordinary ends that leave the cache for another window or a
 * later run. `failed` is different from all of them: the fold could not finish
 * for a reason nothing will retry on its own, so a caller that owns the
 * maintainer has to schedule the retry instead of treating the cache as settled.
 */
export type CatchUpOutcome = "ready" | "not_writable" | "stopped" | "failed"

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
 * the meta stamp, and commits behind a slice cursor rebase its affected suffix.
 * A completed scan checks the head again before settling. A loser of a
 * compare-and-set retries with backoff, and an interrupted foreign job is taken
 * over from its persisted cursor.
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
            // A stopped maintainer and a handle the task's deletion closed are
            // ordinary ends: nobody should retry them. Anything else is a fold
            // that failed with the cache still empty or behind, and reporting it
            // as `stopped` left the owner believing the cache was settled, so a
            // quiet task kept an empty `building` cache forever.
            if (this.stopped || isClosedStorage(error)) return "stopped"
            Logger.warn(
                `[trajectory] TrajectoryCatchUpFailed: instance=${this.options.instanceId} ${error instanceof Error ? error.message : String(error)}`,
            )
            return "failed"
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
        // Observe the source after the cache: a newer foreign job must not look
        // like a source regression against a head read before that job existed.
        const meta = await store.readMeta()
        const head = await this.options.messages.log.head()

        if (this.needsRebuild(meta, head.logId, head.headSeq)) {
            if (!access.writable()) return done("not_writable")
            const cleared = await this.write(
                store.clear({ logId: head.logId, builderVersion: TRAJECTORY_BUILDER_VERSION }, meta ? stampOf(meta) : null),
            )
            return cleared ? AGAIN : REJECTED
        }
        const current = meta as TrajectoryMeta

        if (current.job) {
            const foreign = this.ownedRevision !== current.revision && this.takeOverRevision !== current.revision
            if (foreign) return { kind: "foreign_job", revision: current.revision }
            return this.runJob(access, store, current, current.job, head)
        }
        // Only commit identity and position determine whether the cache needs work.
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
                head,
            )
        }

        const since = await this.options.messages.log.since(current.appliedCommitSeq)
        if (since.logId !== current.logId || since.headSeq < current.appliedCommitSeq) return AGAIN
        if (since.minFirstChangedOrdinal === null) {
            if (!access.writable()) return done("not_writable")
            const applied = await this.write(
                store.updateMeta({ state: "ready", appliedCommitSeq: since.headSeq, job: null, errorTs: null }, stampOf(current)),
            )
            return applied ? done("ready") : REJECTED
        }
        const job = await this.jobFrom(store, since.minFirstChangedOrdinal, since.headSeq)
        return this.runJob(access, store, current, job, since)
    }

    private needsRebuild(meta: TrajectoryMeta | null, logId: string | null, headSeq: number): boolean {
        if (!meta || !isCurrentTrajectory(meta, TRAJECTORY_BUILDER_VERSION) || meta.state === "error") return true
        if (meta.logId !== logId) return true
        // Neither applied rows nor an unfinished carry may belong to a future head.
        return meta.appliedCommitSeq > headSeq || (meta.job !== null && meta.job.targetSeq > headSeq)
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
    private async rebaseIfNeeded(
        store: TrajectoryStore,
        job: TrajectoryJob,
        head: CommitHead,
    ): Promise<TrajectoryJob | undefined> {
        if (head.headSeq === job.targetSeq) return job
        const since = await this.options.messages.log.since(job.targetSeq)
        if (since.logId !== head.logId || since.headSeq < job.targetSeq) return undefined
        const changed = since.minFirstChangedOrdinal
        if (changed !== null && changed < job.nextOrdinal) {
            return this.jobFrom(store, changed, since.headSeq)
        }
        return { ...job, targetSeq: since.headSeq }
    }

    private async runJob(
        access: TrajectoryWriteAccess,
        store: TrajectoryStore,
        initial: TrajectoryMeta,
        startJob: TrajectoryJob,
        initialHead: CommitHead,
    ): Promise<PassOutcome> {
        let meta = initial
        let job = startJob
        let head = initialHead
        while (!this.stopped) {
            if (head.logId !== meta.logId || head.headSeq < job.targetSeq) return AGAIN
            const rebased = await this.rebaseIfNeeded(store, job, head)
            if (!rebased) return AGAIN
            job = rebased
            const rows = await this.options.messages.rows.readRange(job.nextOrdinal, job.nextOrdinal + TRAJECTORY_SLICE_ROWS)
            const fold = foldTrajectory(rows, carryOf(job))

            if (this.stopped) return done("stopped")
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
            // A commit may have landed during readRange or the write. Check it in
            // the next pass, even when no in-process signal was delivered.
            if (last) return AGAIN
            await new Promise<void>((resolve) => setImmediate(resolve))
            head = await this.options.messages.log.head()
        }
        return done("stopped")
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
