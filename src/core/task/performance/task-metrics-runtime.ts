/**
 * The production wiring between a Task and the unified metrics writer.
 *
 * One Task opening gets one attachment: a bounded queue, a worker that owns every
 * write to the Task's `metrics.db`, and a reader over already committed rows. The
 * distinction between write and read matters:
 *
 * - Writes go through the worker, so `DatabaseSync` never blocks the extension host.
 * - Reads open their own connection and return only what has been committed. They do
 *   not wait for a flush, because a Task's UI must not inherit disk latency.
 *
 * A Task opened without metrics keeps working: every entry point here returns
 * `undefined` rather than throwing, because metrics are never a preconditon for a
 * Task's business behaviour.
 */

import path from "node:path"
import { registerTaskMetricsWriter } from "@core/metrics/MetricsDeletionGuard"
import { MetricsFlushHost } from "@core/metrics/MetricsFlushHost"
import { MetricsQueryService } from "@core/metrics/MetricsQueryService"
import { MetricsRepository } from "@core/metrics/MetricsRepository"
import { type MetricsScope, taskMetricsScope } from "@core/metrics/MetricsScope"
import { Logger } from "@shared/services/Logger"
import { attachTaskMetrics, type FrozenMetricsIdentity, type TaskMetricsAttachment } from "./metrics-emitter"

/** Name of the compiled worker bundle, emitted next to `extension.js`. */
export const METRICS_WORKER_FILE = "metrics-worker.js"

/**
 * Where the compiled worker lives.
 *
 * esbuild writes `extension.js` and `metrics-worker.js` into the same directory, so the
 * worker is resolved relative to this bundle rather than to any workspace path.
 */
export function metricsWorkerPath(bundleDirectory: string): string {
    return path.join(bundleDirectory, METRICS_WORKER_FILE)
}

export interface TaskMetricsRuntime {
    readonly attachment: TaskMetricsAttachment
    readonly scope: MetricsScope
    /** Reads committed rows of the Task's own level; never waits for a flush. */
    readonly reader: MetricsQueryService
    /** The background writer, for health and for a caller that must stop it explicitly. */
    readonly host: MetricsFlushHost
}

export interface OpenTaskMetricsRuntimeOptions {
    readonly identity: FrozenMetricsIdentity
    /** Absolute path of the compiled worker entry. */
    readonly workerPath: string
    /** Start the writer eagerly. Defaults to lazy, so an idle Task never creates a file. */
    readonly startImmediately?: boolean
}

/**
 * Wire one Task's write path and read path.
 *
 * The reader is opened lazily: constructing it does not touch the database, so a Task
 * that never reads a metric pays nothing. The writer creates its database on the first
 * committed batch, which is why an idle Task leaves no `metrics.db` behind.
 */
export async function openTaskMetricsRuntime(options: OpenTaskMetricsRuntimeOptions): Promise<TaskMetricsRuntime> {
    const scope = await taskMetricsScope(options.identity.taskId)
    const host = new MetricsFlushHost({ scope, workerPath: options.workerPath })
    const attachment = attachTaskMetrics({ identity: options.identity, host })
    // The reader owns its own connection: a worker-written file can be read while the
    // worker is busy. It opens readonly because this backend runs a read transaction as
    // `BEGIN IMMEDIATE`, which would otherwise contend for the write lock with the very
    // worker it is trying to read around.
    const reader = new MetricsQueryService({
        reads: {
            usage: async (readOptions) => await withReadRepository(scope, (repository) => repository.usage(readOptions)),
            performance: async (readOptions) =>
                await withReadRepository(scope, (repository) => repository.performance(readOptions)),
            acceptanceFloorMs: async () => await withReadRepository(scope, (repository) => repository.acceptanceFloorMs()),
        },
        health: () => host.snapshot(),
    })
    if (options.startImmediately) attachment.start()
    // A deletion path has no reference to this runtime, so the writer announces itself
    // where that path can find and stop it. Deregistering on release keeps an idle Task
    // from looking like a live writer forever.
    const forget = registerTaskMetricsWriter(options.identity.taskId, () => attachment.release())
    return {
        attachment: {
            emitter: attachment.emitter,
            start: () => attachment.start(),
            async release() {
                const outcome = await attachment.release()
                // Deregister only after the writer proves it stopped. A writer that could
                // not terminate still holds the database on its own thread, which this
                // process's reference count cannot see: removing the registration here
                // would let a deletion conclude the file is free and remove it.
                if (outcome.released) forget()
                return outcome
            },
        },
        scope,
        reader,
        host,
    }
}

/**
 * Report why metrics could not be wired, without failing the Task that needed them.
 *
 * A metrics failure is a degraded feature, never a Task failure: the caller logs and
 * continues with a Task that simply records no unified numbers.
 */
/**
 * Read through a connection of the reader's own, opened readonly.
 *
 * Each call opens and releases its connection, so a reader that is never used never
 * holds a file open, which a Task deletion depends on.
 */
async function withReadRepository<TResult>(
    scope: MetricsScope,
    read: (repository: MetricsRepository) => Promise<TResult>,
): Promise<TResult> {
    const repository = await MetricsRepository.open({ scope, readOnly: true })
    try {
        return await read(repository)
    } finally {
        await repository.close().catch(() => undefined)
    }
}

export function reportMetricsUnavailable(taskId: string, error: unknown): void {
    Logger.warn(
        `[Task ${taskId}] Unified metrics are unavailable; the task continues without them: ${
            error instanceof Error ? error.message : String(error)
        }`,
    )
}
