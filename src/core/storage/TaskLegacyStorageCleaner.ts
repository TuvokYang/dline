import fs from "node:fs/promises"
import path from "node:path"

const LEGACY_TASK_DIRECTORIES = ["context-compaction-recovery"] as const

export interface TaskLegacyStorageCleanupResult {
    readonly removed: string[]
    readonly failed: Array<{ name: string; error: unknown }>
}

type RemoveDirectory = (directory: string) => Promise<void>

/** Removes allowlisted legacy storage after the caller has acquired the Task lock. */
export class TaskLegacyStorageCleaner {
    constructor(
        private readonly removeDirectory: RemoveDirectory = async (directory) =>
            fs.rm(directory, { recursive: true, force: true }),
    ) {}

    async cleanLockedTask(taskDirectory: string): Promise<TaskLegacyStorageCleanupResult> {
        const removed: string[] = []
        const failed: Array<{ name: string; error: unknown }> = []
        for (const name of LEGACY_TASK_DIRECTORIES) {
            try {
                await this.removeDirectory(path.join(taskDirectory, name))
                removed.push(name)
            } catch (error) {
                failed.push({ name, error })
            }
        }
        return { removed, failed }
    }
}
