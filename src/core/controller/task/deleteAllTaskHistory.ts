import { releaseTaskMetricsBeforeDeletion } from "@core/metrics/MetricsDeletionGuard"
import { DeleteAllTaskHistoryCount } from "@shared/proto/dline/task"
import fs from "fs/promises"
import path from "path"
import { getDlineCheckpointsDir, getDlineDocumentsPath } from "@/core/storage/disk"
import { closeInstanceStoragesUnder } from "@/core/storage/instance"
import { findExistingTaskMetricsDatabase } from "@/core/storage/task-metrics-database"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageRequest, ShowMessageType } from "@/shared/proto/dline/host/window"
import { Logger } from "@/shared/services/Logger"
import { fileExistsAtPath } from "../../../utils/fs"
import { Controller } from ".."

/**
 * Deletes all task history, with an option to preserve favorites
 * @param controller The controller instance
 * @param request Request with option to preserve favorites
 * @returns Results with count of deleted tasks
 */
export async function deleteAllTaskHistory(controller: Controller): Promise<DeleteAllTaskHistoryCount> {
    try {
        // Clear current task first
        await controller.clearTask({ clearPanelState: true, closeReason: "task_delete" })

        // Get existing task history
        const taskHistory = controller.stateManager.getGlobalStateKey("taskHistory")
        const totalTasks = taskHistory.length

        const userChoice = (
            await HostProvider.window.showMessage(
                ShowMessageRequest.create({
                    type: ShowMessageType.WARNING,
                    message: "What would you like to delete?",
                    options: {
                        modal: true,
                        items: ["Delete All Except Favorites", "Delete Everything"],
                    },
                }),
            )
        ).selectedOption

        // Default VS Code Cancel button returns `undefined` - don't delete anything
        if (userChoice === undefined) {
            return DeleteAllTaskHistoryCount.create({
                tasksDeleted: 0,
            })
        }

        // If preserving favorites, filter out non-favorites
        if (userChoice === "Delete All Except Favorites") {
            const favoritedTasks = taskHistory.filter((task) => task.isFavorited === true)

            // If there are favorited tasks, update state
            if (favoritedTasks.length > 0) {
                controller.stateManager.setGlobalState("taskHistory", favoritedTasks)

                // The store owns the index; deleting there keeps the durable rows
                // and the cache in agreement.
                await controller.stateManager.taskHistory.deleteAllExceptFavorites()

                // Delete non-favorited task directories
                const preserveTaskIds = favoritedTasks.map((task) => task.id)
                const removed = await cleanupTaskFiles(preserveTaskIds)
                if (removed.length < totalTasks - favoritedTasks.length) {
                    HostProvider.window.showMessage({
                        type: ShowMessageType.WARNING,
                        message: `${totalTasks - favoritedTasks.length - removed.length} task(s) could not be removed and were kept.`,
                    })
                }

                // Update webview
                try {
                    await controller.postStateToWebview()
                } catch (webviewErr) {
                    Logger.error("Error posting to webview:", webviewErr)
                }

                return DeleteAllTaskHistoryCount.create({
                    // Only the directories that were really removed are counted. A task
                    // whose metrics database could not be released is kept on disk, so
                    // reporting the requested count would claim a deletion that did not
                    // happen.
                    tasksDeleted: removed.length,
                })
            }
            // No favorited tasks found - show warning and ask user what to do
            const answer = (
                await HostProvider.window.showMessage({
                    type: ShowMessageType.WARNING,
                    message: "No favorited tasks found. Would you like to delete all tasks anyway?",
                    options: {
                        modal: true,
                        items: ["Delete All Tasks"],
                    },
                })
            ).selectedOption

            // User cancelled - don't delete anything
            if (answer === undefined) {
                return DeleteAllTaskHistoryCount.create({
                    tasksDeleted: 0,
                })
            }
        }

        // Delete everything (not preserving favorites)
        controller.stateManager.setGlobalState("taskHistory", [])
        await controller.stateManager.taskHistory.clearAll()

        let removedCount = 0
        try {
            // Remove the per-task directories only. The task history database also
            // lives under `tasks/`, and it is open right now, so removing the whole
            // directory would either fail or destroy the store this process still
            // writes to.
            removedCount = (await cleanupTaskFiles([])).length

            // Remove checkpoints directory contents
            const checkpointsDirPath = await getDlineCheckpointsDir()
            if (await fileExistsAtPath(checkpointsDirPath)) {
                await fs.rm(checkpointsDirPath, { recursive: true, force: true })
            }
        } catch (error) {
            HostProvider.window.showMessage({
                type: ShowMessageType.ERROR,
                message: `Encountered error while deleting task history, there may be some files left behind. Error: ${error instanceof Error ? error.message : String(error)}`,
            })
        }

        // Update webview
        try {
            await controller.postStateToWebview()
        } catch (webviewErr) {
            Logger.error("Error posting to webview:", webviewErr)
        }

        return DeleteAllTaskHistoryCount.create({
            tasksDeleted: removedCount,
        })
    } catch (error) {
        Logger.error("Error in deleteAllTaskHistory:", error)
        throw error
    }
}

/**
 * Remove per-task directories, keeping the ones named in `preserveTaskIds`.
 *
 * Only directories are considered: `tasks/` also holds the task history
 * database, and deleting that file out from under the open store would discard
 * the index this process is still writing to.
 *
 * @returns the ids of the directories that were really removed. A directory whose
 * metrics database could not be released is kept and omitted, so a caller reporting
 * how many tasks it deleted cannot count a task that still exists on disk.
 */
async function cleanupTaskFiles(preserveTaskIds: string[]): Promise<string[]> {
    const taskDirPath = path.join(await getDlineDocumentsPath(), "tasks")
    const deleted: string[] = []

    try {
        if (await fileExistsAtPath(taskDirPath)) {
            const entries = await fs.readdir(taskDirPath, { withFileTypes: true })
            const taskDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
            Logger.debug(`[cleanupTaskFiles] Found ${taskDirs.length} task directories`)

            // Delete only non-preserved task directories
            for (const dir of taskDirs) {
                if (preserveTaskIds.includes(dir)) continue
                // Task dir path is not workspace specific
                const taskRoot = path.join(taskDirPath, dir)
                // The unified metrics database is held outside the instance storage
                // registry: its writer runs on a worker thread and a history view takes a
                // read-only lease. Removing the directory while either holds the file
                // leaves `metrics.db` behind, so release is proven first and a task that
                // cannot be released is reported as kept instead of counted as deleted.
                const metricsDatabase = await findExistingTaskMetricsDatabase(dir)
                if (metricsDatabase) {
                    const released = await releaseTaskMetricsBeforeDeletion({ taskId: dir, databasePath: metricsDatabase })
                    if (!released.released) {
                        Logger.warn(
                            `[cleanupTaskFiles] Keeping task ${dir}: metrics database was not released (${released.reason ?? "unknown"})`,
                        )
                        continue
                    }
                }
                await closeInstanceStoragesUnder(taskRoot)
                await fs.rm(taskRoot, {
                    recursive: true,
                    force: true,
                })
                deleted.push(dir)
            }
        }
    } catch (error) {
        Logger.error("Error cleaning up task files:", error)
    }

    return deleted
}
