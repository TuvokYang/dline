import { getDlineDocumentsPath, getSavedClineMessages, getTaskMetadata } from "@core/storage/disk"
import { StateManager } from "@core/storage/StateManager"
import { readTaskConversation } from "@core/task/conversation/TaskConversationReader"
import { readWorkingDirectoryHeader } from "@core/task/environment/working-directory-header"
import { MessageUsageProjection } from "@core/task/performance/MessageUsageProjection"
import { HostProvider } from "@hosts/host-provider"
import { UiMessage } from "@shared/ExtensionMessage"
import type { ApiMetrics } from "@shared/getApiMetrics"
import { HistoryItem } from "@shared/HistoryItem"
import type { ClineStorageMessage } from "@shared/messages/content"
import { ShowMessageType } from "@shared/proto/dline/host/window"
import { Logger } from "@shared/services/Logger"
import { fileExistsAtPath } from "@utils/fs"
import * as path from "path"
import { ulid } from "ulid"

interface TaskReconstructionResult {
    /** Task folders found on disk. */
    totalTasks: number
    /** Folders the index already listed; their entries are kept as recorded. */
    preservedTasks: number
    /** Folders the index did not list and that were rebuilt into it. */
    reconstructedTasks: number
    /** Index entries dropped because their folder no longer exists. */
    removedTasks: number
    skippedTasks: number
    errors: string[]
}

/** Task folders are named by the numeric task id. */
const TASK_FOLDER_NAME = /^\d+$/

export interface TaskHistoryRebuildPlan {
    /** Indexed tasks without a folder on disk. */
    readonly removedTaskIds: ReadonlySet<string>
    /** Task folders the index does not list. */
    readonly missingTaskIds: readonly string[]
}

/**
 * Decide what a rebuild changes, keeping every entry whose folder still exists.
 *
 * An existing entry is the live record of its task: the workspace it ran in,
 * its favorite flag and its completion state are written while the task runs
 * and cannot be recovered from the folder. Rebuilding those entries from disk
 * would drop the workspace, which empties the current-workspace history view.
 *
 * @param indexedTaskIds Ids the history index currently lists.
 * @param folderNames Names of every directory under `tasks/`.
 */
export function planTaskHistoryRebuild(
    indexedTaskIds: Iterable<string>,
    folderNames: ReadonlySet<string>,
): TaskHistoryRebuildPlan {
    const indexed = new Set(indexedTaskIds)
    return {
        removedTaskIds: new Set([...indexed].filter((taskId) => !folderNames.has(taskId))),
        missingTaskIds: [...folderNames].filter((name) => TASK_FOLDER_NAME.test(name) && !indexed.has(name)),
    }
}

/**
 * Reconstructs task history from existing task folders
 * @returns Reconstruction result or null if cancelled
 */
export async function reconstructTaskHistory(): Promise<TaskReconstructionResult | null> {
    try {
        // Show confirmation dialog using HostProvider
        const proceed = await HostProvider.window.showMessage({
            type: ShowMessageType.WARNING,
            message:
                "This will rebuild your task history index from the task folders on disk. Tasks missing from the index are added and entries whose folder no longer exists are removed; existing entries keep their workspace, favorite and completion state. Continue?",
            options: {
                items: ["Yes, Reconstruct", "Cancel"],
            },
        })

        if (proceed?.selectedOption !== "Yes, Reconstruct") {
            return null
        }

        HostProvider.window.showMessage({
            type: ShowMessageType.INFORMATION,
            message: "Reconstructing task history...",
        })

        const result = await performTaskHistoryReconstruction()

        // Show results
        if (result.errors.length > 0) {
            const errorMessage = `Reconstruction completed with warnings:\n- Added: ${result.reconstructedTasks} tasks\n- Kept: ${result.preservedTasks} tasks\n- Removed: ${result.removedTasks} entries\n- Skipped: ${result.skippedTasks} tasks\n- Errors: ${result.errors.length}\n\nFirst few errors:\n${result.errors.slice(0, 3).join("\n")}`

            HostProvider.window.showMessage({
                type: ShowMessageType.WARNING,
                message: errorMessage,
            })
        } else {
            HostProvider.window.showMessage({
                type: ShowMessageType.INFORMATION,
                message: `Task history rebuilt: added ${result.reconstructedTasks} tasks, kept ${result.preservedTasks}, removed ${result.removedTasks} entries without a task folder.`,
            })
        }

        return result
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        HostProvider.window.showMessage({
            type: ShowMessageType.ERROR,
            message: `Failed to reconstruct task history: ${errorMessage}`,
        })
        return null
    }
}

async function performTaskHistoryReconstruction(): Promise<TaskReconstructionResult> {
    const result: TaskReconstructionResult = {
        totalTasks: 0,
        preservedTasks: 0,
        reconstructedTasks: 0,
        removedTasks: 0,
        skippedTasks: 0,
        errors: [],
    }

    // Get tasks directory
    const tasksDir = path.join(await getDlineDocumentsPath(), "tasks")

    // Check if tasks directory exists
    if (!(await fileExistsAtPath(tasksDir))) {
        throw new Error("No tasks directory found. Nothing to reconstruct.")
    }

    const folderNames = await scanTaskDirectories(tasksDir)
    result.totalTasks = [...folderNames].filter((name) => TASK_FOLDER_NAME.test(name)).length

    if (result.totalTasks === 0) {
        throw new Error("No task directories found. Nothing to reconstruct.")
    }

    const stateManager = StateManager.get()
    const indexed = await stateManager.taskHistory.getDeduplicatedWithPendingWrites()
    const plan = planTaskHistoryRebuild(
        indexed.map((item) => item.id),
        folderNames,
    )
    result.removedTasks = plan.removedTaskIds.size
    result.preservedTasks = indexed.length - plan.removedTaskIds.size

    const reconstructedItems: HistoryItem[] = []
    for (const taskId of plan.missingTaskIds) {
        try {
            const historyItem = await reconstructTaskHistoryItem(taskId)
            if (historyItem) {
                reconstructedItems.push(historyItem)
                result.reconstructedTasks++
            } else {
                result.skippedTasks++
            }
        } catch (error) {
            result.skippedTasks++
            const errorMsg = error instanceof Error ? error.message : String(error)
            result.errors.push(`Task ${taskId}: ${errorMsg}`)
        }
    }

    // Refresh the in-memory cache from the committed result so open views neither
    // keep serving dropped entries nor miss the ones just added.
    const persisted = await stateManager.taskHistory.reconcile({
        removedTaskIds: plan.removedTaskIds,
        addedItems: reconstructedItems,
    })
    stateManager.setGlobalStateBatch({ taskHistory: persisted })

    return result
}

/** Names of every directory under `tasks/`, so an indexed task is only dropped when its folder is really gone. */
async function scanTaskDirectories(tasksDir: string): Promise<Set<string>> {
    const fs = await import("fs/promises")

    try {
        const entries = await fs.readdir(tasksDir, { withFileTypes: true })
        return new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
    } catch (error) {
        throw new Error(`Failed to scan tasks directory: ${error}`)
    }
}

async function reconstructTaskHistoryItem(taskId: string): Promise<HistoryItem | null> {
    try {
        // Load UI messages to extract task info
        const clineMessages = await getSavedClineMessages(taskId)
        if (clineMessages.length === 0) {
            return null // Skip empty tasks
        }

        // Load task metadata for token usage
        const metadata = await getTaskMetadata(taskId)

        // Extract task information
        // The same projection the task's history row aggregates: every message after the task text.
        const usage = clineMessages.some(carriesUsage) ? new MessageUsageProjection().read(clineMessages.slice(1)) : undefined
        const taskInfo = extractTaskInformation(clineMessages, metadata, usage)

        // Create HistoryItem
        const historyItem: HistoryItem = {
            id: taskId,
            ulid: taskInfo.ulid || ulid(), // Generate new ULID if missing
            ts: taskInfo.timestamp,
            task: taskInfo.taskDescription,
            tokensIn: taskInfo.tokensIn,
            tokensOut: taskInfo.tokensOut,
            cacheWrites: taskInfo.cacheWrites,
            cacheReads: taskInfo.cacheReads,
            totalCost: taskInfo.totalCost,
            size: taskInfo.size,
            isFavorited: taskInfo.isFavorited,
            conversationHistoryDeletedRange: taskInfo.conversationHistoryDeletedRange,
            cwdOnTaskInitialization: await readTaskWorkingDirectory(taskId),
        }

        return historyItem
    } catch (error) {
        throw new Error(`Failed to reconstruct task ${taskId}: ${error}`)
    }
}

/**
 * Recover the workspace a task ran in from the environment header of its first request.
 *
 * Besides the lost history entry, that request is the only record of the
 * workspace, and the current-workspace history view filters on it. A task whose
 * request cannot be read still belongs in the index; it only loses that filter.
 */
async function readTaskWorkingDirectory(taskId: string): Promise<string | undefined> {
    try {
        const firstRequest = (await readTaskConversation(taskId)).find((message) => message.role === "user")
        const workingDirectory = firstRequest ? readWorkingDirectoryHeader(requestText(firstRequest)) : undefined
        return workingDirectory ? path.normalize(workingDirectory) : undefined
    } catch (error) {
        Logger.warn(`[ReconstructTaskHistory] Could not read the workspace of task ${taskId}:`, error)
        return undefined
    }
}

function requestText(message: ClineStorageMessage): string {
    if (typeof message.content === "string") return message.content
    return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n")
}

/** Rows whose text the usage projection reads; without any, only legacy metadata knows the usage. */
function carriesUsage(message: UiMessage): boolean {
    return (
        message.type === "say" &&
        (message.say === "api_req_started" ||
            message.say === "api_req_finished" ||
            message.say === "deleted_api_reqs" ||
            message.say === "subagent_usage")
    )
}

interface TaskInfo {
    ulid?: string
    timestamp: number
    taskDescription: string
    tokensIn: number
    tokensOut: number
    cacheWrites?: number
    cacheReads?: number
    totalCost: number
    size?: number
    isFavorited?: boolean
    conversationHistoryDeletedRange?: [number, number]
}

function extractTaskInformation(clineMessages: UiMessage[], metadata: any, usage: Readonly<ApiMetrics> | undefined): TaskInfo {
    // Find the first user message (task description)
    const firstUserMessage = clineMessages.find((msg) => msg.type === "say" && msg.say === "text" && msg.text)

    // Extract timestamp from first message or use task ID as fallback
    const timestamp = clineMessages.length > 0 ? clineMessages[0].ts : Date.now()

    // Extract task description
    let taskDescription = "Untitled Task"
    if (firstUserMessage?.text) {
        // Clean up the task description
        const cleanText = firstUserMessage.text
            .replace(/<task>\s*/g, "")
            .replace(/\s*<\/task>/g, "")
            .trim()

        const firstLine = cleanText.split("\n")[0]
        if (firstLine) {
            taskDescription = firstLine.substring(0, 100) // Limit length
        }
    }

    // Usage belongs to the metrics module, not the history-index reconstruction.
    let tokensIn = usage?.totalTokensIn ?? 0
    let tokensOut = usage?.totalTokensOut ?? 0
    let cacheWrites = usage?.totalCacheWrites ?? 0
    let cacheReads = usage?.totalCacheReads ?? 0
    let totalCost = usage?.totalCost ?? 0

    // Legacy tasks may carry usage only in metadata: their rows predate per-message
    // token counts, so the message projection is either absent or sums to zero.
    if (tokensIn === 0 && tokensOut === 0 && metadata.model_usage) {
        for (const usage of metadata.model_usage) {
            tokensIn += usage.tokensIn || 0
            tokensOut += usage.tokensOut || 0
            cacheWrites += usage.cacheWrites || 0
            cacheReads += usage.cacheReads || 0
            totalCost += usage.totalCost || 0
        }
    }

    // Calculate approximate size (rough estimate)
    const messageSize = JSON.stringify(clineMessages).length
    const size = Math.floor(messageSize / 1024) // KB

    return {
        timestamp,
        taskDescription,
        tokensIn,
        tokensOut,
        cacheWrites: cacheWrites > 0 ? cacheWrites : undefined,
        cacheReads: cacheReads > 0 ? cacheReads : undefined,
        totalCost,
        size,
    }
}
