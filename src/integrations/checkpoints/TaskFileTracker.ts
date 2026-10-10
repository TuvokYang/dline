import * as path from "path"
import { Logger } from "@/shared/services/Logger"
import { WorkspaceFileRegistry } from "./WorkspaceFileRegistry"

/**
 * TaskFileTracker (Per-Task Instance)
 *
 * Tracks file modifications for a single task and bridges to the global
 * WorkspaceFileRegistry for cross-task conflict detection.
 *
 * Each task creates one TaskFileTracker. Tool handlers call
 * `trackModification()` after successfully writing to a file, and the
 * checkpoint manager calls `getModifiedFiles()` to obtain the file list
 * for per-file checkpoint commits.
 *
 * Lifecycle:
 * - Created when a task starts (alongside CheckpointTracker)
 * - Tracks files throughout the task via tool handlers
 * - `dispose()` is called when the task ends, releasing all file ownership
 */
export class TaskFileTracker {
    private taskId: string
    private registry: WorkspaceFileRegistry

    /**
     * Files modified by this task, keyed by a case-insensitive lookup key.
     *
     * The value keeps the original spelling: it is handed to Git as a pathspec,
     * and a lower-cased name does not resolve on a case-sensitive filesystem.
     */
    private modifiedFiles = new Map<string, string>()
    /** Lifetime cache of files modified by this task. Used for Active Tasks env details. */
    private allModifiedFiles = new Map<string, string>()
    /** Whether command execution may have modified files outside explicit tracking. */
    private workspaceScanRequired = false

    /**
     * Create a new TaskFileTracker for a task.
     *
     * @param taskId - Unique task identifier
     */
    constructor(taskId: string) {
        this.taskId = taskId
        this.registry = WorkspaceFileRegistry.getInstance()
        Logger.debug(`[TaskFileTracker] Created for task ${taskId}`)
    }

    /**
     * Record a file modification by this task.
     * Registers with the global WorkspaceFileRegistry and updates local cache.
     *
     * @param filePath - Absolute or relative path to the modified file
     */
    trackModification(filePath: string): void {
        const absolutePath = path.resolve(filePath)
        const lookupKey = this.toLookupKey(absolutePath)

        this.allModifiedFiles.set(lookupKey, absolutePath)

        // Avoid duplicate registrations for the same file
        if (this.modifiedFiles.has(lookupKey)) {
            return
        }

        this.modifiedFiles.set(lookupKey, absolutePath)
        this.registry.registerModification(this.taskId, filePath)
        Logger.debug(`[TaskFileTracker] Task ${this.taskId} tracked modification of '${absolutePath}'`)
    }

    /**
     * Stop tracking paths the checkpoint layer proved it cannot stage.
     *
     * Without this, a path Git rejects stays in the pending set and is replayed
     * on every later checkpoint, so one bad path disables checkpoints for the
     * remainder of the task.
     *
     * @param filePaths - Absolute paths to drop from the pending set
     * @returns Number of paths actually removed
     */
    dropModifiedFiles(filePaths: string[]): number {
        let dropped = 0
        for (const filePath of filePaths) {
            if (this.modifiedFiles.delete(this.toLookupKey(path.resolve(filePath)))) {
                dropped += 1
            }
        }
        if (dropped > 0) {
            Logger.debug(`[TaskFileTracker] Dropped ${dropped} unstageable file(s) for task ${this.taskId}`)
        }
        return dropped
    }

    /** Case-insensitive de-duplication key; the stored value keeps real spelling. */
    private toLookupKey(absolutePath: string): string {
        return absolutePath.toLowerCase()
    }

    /**
     * Get all files modified by this task.
     *
     * @returns Array of absolute file paths
     */
    getModifiedFiles(): string[] {
        return Array.from(this.modifiedFiles.values())
    }

    /**
     * Get all files modified during this task lifetime.
     * @returns Array of normalized absolute file paths.
     */
    getAllModifiedFiles(): string[] {
        return Array.from(this.allModifiedFiles.values())
    }

    /**
     * Mark that this task may have modified files outside explicit tool tracking.
     */
    markWorkspaceScanRequired(): void {
        this.workspaceScanRequired = true
        Logger.debug(`[TaskFileTracker] Workspace scan required for task ${this.taskId}`)
    }

    /**
     * Return whether unknown file writes require a workspace scan before checkpoint.
     *
     * @returns true when command execution may have modified files.
     */
    isWorkspaceScanRequired(): boolean {
        return this.workspaceScanRequired
    }

    /**
     * Clear the unknown-write scan marker after checkpoint decision completes.
     */
    clearWorkspaceScanRequired(): void {
        this.workspaceScanRequired = false
        Logger.debug(`[TaskFileTracker] Cleared workspace scan marker for task ${this.taskId}`)
    }

    /**
     * Clear the local modified files cache after a successful checkpoint commit.
     * This resets tracking so the next checkpoint only captures newly modified files.
     * The global WorkspaceFileRegistry is intentionally left untouched — restore
     * scenarios need the full history of file ownership for per-file restore.
     */
    clearModifiedFiles(): void {
        this.modifiedFiles.clear()
        Logger.debug(`[TaskFileTracker] Cleared modified files for task ${this.taskId}`)
    }

    /**
     * Release all file ownership for this task.
     * Should be called when the task ends (completes, is cancelled, or errors out).
     */
    dispose(): void {
        // Do NOT release task from the global registry here — restore scenarios
        // (e.g. task terminated then restored from history) need the file list
        // to perform per-file restore. Registry entries are cleaned up by
        // releaseTask() only when explicitly called by external lifecycle hooks.
        this.modifiedFiles.clear()
        this.allModifiedFiles.clear()
        this.workspaceScanRequired = false
        Logger.debug(`[TaskFileTracker] Disposed for task ${this.taskId}`)
    }
}
