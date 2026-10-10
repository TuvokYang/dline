import getFolderSize from "get-folder-size"
import path from "path"
import { getDlineCheckpointsDir, getDlineDocumentsPath } from "@/core/storage/disk"
import { Logger } from "@/shared/services/Logger"

/**
 * Gets the total size of tasks and checkpoints directories
 * @returns The total size in bytes, or null if calculation fails
 */
export async function getTotalTasksSize(): Promise<number | null> {
    const tasksDir = path.join(await getDlineDocumentsPath(), "tasks")
    const checkpointsDir = await getDlineCheckpointsDir()

    try {
        const tasksSize = await getFolderSize.loose(tasksDir)
        const checkpointsSize = await getFolderSize.loose(checkpointsDir)
        return tasksSize + checkpointsSize
    } catch (error) {
        Logger.error("Failed to calculate total task size:", error)
        return null
    }
}
