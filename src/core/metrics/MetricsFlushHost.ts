/**
 * The background writer: where the metrics database is actually touched.
 *
 * `DatabaseSync` is synchronous. Running it on the extension host's thread blocks
 * every Task for the duration of the write, and `busy_timeout = 5000` means a
 * contended write can block for seconds. The ledger therefore runs on a dedicated
 * worker, and this host owns that worker's lifecycle: a bounded stop that reports
 * honestly whether the writer really went away.
 *
 * The host never touches the database itself. It only owns the queue hand-off and the
 * worker lifecycle, so it can be constructed on the main thread without opening a
 * connection there.
 */

import { Worker } from "node:worker_threads"
import type { MetricsEvent } from "@shared/metrics/events"
import { MetricsEventQueue } from "./EventQueue"
import { MetricsHealth, type MetricsHealthSnapshot } from "./MetricsHealth"
import type { MetricsScope } from "./MetricsScope"

/** The bounded outcome of asking a flush host to stop. */
export type MetricsStopOutcome = "stopped" | "already_stopped" | "not_released"

export interface MetricsStopResult {
    readonly outcome: MetricsStopOutcome
    /** True only when the writer provably stopped; a caller may hand over ownership. */
    readonly released: boolean
    /** How long the stop waited, in milliseconds. */
    readonly waitedMs: number
    /** Why the writer did not stop, when it did not. */
    readonly reason?: string
}

/** Default stop budget: a Task deletion must not hang on a wedged writer. */
export const DEFAULT_STOP_TIMEOUT_MS = 2_000

/**
 * The part of a worker thread this host actually uses.
 *
 * Keeping it minimal lets a test drive the lifecycle (a worker that never replies, or
 * one that exits mid-request) without a real thread or a database, which is the only
 * way the hang and in-flight-bound defects stay covered.
 */
export interface MetricsWorkerPort {
    /** True once the worker has exited, so a request is refused instead of hanging. */
    readonly exited: boolean
    postMessage(message: MetricsWorkerCommand): void
    onOnline(listener: () => void): void
    onMessage(listener: (reply: MetricsWorkerReply) => void): void
    offMessage(listener: (reply: MetricsWorkerReply) => void): void
    onError(listener: (error: Error) => void): void
    offError(listener: (error: Error) => void): void
    onExit(listener: (code: number) => void): void
    offExit(listener: (code: number) => void): void
    terminate(): Promise<number>
}

/** Adapts a real worker thread to the minimal port above. */
export class NodeWorkerPort implements MetricsWorkerPort {
    private exitedFlag = false

    constructor(private readonly worker: Worker) {
        this.worker.once("exit", () => {
            this.exitedFlag = true
        })
    }

    get exited(): boolean {
        return this.exitedFlag
    }

    postMessage(message: MetricsWorkerCommand): void {
        this.worker.postMessage(message)
    }

    onOnline(listener: () => void): void {
        this.worker.once("online", listener)
    }

    onMessage(listener: (reply: MetricsWorkerReply) => void): void {
        // Persistent, not one-shot: `request()` keeps the listener across replies it
        // rejects for carrying another request's id. A one-shot listener would be
        // consumed by such a reply, leaving the matching reply unheard until the
        // deadline expired and the batch was retried for no reason.
        this.worker.on("message", listener)
    }

    offMessage(listener: (reply: MetricsWorkerReply) => void): void {
        this.worker.off("message", listener)
    }

    onError(listener: (error: Error) => void): void {
        this.worker.on("error", listener)
    }

    offError(listener: (error: Error) => void): void {
        this.worker.off("error", listener)
    }

    onExit(listener: (code: number) => void): void {
        this.worker.once("exit", listener)
    }

    offExit(listener: (code: number) => void): void {
        this.worker.off("exit", listener)
    }

    terminate(): Promise<number> {
        return this.worker.terminate()
    }
}

export interface MetricsFlushHostOptions {
    readonly scope: MetricsScope
    /** Absolute path of the compiled worker entry. */
    readonly workerPath: string
    /** Maximum events buffered before the hot path drops them. */
    readonly capacity?: number
    /** Stop budget in milliseconds. */
    readonly stopTimeoutMs?: number
    /** Interval between background flush passes, in milliseconds. */
    readonly flushIntervalMs?: number
    /**
     * How long one worker command may stay unanswered.
     *
     * A worker can die between `online` and the first command, in which case no reply,
     * error or exit is ever delivered to that request. Without a deadline the batch is
     * lost *and* the caller waits forever.
     */
    readonly requestTimeoutMs?: number
    /** Overrides worker creation; tests use it to drive the lifecycle directly. */
    readonly createWorker?: (workerPath: string, scope: MetricsScope) => MetricsWorkerPort
}

/** One in-flight command, so every exit path can settle it exactly once. */
interface PendingRequest {
    readonly settle: (reply: MetricsWorkerReply) => void
    readonly fail: (error: Error) => void
    readonly detach: () => void
}

/**
 * Message the host posts to its worker.
 *
 * `requestId` correlates the reply with the command that caused it. Without it a reply
 * that arrives after its command already timed out would settle the *next* command's
 * promise: the host would believe a batch it never handed over was written, drop it, and
 * lose every event it contained.
 */
export type MetricsWorkerCommand =
    | { readonly type: "flush"; readonly requestId: number; readonly events: readonly MetricsEvent[] }
    | { readonly type: "stop"; readonly requestId: number }

/** A command before the host assigns it a correlation id. */
export type MetricsWorkerSpec = { readonly type: "flush"; readonly events: readonly MetricsEvent[] } | { readonly type: "stop" }

/** Message the worker posts back, echoing the request it answers. */
export interface MetricsWorkerReply {
    readonly type: "flushed" | "failed" | "stopped"
    /** The `requestId` of the command this answers. */
    readonly requestId: number
    readonly storedEvents?: number
    readonly lostEvents?: number
    readonly message?: string
}

const DEFAULT_FLUSH_INTERVAL_MS = 500
/** Matches `MetricsEventQueue`'s own default so the host can reason about the bound. */
const DEFAULT_QUEUE_CAPACITY = 4_096
/**
 * A command may wait longer than the ledger's `busy_timeout` (5s) plus a commit, but
 * not forever: an unanswered command means the worker is gone.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/**
 * A host whose worker has not been created yet.
 *
 * The extension host creates this object eagerly and starts the worker lazily, so the
 * first Task does not pay worker startup on a hot path and a scope that never emits a
 * metric never opens a database.
 */
export class MetricsFlushHost {
    readonly scope: MetricsScope
    readonly queue: MetricsEventQueue
    readonly health: MetricsHealth
    private readonly workerPath: string
    private readonly stopTimeoutMs: number
    private readonly requestTimeoutMs: number
    private readonly createWorker: (workerPath: string, scope: MetricsScope) => MetricsWorkerPort
    private worker: MetricsWorkerPort | undefined
    private stopped = false
    private startPromise: Promise<void> | undefined
    private stopPromise: Promise<MetricsStopResult> | undefined
    private timer: ReturnType<typeof setInterval> | undefined
    /** The command the worker has not answered yet, including how to abort it. */
    private pendingReply: PendingRequest | undefined
    /**
     * Batches already handed to the worker.
     *
     * `queue.offer` bounds only what still waits for a slot, so without this counter a
     * burst plus a slow write would hold an unbounded number of drained batches in
     * flight.
     */
    private inFlightEvents = 0
    private readonly capacity: number
    /** Serializes passes so two callers never interleave two write transactions. */
    private passChain: Promise<unknown> = Promise.resolve()
    /** Correlates each command with its reply, so a late reply cannot settle a new one. */
    private nextRequestId = 0
    private readonly flushIntervalMs: number

    constructor(options: MetricsFlushHostOptions) {
        this.scope = options.scope
        this.workerPath = options.workerPath
        this.capacity = options.capacity ?? DEFAULT_QUEUE_CAPACITY
        this.queue = new MetricsEventQueue({ capacity: this.capacity })
        this.health = new MetricsHealth()
        this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
        this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
        this.flushIntervalMs = Math.max(1, options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS)
        this.createWorker =
            options.createWorker ?? ((workerPath, scope) => new NodeWorkerPort(new Worker(workerPath, { workerData: { scope } })))
    }

    /**
     * Accept one event.
     *
     * This is the hot path: it never awaits, never starts the worker, and never throws.
     */
    emit(event: MetricsEvent): void {
        this.queue.offer(event)
    }

    /** Start the writer. Idempotent, so a caller does not need its own flag. */
    async start(): Promise<void> {
        if (this.stopped) return
        // A start failure is recorded and absorbed: metrics are not part of a Task's
        // business contract, so a missing worker must degrade the write path instead of
        // rejecting a caller that cannot do anything about it.
        this.startPromise ??= this.spawn().catch((error: unknown) => {
            this.health.recordFailure(error instanceof Error ? error.message : "metrics worker failed to start")
            this.worker = undefined
        })
        return await this.startPromise
    }

    /**
     * Write whatever is buffered.
     *
     * Runs through the worker when one exists; without a worker the pass is a no-op so
     * a caller never performs database work on the current thread by accident.
     */
    async flush(): Promise<void> {
        // Passes run one after another: a second caller waits for the first pass to
        // finish instead of draining a second batch that the worker would have to
        // buffer anyway.
        const pass = this.passChain.then(() => this.runPass())
        this.passChain = pass.catch(() => undefined)
        return await pass
    }

    private async runPass(): Promise<void> {
        if (this.stopped) return
        const worker = this.worker
        if (!worker) return
        // Draining can never exceed the bound: buffered plus in-flight is what a burst
        // can hold, and `offer` refuses new events once buffered reaches capacity.
        const events = this.queue.drain()
        if (events.length === 0) return

        this.inFlightEvents += events.length
        let reply: MetricsWorkerReply
        try {
            reply = await this.request(worker, { type: "flush", events })
        } catch (error) {
            // A worker that disappeared mid-pass is a degraded write path, not a caller
            // failure: the events go back to the queue and the health report says why.
            this.health.recordFailure(error instanceof Error ? error.message : "metrics worker failed")
            // Give this batch's own reservation back *before* asking the queue for room.
            // The reservation bounds how much a burst may hold; if it also competed with
            // the batch that is returning, a failed write against a full queue would be
            // counted as lost exactly when a retry matters most.
            this.releaseInFlight(events.length)
            this.requeue(events)
            return
        }
        this.releaseInFlight(events.length)
        if (reply.type === "flushed") {
            this.health.recordSuccess(Date.now())
            const lost = reply.lostEvents ?? 0
            if (lost > 0) this.queue.countReceiverFailure(lost)
            return
        }
        // A failed write goes back to the queue so the next pass can retry it; when the
        // queue no longer has room the overflow is counted instead of silently dropped.
        this.health.recordFailure(reply.message ?? "metrics worker failed to write")
        this.requeue(events)
    }

    /**
     * Keep a failed batch for the next pass, without exceeding the total bound.
     *
     * A failed write is the ordinary outcome of `SQLITE_BUSY`, which another window
     * holding the same global database produces routinely. Discarding the batch then
     * would lose exactly the facts the retry exists to preserve, and the ledger's
     * receipts already make a repeated batch idempotent, so keeping it is safe even
     * when a newer batch is buffered underneath. Only the storage bound can force a
     * loss, and that loss is counted.
     */
    private requeue(events: readonly MetricsEvent[]): void {
        const room = Math.max(0, this.capacity - this.queue.pending - this.inFlightEvents)
        if (events.length > room) {
            this.queue.countReceiverFailure(events.length - room)
            this.queue.requeue(events.slice(0, Math.max(0, room)))
            return
        }
        this.queue.requeue(events)
    }

    /**
     * Drop one batch's reservation once its pass has stopped holding the events.
     *
     * The reservation exists to bound how much a burst hands to the worker. It must be
     * released as soon as the pass knows the batch's fate, because a returning batch is
     * buffered again and would otherwise count against the room it needs.
     */
    private releaseInFlight(count: number): void {
        this.inFlightEvents = Math.max(0, this.inFlightEvents - count)
    }

    /**
     * Post one command and wait for its reply.
     *
     * Every way a request can end settles it exactly once: a reply, a worker error, or
     * the worker exiting. A request that is still pending when the worker is terminated
     * is failed by `stop()` rather than left waiting forever.
     */
    private async request(worker: MetricsWorkerPort, command: MetricsWorkerSpec): Promise<MetricsWorkerReply> {
        // A worker that already exited will never answer; posting would wait forever.
        if (worker.exited) throw new Error("metrics worker already exited")
        const requestId = (this.nextRequestId += 1)
        return await new Promise<MetricsWorkerReply>((resolve, reject) => {
            // The deadline is deliberately *not* `unref`'d: it is the only thing that
            // settles an unanswered command, so letting the host exit with it pending
            // would keep the batch and its caller waiting. Shutdown is bounded by
            // `stop()`, which aborts this request explicitly.
            const timer = setTimeout(
                () => fail(new Error(`metrics worker did not answer within ${this.requestTimeoutMs}ms`)),
                this.requestTimeoutMs,
            )
            const detachAll = () => {
                clearTimeout(timer)
                worker.offMessage(onMessage)
                worker.offError(onError)
                worker.offExit(onExit)
            }
            // Settlement is tracked locally, not by inspecting `this.pendingReply`:
            // `abortPending` clears that field *before* failing the request, so a guard
            // that re-read it would silently drop the rejection and hang the caller.
            let settled = false
            const settle = (reply: MetricsWorkerReply) => {
                if (settled) return
                settled = true
                this.pendingReply = undefined
                detachAll()
                resolve(reply)
            }
            const fail = (error: Error) => {
                if (settled) return
                settled = true
                this.pendingReply = undefined
                detachAll()
                reject(error)
            }
            // A reply that answers an earlier, already-timed-out command settles nothing
            // here. Accepting it would mark this batch written when the worker never
            // received it, and the whole batch would then be dropped as if committed.
            const onMessage = (reply: MetricsWorkerReply) => {
                if (reply.requestId !== requestId) return
                settle(reply)
            }
            const onError = (error: Error) => fail(error)
            const onExit = (code: number) => fail(new Error(`metrics worker exited with code ${code}`))

            this.pendingReply = { settle, fail, detach: detachAll }
            worker.onMessage(onMessage)
            worker.onError(onError)
            worker.onExit(onExit)
            try {
                worker.postMessage({ ...command, requestId } as MetricsWorkerCommand)
            } catch (error) {
                fail(error instanceof Error ? error : new Error("metrics worker rejected the command"))
            }
        })
    }

    /** Fail any in-flight request so its pass can requeue instead of hanging. */
    private abortPending(reason: string): void {
        const pending = this.pendingReply
        if (!pending) return
        pending.detach()
        this.pendingReply = undefined
        pending.fail(new Error(reason))
    }

    /** Current health, including the queue's drop counters. */
    snapshot(): MetricsHealthSnapshot {
        return this.health.snapshot(this.queue.stats())
    }

    /**
     * Stop accepting events and release the writer within the stop budget.
     *
     * `released` is true only when the worker is gone. A timeout reports
     * `not_released`, because telling a deletion path that the file is safe to remove
     * when it is not is worse than reporting a failure.
     */
    async stop(): Promise<MetricsStopResult> {
        // Every call reports the outcome of *that* call, so a second stop says
        // `already_stopped` instead of replaying the first answer.
        const wasStopped = this.stopped
        this.stopPromise ??= this.runStop(wasStopped)
        const result = await this.stopPromise
        return wasStopped ? { ...result, outcome: "already_stopped" } : result
    }

    private async runStop(wasStopped: boolean): Promise<MetricsStopResult> {
        // Stop accepting before draining. Marking `stopped` adds no pass ahead of the
        // buffered events (they were all accepted earlier and `flush` joins the same
        // serial chain), and it keeps a wedged in-flight pass from deadlocking the
        // drain that is queued behind it.
        const startedAt = Date.now()
        this.stopped = true
        this.queue.close()
        this.health.markClosed()
        if (this.timer) {
            clearInterval(this.timer)
            this.timer = undefined
        }

        // Abort before draining. Draining joins the serial chain, so an unanswered
        // in-flight command would make the drain wait for that command, and the command
        // wait for nothing 鈥?a mutual wait that outlives the stop budget.
        this.abortPending("metrics host stopped")
        await this.settleWithinBudget(() => this.passChain, startedAt)
        await this.settleWithinBudget(() => this.drainOnce(), startedAt)

        const worker = this.worker
        const outcome: MetricsStopOutcome = wasStopped ? "already_stopped" : "stopped"
        if (!worker) return { outcome, released: true, waitedMs: Date.now() - startedAt }

        try {
            await this.terminateWithinBudget(worker)
            // The terminating worker never answers, so an in-flight pass would wait
            // forever and keep its already-drained batch in limbo.
            this.abortPending("metrics worker stopped before replying")
            await this.passChain
            return { outcome: "stopped", released: true, waitedMs: Date.now() - startedAt }
        } catch (error) {
            this.abortPending("metrics worker did not stop")
            return {
                outcome: "not_released",
                released: false,
                waitedMs: Date.now() - startedAt,
                reason: error instanceof Error ? error.message : "metrics worker did not stop",
            }
        } finally {
            if (this.worker === worker) this.worker = undefined
        }
    }

    /**
     * Wait for one shutdown step, but never past the stop budget.
     *
     * The stop result already reports `not_released` when the writer survives, so a
     * step that outlives the budget is left behind instead of hanging the deletion path.
     */
    private async settleWithinBudget(step: () => Promise<unknown>, startedAtMs: number): Promise<void> {
        const remaining = this.stopTimeoutMs - (Date.now() - startedAtMs)
        if (remaining <= 0) return
        let timer: ReturnType<typeof setTimeout> | undefined
        const budget = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, remaining)
            timer.unref?.()
        })
        try {
            await Promise.race([step().catch(() => undefined), budget])
        } finally {
            if (timer) clearTimeout(timer)
        }
    }

    /**
     * Write what is still buffered during shutdown.
     *
     * This deliberately does not go through `flush()`: `runPass` returns immediately
     * once `stopped` is set, so joining that chain would drain nothing and silently
     * leave accepted events in a queue nobody can consume again. Stopping must either
     * write the buffer or count it as lost.
     */
    private async drainOnce(): Promise<void> {
        const worker = this.worker
        const events = this.queue.drain()
        if (!worker || events.length === 0) {
            if (events.length > 0) this.queue.countReceiverFailure(events.length)
            return
        }
        try {
            const reply = await this.request(worker, { type: "flush", events })
            if (reply.type === "flushed") {
                const lost = reply.lostEvents ?? 0
                if (lost > 0) this.queue.countReceiverFailure(lost)
                this.health.recordSuccess(Date.now())
                return
            }
            this.health.recordFailure(reply.message ?? "metrics worker failed to write")
            this.queue.countReceiverFailure(events.length)
        } catch (error) {
            // Shutdown never rejects on a write failure: the stop result reports the
            // worker state, and the loss is counted instead of being hidden.
            this.health.recordFailure(error instanceof Error ? error.message : "metrics worker failed")
            this.queue.countReceiverFailure(events.length)
        }
    }

    private async terminateWithinBudget(worker: MetricsWorkerPort): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(
                () => reject(new Error(`metrics worker did not stop within ${this.stopTimeoutMs}ms`)),
                this.stopTimeoutMs,
            )
            // A pending stop must not keep the host process alive on its own.
            timer.unref?.()
        })
        try {
            await Promise.race([worker.terminate().then(() => undefined), timeout])
        } finally {
            if (timer) clearTimeout(timer)
        }
    }

    private async spawn(): Promise<void> {
        // Worker construction can throw or emit `error` before `online`. Both are
        // normalized into one rejection so the caller only has one failure path.
        const worker = await new Promise<MetricsWorkerPort>((resolve, reject) => {
            let created: MetricsWorkerPort
            try {
                created = this.createWorker(this.workerPath, this.scope)
            } catch (error) {
                reject(error instanceof Error ? error : new Error("metrics worker construction failed"))
                return
            }
            // `online` is emitted before the entry script is loaded, so a missing or
            // broken worker fails *after* the start already succeeded. The handler
            // therefore stays installed for the worker's whole life and degrades the
            // write path instead of surfacing an unhandled `error` event.
            let settled = false
            created.onOnline(() => {
                settled = true
                resolve(created)
            })
            created.onError((error: Error) => {
                this.health.recordFailure(error.message)
                this.abortPending(error.message)
                if (this.worker === created) this.worker = undefined
                if (this.timer) {
                    clearInterval(this.timer)
                    this.timer = undefined
                }
                if (!settled) {
                    settled = true
                    void created.terminate().catch(() => undefined)
                    reject(error)
                }
            })
        })

        if (this.stopped) {
            // `stop()` ran while the worker was still starting; it saw no worker and
            // reported release, so this one must not be kept alive.
            await worker.terminate().catch(() => undefined)
            return
        }
        this.worker = worker
        const timer = setInterval(() => {
            void this.flush().catch(() => undefined)
        }, this.flushIntervalMs)
        timer.unref?.()
        this.timer = timer
    }
}
