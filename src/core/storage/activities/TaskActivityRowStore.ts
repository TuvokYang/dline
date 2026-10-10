import { readFile, rename } from "node:fs/promises"
import path from "node:path"
import type { TaskActivityRecord } from "@shared/task-activity"
import type { UnifyStore } from "../backend/api/UnifyStore"
import { asc, desc } from "../backend/api/UnifyStoreQuery"
import { ensureInstanceLayout, InstanceDatabase, openInstanceStorage } from "../instance"
import { TaskActivityRow } from "./TaskActivityRow"

/** The one module that writes `activities.db`. */
export const TASK_ACTIVITY_WRITER = "task-activity-store"

/** File that held the activity history before `activities.db`. */
export const LEGACY_ACTIVITY_FILE = "activities.json"

export const LEGACY_ACTIVITY_MIGRATED_SUFFIX = ".migrated"

/** Raw text of a legacy activity file; decoding belongs to the activity owner. */
export interface LegacyActivityFile {
    readonly file: string
    readonly text: string
}

const CREATED_AT = TaskActivityRow.storage.fields.createdAt
const ACTIVITY_ID = TaskActivityRow.storage.fields.activityId

function isMissingFile(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
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
