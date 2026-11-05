/**
 * The one process-level write path for the global metrics level.
 *
 * Every Task records its own rows and, in the same settlement, offers the same fact to
 * the global level. Those offers must not each open a writer: `MetricsFlushHost`
 * serializes passes only *inside one host*, so a host per Task would open one SQLite
 * write connection per Task against the same `global/metrics.db`. Contention would then
 * degrade into `busy_timeout` collisions instead of a queue.
 *
 * So there is exactly one instance per process: one bounded queue, one host, one worker
 * thread, one write connection. A Task offers synchronously and never waits.
 *
 * Across windows the queue cannot help, and this module does not pretend otherwise.
 * SQLite arbitrates there: every write is `BEGIN IMMEDIATE` under WAL with
 * `busy_timeout`, so a contended batch fails rather than interleaves, and the host keeps
 * that batch for the next pass instead of dropping it. Rows are keyed by
 * `taskId::eventId`, so a batch that is retried after a `SQLITE_BUSY` records once.
 *
 * Reads stay separate: each read opens its own read-only connection, which WAL allows
 * while the single writer is busy.
 */

import type { MetricsEvent } from "@shared/metrics/events"
import { Logger } from "@shared/services/Logger"
import type { MetricsQueueSink } from "./EventQueue"
import { MetricsFlushHost, type MetricsStopResult } from "./MetricsFlushHost"
import type { MetricsHealthSnapshot } from "./MetricsHealth"
import { MetricsQueryService, type MetricsReadPort } from "./MetricsQueryService"
import { MetricsRepository } from "./MetricsRepository"
import { globalMetricsScope, type MetricsScope } from "./MetricsScope"

export interface GlobalMetricsRuntime {
    /** Accept one event for the global level. Synchronous, bounded, never throws. */
    readonly sink: MetricsQueueSink
    /** Read committed global rows. Never waits for a flush. */
    readonly reader: MetricsQueryService
    /** The scope those rows belong to, for a caller that must label them. */
    readonly scope: MetricsScope
    /** Start the single writer. Idempotent. */
    start(): Promise<void>
    /** Write whatever is buffered, for a caller that must observe its own batch. */
    flush(): Promise<void>
    /** Stop the writer and report whether it really released the database. */
    release(): Promise<MetricsStopResult>
    /** Current write-path health. */
    snapshot(): MetricsHealthSnapshot
}

export interface OpenGlobalMetricsRuntimeOptions {
    /** Absolute path of the compiled worker entry. */
    readonly workerPath: string
}

let instance: GlobalMetricsRuntime | undefined
/** The replacement created while the previous runtime was still shutting down. */
let successor: GlobalMetricsRuntime | undefined
/**
 * Runtimes whose release has begun and not yet finished.
 *
 * Tracked per instance, not as one module flag: two overlapping releases would otherwise
 * clear a shared flag on the first `finally`, and the next caller would be handed the
 * second, still-stopping runtime. A release closes the host queue before it awaits
 * anything, so that runtime refuses every event while still reporting a writer.
 */
const releasingRuntimes = new WeakSet<GlobalMetricsRuntime>()

/** The runtime that can still accept work, ignoring any runtime on its way out. */
function liveRuntime(): GlobalMetricsRuntime | undefined {
    if (instance && !releasingRuntimes.has(instance)) return instance
    // The successor can itself be releasing: A.release → open(B) → B.release leaves both
    // closing, and returning B would hand out a runtime whose queue is already shut.
    if (successor && !releasingRuntimes.has(successor)) return successor
    return undefined
}

function createRuntime(workerPath: string): GlobalMetricsRuntime {
    const scope = globalMetricsScope()
    const host = new MetricsFlushHost({ scope, workerPath })
    const runtime: GlobalMetricsRuntime = {
        sink: { offer: (event) => host.queue.offer(event) },
        reader: new MetricsQueryService({ reads: committedReadsOf(scope), health: () => host.snapshot() }),
        scope,
        start: async () => {
            await host.start()
        },
        flush: async () => {
            await host.flush()
        },
        release: async () => {
            releasingRuntimes.add(runtime)
            try {
                const result = await host.stop()
                if (!result.released) {
                    // The writer survived its budget. Keeping it as the live instance is
                    // the only safe choice: a replacement would open a second connection
                    // to the same file while this one still holds it.
                    Logger.warn(`[Metrics] Global metrics writer did not stop: ${result.reason ?? "unknown"}`)
                    return result
                }
                // Only a released runtime is forgotten, so no caller is ever handed a
                // runtime whose worker is gone. A replacement opened during shutdown
                // takes over instead of being stranded by this one finishing later.
                if (successor) {
                    instance = successor
                    successor = undefined
                } else if (instance === runtime) {
                    instance = undefined
                }
                return result
            } finally {
                releasingRuntimes.delete(runtime)
            }
        },
        snapshot: () => host.snapshot(),
    }
    return runtime
}

/**
 * The process-wide global runtime, created on first use.
 *
 * A second caller receives the same instance. Two runtimes would reintroduce exactly the
 * multiple-writer problem this exists to prevent, so a caller that arrives during a
 * release gets the single replacement rather than a new one per call.
 */
export function openGlobalMetricsRuntime(options: OpenGlobalMetricsRuntimeOptions): GlobalMetricsRuntime {
    const live = liveRuntime()
    if (live) return live
    const created = createRuntime(options.workerPath)
    if (instance) successor = created
    else instance = created
    return created
}

/** The runtime a settlement path offers to, or `undefined` when none can accept work. */
export function currentGlobalMetricsRuntime(): GlobalMetricsRuntime | undefined {
    return liveRuntime()
}

/**
 * Offer one settled fact to the global level.
 *
 * Returns whether it was accepted. A missing runtime or a full queue reports `false`
 * rather than throwing: the global level is never a precondition for a Task, and the
 * caller still recorded its own row.
 */
export function offerGlobalMetrics(event: MetricsEvent): boolean {
    // `liveRuntime()` rather than `instance`: while a runtime is releasing, `instance`
    // still points at the closing queue, which would refuse the event and report a loss
    // that a healthy replacement had room for.
    return liveRuntime()?.sink.offer(event) ?? false
}

/**
 * Read committed rows through a connection of the reader's own.
 *
 * A worker-written database can be read while the worker is busy, and WAL keeps that
 * read from blocking a write. Each call opens and releases its connection, so a reader
 * that is never used never holds a file open, which a Task deletion depends on.
 */
function committedReadsOf(scope: MetricsScope): MetricsReadPort {
    return {
        usage: async (options) => await withRepository(scope, (repository) => repository.usage(options)),
        performance: async (options) => await withRepository(scope, (repository) => repository.performance(options)),
        acceptanceFloorMs: async () => await withRepository(scope, (repository) => repository.acceptanceFloorMs()),
    }
}

async function withRepository<TResult>(
    scope: MetricsScope,
    read: (repository: MetricsRepository) => Promise<TResult>,
): Promise<TResult> {
    // Readonly on purpose: this backend opens even a `SELECT` transaction with
    // `BEGIN IMMEDIATE`, so a read-write connection would queue behind the worker's
    // batch on the extension host thread. A readonly connection also refuses an
    // unmigrated file rather than creating one from a read.
    const repository = await MetricsRepository.open({ scope, readOnly: true })
    try {
        return await read(repository)
    } finally {
        await repository.close().catch(() => undefined)
    }
}

/** Forget the singleton. Only a full runtime reset or a test uses this. */
export function resetGlobalMetricsRuntimeForTests(): void {
    instance = undefined
    successor = undefined
}
