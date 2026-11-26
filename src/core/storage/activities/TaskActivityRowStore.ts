import { readFile, rename } from "node:fs/promises"
import path from "node:path"
import type { TaskActivityRecord } from "@shared/task-activity"
import type { UnifyStore } from "../backend/api/UnifyStore"
import { asc, desc, eq, lt } from "../backend/api/UnifyStoreQuery"
import { ensureInstanceLayout, InstanceDatabase, openInstanceStorage } from "../instance"
import { TaskActivityRow } from "./TaskActivityRow"

/** The one module that writes `activities.db`. */
export const TASK_ACTIVITY_WRITER = "task-activity-store"

/** File that held the activity history before `activities.db`. */
export const LEGACY_ACTIVITY_FILE = "activities.json"

export const LEGACY_ACTIVITY_MIGRATED_SUFFIX = ".migrated"

/** Maximum persisted activities hydrated into memory on task open or resume. */
export const DEFAULT_HYDRATE_ACTIVITY_LIMIT = 100

/**
 * Cumulative payload ceiling for hydrated activity history.
 *
 * A single subagent activity can retain hundreds of events totalling several megabytes,
 * so a row count cap alone cannot prevent a long-running task from loading hundreds of
 * megabytes into V8 memory on resume.
 */
export const DEFAULT_HYDRATE_BYTE_BUDGET = 8 * 1024 * 1024

/** Raw text of a legacy activity file; decoding belongs to the activity owner. */
export interface LegacyActivityFile {
    readonly file: string
    readonly text: string
}

export interface ReadRecentActivitiesOptions {
    readonly limit?: number
    readonly byteBudget?: number
    readonly shouldContinue?: () => boolean
}

const CREATED_AT = TaskActivityRow.storage.fields.createdAt
const ACTIVITY_ID = TaskActivityRow.storage.fields.activityId
const INCREMENTAL_READ_BATCH_SIZE = 8

function isMissingFile(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
}

function isTransientStatus(status: TaskActivityRecord["status"]): boolean {
    return status === "awaiting_approval" || status === "running" || status === "cancelling"
}

/** Fast structural size estimate for bounding hydration without allocating a JSON string. */
export function estimateActivityRecordBytes(record: TaskActivityRecord): number {
    let bytes =
        256 +
        record.activityId.length +
        record.title.length +
        (record.detail?.length ?? 0) +
        (record.latestEvent?.length ?? 0) +
        (record.output?.length ?? 0) +
        (record.result?.length ?? 0) +
        (record.error?.length ?? 0) +
        (record.retryUnavailableReason?.length ?? 0) +
        (record.retryRecipe ? record.retryRecipe.task.length + record.retryRecipe.prompt.length + 128 : 0)
    for (const event of record.events) {
        bytes += 96
        if ("text" in event && typeof event.text === "string") bytes += event.text.length
        if ("summary" in event && typeof event.summary === "string") bytes += event.summary.length
        if ("error" in event && typeof event.error === "string") bytes += event.error.length
    }
    return bytes
}

/**
 * Activity rows of one task in `activities.db`, written only by the task's activity store.
 *
 * A save writes the activities that changed in one transaction, so a reader never
 * sees half of a save and an unchanged activity is never rewritten.
 */
export class TaskActivityRowStore {
    private constructor(
        private readonly root: string,
        private readonly rows: UnifyStore<TaskActivityRow>,
        private readonly release: () => Promise<void>,
    ) {}

    static async open(taskId: string): Promise<TaskActivityRowStore> {
        const layout = await ensureInstanceLayout({ taskId })
        const storage = openInstanceStorage(layout.root)
        try {
            const database = await storage.openDatabase(InstanceDatabase.Activities, TASK_ACTIVITY_WRITER)
            const rows = await database.openStore(TaskActivityRow)
            return new TaskActivityRowStore(layout.root, rows, () => storage.close())
        } catch (error) {
            await storage.close().catch(() => undefined)
            throw error
        }
    }

    /** Stored activities, newest first like the activity list. */
    async read(): Promise<TaskActivityRecord[]> {
        const { records } = await this.rows.query({ orderBy: [desc(CREATED_AT), asc(ACTIVITY_ID)] })
        return records.map((row) => row.record)
    }

    /** Look up one persisted activity by its primary key without scanning history. */
    async readById(activityId: string): Promise<TaskActivityRecord | undefined> {
        const { records } = await this.rows.query({
            where: eq(ACTIVITY_ID, activityId),
            limit: 1,
        })
        return records[0]?.record
    }

    /**
     * Read the newest persisted activities within both row-count and byte budgets,
     * yielding between small batches so lifecycle and capability RPCs never stall.
     *
     * Keyset pagination on the indexed integer `createdAt` uses `createdAt < boundary + 1`
     * with a boundary tie allowance so equal-millisecond batches never skip or duplicate rows.
     */
    async readRecent(options: ReadRecentActivitiesOptions = {}): Promise<TaskActivityRecord[]> {
        const maxRows = Math.max(1, options.limit ?? DEFAULT_HYDRATE_ACTIVITY_LIMIT)
        const byteBudget = Math.max(1, options.byteBudget ?? DEFAULT_HYDRATE_BYTE_BUDGET)
        const shouldContinue = options.shouldContinue ?? (() => true)

        const activities: TaskActivityRecord[] = []
        const seenIds = new Set<string>()
        let loadedBytes = 0
        let boundaryCreatedAt: number | undefined
        let countAtBoundary = 0

        while (shouldContinue() && activities.length < maxRows) {
            const remaining = maxRows - activities.length
            const batchTarget = Math.min(INCREMENTAL_READ_BATCH_SIZE, remaining)
            const queryLimit = boundaryCreatedAt === undefined ? batchTarget : batchTarget + countAtBoundary
            const { records } = await this.rows.query({
                ...(boundaryCreatedAt !== undefined ? { where: lt(CREATED_AT, boundaryCreatedAt + 1) } : {}),
                orderBy: [desc(CREATED_AT), asc(ACTIVITY_ID)],
                limit: queryLimit,
            })
            if (!shouldContinue()) return []

            let addedInBatch = 0
            let budgetReached = false
            for (const row of records) {
                if (seenIds.has(row.activityId)) continue
                const record = row.record
                const recordBytes = estimateActivityRecordBytes(record)
                const transient = isTransientStatus(record.status)
                if (activities.length > 0 && !transient && loadedBytes + recordBytes > byteBudget) {
                    budgetReached = true
                    break
                }
                seenIds.add(row.activityId)
                activities.push(record)
                loadedBytes += recordBytes
                addedInBatch += 1
                if (row.createdAt === boundaryCreatedAt) {
                    countAtBoundary += 1
                } else {
                    boundaryCreatedAt = row.createdAt
                    countAtBoundary = 1
                }
                if (activities.length >= maxRows) break
            }

            if (budgetReached || activities.length >= maxRows || records.length < queryLimit || addedInBatch === 0) {
                break
            }
            await new Promise<void>((resolve) => setImmediate(resolve))
        }
        return shouldContinue() ? activities : []
    }

    /**
     * Read bounded recent activities incrementally, aborting immediately when the
     * caller stops needing the snapshot (for example during display promotion).
     */
    readIncrementally(shouldContinue: () => boolean): Promise<TaskActivityRecord[]> {
        return this.readRecent({ shouldContinue })
    }

    /** Inserts `activities` or overwrites the stored ones with the same id; others are left alone. */
    upsert(activities: readonly TaskActivityRecord[]): Promise<void> {
        if (activities.length === 0) return Promise.resolve()
        return this.rows.upsert(activities.map((record) => new TaskActivityRow(record)))
    }

    /** The legacy file of this task, or undefined when there is none. */
    async readLegacy(): Promise<LegacyActivityFile | undefined> {
        const file = path.join(this.root, LEGACY_ACTIVITY_FILE)
        try {
            return { file, text: await readFile(file, "utf8") }
        } catch (error) {
            if (isMissingFile(error)) return undefined
            throw error
        }
    }

    /** Renames an imported legacy file so it is kept but never read again. */
    async retireLegacy(file: string): Promise<void> {
        await rename(file, `${file}${LEGACY_ACTIVITY_MIGRATED_SUFFIX}`)
    }

    close(): Promise<void> {
        return this.release()
    }
}
