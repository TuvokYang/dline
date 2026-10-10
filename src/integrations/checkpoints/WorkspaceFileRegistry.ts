import * as path from "path"
import { Logger } from "@/shared/services/Logger"

/**
 * Information about a file modification conflict.
 * Returned when two tasks attempt to modify the same file.
 */
export interface FileConflictInfo {
    /** The task that currently owns this file */
    ownerTaskId: string
    /** The task attempting to modify it */
    requesterTaskId: string
    /** Absolute path of the conflicting file */
    filePath: string
}

/**
 * WorkspaceFileRegistry (Global Singleton)
 *
 * Tracks which task owns each modified file, enabling per-task file-level
 * checkpointing and cross-task conflict detection. Each task only manages
 * checkpoints for files it actually modified, rather than running `git add .`
 * on the entire workspace.
 *
 * Thread-safety: Node.js is single-threaded with an event loop, so plain
 * Map operations are safe without additional synchronization primitives.
 *
 * Key responsibilities:
 * - Register file modifications per task
 * - Detect conflicts when multiple tasks modify the same file
 * - Provide file lists for per-task checkpoint commit/restore
 * - Release all file ownership when a task ends
 */
export class WorkspaceFileRegistry {
    private static instance: WorkspaceFileRegistry | null = null

    /** filePath (lowercased absolute) → owner metadata */
    private fileOwners = new Map<string, { ownerTaskId: string; modifiedAt: number }>()

    /** taskId → Set of file paths owned by that task */
    private taskFiles = new Map<string, Set<string>>()

    private constructor() {
        Logger.info("[WorkspaceFileRegistry] Singleton instance created")
    }

    /**
     * Get the global singleton instance.
     * Creates it on first access.
     */
    static getInstance(): WorkspaceFileRegistry {
        if (!WorkspaceFileRegistry.instance) {
            WorkspaceFileRegistry.instance = new WorkspaceFileRegistry()
        }
        return WorkspaceFileRegistry.instance
    }

    /**
     * Normalize a file path for consistent lookup across platforms.
     * Converts to lowercased absolute path.
     */
    private normalizePath(filePath: string): string {
        return path.resolve(filePath).toLowerCase()
    }

    /**
     * Record that a file was modified by a task.
     *
     * @param taskId - The task performing the modification
     * @param filePath - Absolute or relative path to the modified file
     */
    registerModification(taskId: string, filePath: string): void {
        const normalizedPath = this.normalizePath(filePath)

        // Check for conflicts (non-blocking — only logs a warning)
        const conflict = this.detectOwnershipConflict(taskId, normalizedPath)
        if (conflict) {
            Logger.warn(
                `[WorkspaceFileRegistry] Conflict detected: Task ${taskId} ` +
                    `attempted to modify '${normalizedPath}', but it is already owned by task ${conflict.ownerTaskId}. ` +
                    `This may cause checkpoint restore issues if both tasks are restored independently.`,
            )
        }

        // Register ownership
        this.fileOwners.set(normalizedPath, {
            ownerTaskId: taskId,
            modifiedAt: Date.now(),
        })

        // Add to task's file set
        if (!this.taskFiles.has(taskId)) {
            this.taskFiles.set(taskId, new Set())
        }
        this.taskFiles.get(taskId)?.add(normalizedPath)
    }

    /**
     * Detect if another task already owns a file.
     * Non-blocking — only reports the conflict, does not prevent the
     * modification. The caller should decide whether to proceed or abort.
     *
     * @param taskId - The task attempting the modification
     * @param filePath - Normalized absolute path
     */
    detectOwnershipConflict(taskId: string, filePath: string): FileConflictInfo | undefined {
        const normalizedPath = this.normalizePath(filePath)
        const owner = this.fileOwners.get(normalizedPath)

        if (owner && owner.ownerTaskId !== taskId) {
            return {
                ownerTaskId: owner.ownerTaskId,
                requesterTaskId: taskId,
                filePath: normalizedPath,
            }
        }

        return undefined
    }

    /**
     * Get all files modified by a specific task.
     *
     * @param taskId - The task to query
     * @returns Array of absolute file paths, or empty array if no files tracked
     */
    getTaskFiles(taskId: string): string[] {
        const files = this.taskFiles.get(taskId)
        if (!files || files.size === 0) {
            return []
        }
        return Array.from(files)
    }

    /**
     * Release all file ownership for a task.
     * Called when a task ends (completes, is cancelled, or errors out).
     *
     * @param taskId - The task to release
     */
    releaseTask(taskId: string): void {
        const files = this.taskFiles.get(taskId)
        if (!files) {
            return
        }

        for (const filePath of files) {
            const owner = this.fileOwners.get(filePath)
            // Only remove if the current task is still the owner
            if (owner && owner.ownerTaskId === taskId) {
                this.fileOwners.delete(filePath)
            }
        }

        this.taskFiles.delete(taskId)
        Logger.debug(`[WorkspaceFileRegistry] Released all files for task ${taskId}`)
    }
}
