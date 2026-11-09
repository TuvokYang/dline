/**
 * What a Task directory deletion has to prove before removing `metrics.db`.
 *
 * A Task's unified metrics database is held by two kinds of owner that the instance
 * storage registry does not see:
 *
 * - the background writer, whose SQLite handle lives on a worker thread;
 * - read-only leases taken by a history view, which the process-wide SQLite registry
 *   tracks per path but `closeInstanceStoragesUnder` does not close.
 *
 * Removing a directory while either holds the file leaves `metrics.db`, `-wal` or
 * `-shm` behind on Windows, so the deletion would report success over a half-removed
 * task. This module answers exactly one question — may this database be deleted now —
 * and reports why not instead of assuming safety.
 */

import { sqliteUnifyStoreRegistry } from "@core/storage/backend/sqlite/SqliteUnifyStore"
import { Logger } from "@shared/services/Logger"

/** The bounded answer a deletion path acts on. */
export interface MetricsDeletionOutcome {
    /** True only when no writer and no lease still holds the database. */
    readonly released: boolean
    /** Why the database is still held, when it is. */
    readonly reason?: string
}

/** Stops one writer; every implementation reports whether it really stopped. */
export type MetricsWriterStop = () => Promise<{ readonly released: boolean; readonly reason?: string }>

/** Writers registered per Task; a Task normally has at most one, but subagents may add one. */
const writersByTask = new Map<string, Set<MetricsWriterStop>>()

/** How often the release wait re-reads the registry. */
const RELEASE_POLL_INTERVAL_MS = 25

/** Default budget for read-only leases to drain: a view closing is not a disk operation. */
export const DEFAULT_LEASE_RELEASE_TIMEOUT_MS = 2_000

/**
 * Announce a writer that holds `taskId`'s metrics database.
 *
 * Returns the deregistration to run once the writer is gone. Registration is what lets
 * a deletion stop a writer it has no object reference to, which is the only case the
 * two deletion exits share.
 */
export function registerTaskMetricsWriter(taskId: string, stop: MetricsWriterStop): () => void {
    const writers = writersByTask.get(taskId) ?? new Set<MetricsWriterStop>()
    writers.add(stop)
    writersByTask.set(taskId, writers)
    return () => {
        const current = writersByTask.get(taskId)
        if (!current) return
        current.delete(stop)
        if (current.size === 0) writersByTask.delete(taskId)
    }
}

/** Whether any writer is registered for `taskId`; diagnostics and tests read this. */
export function hasTaskMetricsWriter(taskId: string): boolean {
    return (writersByTask.get(taskId)?.size ?? 0) > 0
}

/**
 * Stop every writer registered for `taskId`.
 *
 * A writer that cannot confirm it stopped fails the whole outcome: the caller is about
 * to delete the file that writer still holds, so a partial success is not usable.
 */
export async function stopTaskMetricsWriters(taskId: string): Promise<MetricsDeletionOutcome> {
    const writers = [...(writersByTask.get(taskId) ?? [])]
    if (writers.length === 0) return { released: true }
    const results = await Promise.allSettled(writers.map((stop) => stop()))
    const failures: string[] = []
    for (const result of results) {
        if (result.status === "rejected") {
            failures.push(result.reason instanceof Error ? result.reason.message : String(result.reason))
            continue
        }
        if (!result.value.released) failures.push(result.value.reason ?? "metrics writer did not stop")
    }
    if (failures.length > 0) return { released: false, reason: failures.join("; ") }
    return { released: true }
}

/**
 * Wait until no connection in this process still holds `databasePath`.
 *
 * The count covers both the writable entry and its `:readonly` counterpart, so a
 * history view that has not closed yet keeps the deletion waiting instead of being
 * silently ignored. A budget is required: an unrelated window holding the task is a
 * real failure to report, not a reason to hang the deletion.
 */
export async function waitForMetricsDatabaseRelease(
    databasePath: string,
    timeoutMs: number = DEFAULT_LEASE_RELEASE_TIMEOUT_MS,
): Promise<MetricsDeletionOutcome> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
        const outstanding = sqliteUnifyStoreRegistry.getReferenceCount(databasePath)
        if (outstanding === 0) return { released: true }
        if (Date.now() >= deadline) {
            return {
                released: false,
                reason: `${outstanding} connection(s) still hold ${databasePath} after ${timeoutMs}ms`,
            }
        }
        await delay(RELEASE_POLL_INTERVAL_MS)
    }
}

/**
 * The single protocol both deletion exits use.
 *
 * Order matters: new writers are stopped first, then the leases they and any reader
 * held are allowed to drain. Stopping the writer last would let it take a fresh lease
 * while the earlier check was already satisfied.
 */
export async function releaseTaskMetricsBeforeDeletion(options: {
    readonly taskId: string
    readonly databasePath: string
    readonly leaseTimeoutMs?: number
}): Promise<MetricsDeletionOutcome> {
    const stopped = await stopTaskMetricsWriters(options.taskId)
    if (!stopped.released) return stopped
    const drained = await waitForMetricsDatabaseRelease(options.databasePath, options.leaseTimeoutMs)
    if (!drained.released) {
        Logger.warn(`[MetricsDeletion] Task ${options.taskId} keeps its metrics database: ${drained.reason ?? "unknown"}`)
    }
    return drained
}

/** Forget every registration; tests and a full runtime reset use it. */
export function resetTaskMetricsDeletionGuard(): void {
    writersByTask.clear()
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}
