import { access, rename } from "node:fs/promises"
import path from "node:path"
import { Logger } from "@shared/services/Logger"
import { FileLock } from "./backend/jsonl/FileLock"
import { GlobalFileNames } from "./disk"
import { ensureInstanceLayout, InstanceDatabase, type InstanceLayout, resolveInstanceLayout } from "./instance"

/** Files SQLite keeps beside a database; they belong to it and move with it. */
const SQLITE_SIDE_FILES = ["-wal", "-shm"] as const

/** One move per metrics database in this process, so concurrent openers share the locked attempt. */
const pendingMoves = new Map<string, Promise<string>>()

/**
 * Location of the task's `metrics.db`, the one database every API metrics collection shares.
 *
 * A writer (the default) lays out the task directory and moves a pre-layout
 * `<task-id>.db` into place, with its WAL and shared-memory files, under a
 * cross-process lock. The move is all-or-nothing: a failure rolls the moved files
 * back, so the database is never split between two names, and a move that cannot
 * happen leaves the metrics readable where they are.
 *
 * A reader (`readOnly`) never creates or moves anything and rejects when the task
 * recorded no metrics; {@link findExistingTaskMetricsDatabase} tests for that first.
 *
 * @param location an explicit database path, used as is (tests and tools).
 */
export async function resolveTaskMetricsDatabase(taskId: string, location?: string, readOnly = false): Promise<string> {
    if (location) return location
    if (readOnly) {
        const existing = await findExistingTaskMetricsDatabase(taskId)
        if (!existing) throw new Error(`Task ${taskId} has no metrics database`)
        return existing
    }
    const layout = await ensureInstanceLayout({ taskId })
    const target = layout.database(InstanceDatabase.Metrics)
    const key = moveKey(target)
    let pending = pendingMoves.get(key)
    if (!pending) {
        pending = new FileLock().withLock(target, () => moveLegacyDatabase(layout, taskId, target))
        pendingMoves.set(key, pending)
        // Every attempt re-checks under the lock, so another process's move is observed too.
        const forget = () => pendingMoves.delete(key)
        void pending.then(forget, forget)
    }
    return pending
}

/**
 * The task's existing metrics database, without creating or moving anything.
 *
 * A history view reads what a past run recorded; it must not lay out a task
 * directory or migrate files for a task nobody is running. A move in progress,
 * in this process or another, is waited for, so a half-moved database is never
 * read. A task that never recorded metrics has none, and the view shows none.
 */
export async function findExistingTaskMetricsDatabase(taskId: string): Promise<string | undefined> {
    const layout = await resolveInstanceLayout({ taskId })
    const target = layout.database(InstanceDatabase.Metrics)
    await pendingMoves.get(moveKey(target))?.catch(() => undefined)
    await FileLock.waitUntilUnlocked(target)
    const legacy = legacyDatabase(layout, taskId)
    if (await exists(target)) {
        if (!(await exists(legacy)) && (await hasLegacySideFiles(legacy))) {
            throw new Error(`Task ${taskId} metrics move is incomplete; the next run of the task recovers it`)
        }
        return target
    }
    return (await exists(legacy)) ? legacy : undefined
}

function legacyDatabase(layout: InstanceLayout, taskId: string): string {
    return path.join(layout.root, GlobalFileNames.legacyTaskDatabase(taskId))
}

function moveKey(target: string): string {
    return process.platform === "win32" ? target.toLowerCase() : target
}

async function moveLegacyDatabase(layout: InstanceLayout, taskId: string, target: string): Promise<string> {
    const legacy = legacyDatabase(layout, taskId)
    const legacyExists = await exists(legacy)
    const targetExists = await exists(target)
    const recovering = targetExists && !legacyExists && (await hasLegacySideFiles(legacy))
    if ((targetExists && !recovering) || (!legacyExists && !recovering)) return target
    const moved: Array<{ source: string; destination: string }> = []
    try {
        for (const suffix of ["", ...SQLITE_SIDE_FILES]) {
            const source = `${legacy}${suffix}`
            const destination = `${target}${suffix}`
            if (!(await exists(source))) continue
            if (await exists(destination)) throw new Error("Task metrics destination already exists")
            await rename(source, destination)
            moved.push({ source, destination })
        }
        return target
    } catch (error) {
        // A sidecar failure must not leave the database split between two names.
        const rollbackErrors: unknown[] = []
        for (const { source, destination } of moved.reverse()) {
            try {
                await rename(destination, source)
            } catch (rollbackError) {
                rollbackErrors.push(rollbackError)
            }
        }
        if (rollbackErrors.length > 0) {
            throw new AggregateError([error, ...rollbackErrors], `Task metrics move could not be restored for ${taskId}`)
        }
        if (recovering) throw new Error("Task metrics move could not be recovered", { cause: error })
        Logger.warn(`[Task ${taskId}] Metrics database rename deferred; keeping the existing container`, error)
        return legacy
    }
}

async function hasLegacySideFiles(legacy: string): Promise<boolean> {
    for (const suffix of SQLITE_SIDE_FILES) {
        if (await exists(`${legacy}${suffix}`)) return true
    }
    return false
}

async function exists(location: string): Promise<boolean> {
    try {
        await access(location)
        return true
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
        throw error
    }
}
