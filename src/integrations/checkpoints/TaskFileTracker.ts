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
     * The path keeps the original spelling: it is handed to Git as a pathspec,
     * and a lower-cased name does not resolve on a case-sensitive filesystem.
     */
    private modifiedFiles = new Map<string, PendingPath>()
    /**
     * Paths the workspace watcher saw change since the last checkpoint, whoever
     * changed them. Unlike `modifiedFiles` they are never force-staged: the
     * checkpoint keeps only those the shadow repository does not exclude.
     */
    private observedFiles = new Map<string, PendingPath>()
    /** Lifetime cache of files modified by this task. Used for Active Tasks env details. */
    private allModifiedFiles = new Map<string, string>()
    /** Files already registered with the cross-task registry, by lookup key. */
    private registeredFiles = new Set<string>()
    /** Whether files may have changed outside both pending sets, so a full scan is needed. */
    private workspaceScanRequired = false
    /** Whether what the pending scan finds was written by this task, such as by its command. */
    private scanAttributedToTask = false
    /** Bumped on every recorded change; a commit settles only changes it has seen. */
    private changeSeq = 0

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
        this.recordPending(this.modifiedFiles, lookupKey, absolutePath)

        // Avoid duplicate registrations for the same file
        if (this.registeredFiles.has(lookupKey)) {
            return
        }
        this.registeredFiles.add(lookupKey)
        this.registry.registerModification(this.taskId, filePath)
        Logger.debug(`[TaskFileTracker] Task ${this.taskId} tracked modification of '${absolutePath}'`)
    }

    /**
     * Record that a path changed in the workspace, whoever changed it.
     *
     * The path is offered to the next checkpoint but not attributed to this
     * task: another task, the user or a process outside this task may have
     * written it.
     *
     * @param filePath - Absolute path reported by the workspace watcher
     */
    notePendingChange(filePath: string): void {
        const absolutePath = path.resolve(filePath)
        this.recordPending(this.observedFiles, this.toLookupKey(absolutePath), absolutePath)
    }

    /** Paths the watcher saw change since the last checkpoint. */
    getObservedFiles(): string[] {
        return Array.from(this.observedFiles.values(), (entry) => entry.path)
    }

    /** Whether the next checkpoint has anything to commit. */
    hasPendingChanges(): boolean {
        return this.workspaceScanRequired || this.modifiedFiles.size > 0 || this.observedFiles.size > 0
    }

    /** A mark to pass to {@link settlePending} once the changes read now are committed. */
    pendingWatermark(): number {
        return this.changeSeq
    }

    /**
     * Forget pending paths a checkpoint has committed.
     *
     * A path changed again after `watermark` stays pending: the commit read it
     * before that change, so the next checkpoint still owes it.
     *
     * @param filePaths - Absolute paths the commit accounted for
     * @param watermark - The {@link pendingWatermark} read before the commit read the paths
     */
    settlePending(filePaths: readonly string[], watermark: number): void {
        for (const filePath of filePaths) {
            const lookupKey = this.toLookupKey(path.resolve(filePath))
            for (const pending of [this.modifiedFiles, this.observedFiles]) {
                const entry = pending.get(lookupKey)
                if (entry && entry.seq <= watermark) pending.delete(lookupKey)
            }
        }
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
            const lookupKey = this.toLookupKey(path.resolve(filePath))
            const droppedTracked = this.modifiedFiles.delete(lookupKey)
            const droppedObserved = this.observedFiles.delete(lookupKey)
            if (droppedTracked || droppedObserved) {
                dropped += 1
            }
        }
        if (dropped > 0) {
            Logger.debug(`[TaskFileTracker] Dropped ${dropped} unstageable file(s) for task ${this.taskId}`)
        }
        return dropped
    }

    private recordPending(pending: Map<string, PendingPath>, lookupKey: string, absolutePath: string): void {
        this.changeSeq += 1
        // The first spelling seen stays: it is the one already handed to Git.
        pending.set(lookupKey, { path: pending.get(lookupKey)?.path ?? absolutePath, seq: this.changeSeq })
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
        return Array.from(this.modifiedFiles.values(), (entry) => entry.path)
    }

    /**
     * Get all files modified during this task lifetime.
     * @returns Array of normalized absolute file paths.
     */
    getAllModifiedFiles(): string[] {
        return Array.from(this.allModifiedFiles.values())
    }

    /**
     * Mark that files may have changed where neither pending set can name them.
     *
     * A command run by this task attributes what the scan finds to the task, so
     * a selective Restore Files covers its writes. A scan that only stands in
     * for a watcher that could not vouch for the workspace (the task was closed,
     * or the watcher failed) attributes nothing: those writes may be anyone's.
     */
    markWorkspaceScanRequired(options: { readonly attributeToTask?: boolean } = {}): void {
        this.workspaceScanRequired = true
        if (options.attributeToTask ?? true) this.scanAttributedToTask = true
        Logger.debug(`[TaskFileTracker] Workspace scan required for task ${this.taskId}`)
    }

    /** Whether files the pending scan finds belong to this task. */
    isScanAttributedToTask(): boolean {
        return this.workspaceScanRequired && this.scanAttributedToTask
    }

    /**
     * Return whether unknown file writes require a workspace scan before checkpoint.
     *
     * @returns true when files may have changed outside the pending sets.
     */
    isWorkspaceScanRequired(): boolean {
        return this.workspaceScanRequired
    }

    /**
     * Clear the unknown-write scan marker after checkpoint decision completes.
     */
    clearWorkspaceScanRequired(): void {
        this.workspaceScanRequired = false
        this.scanAttributedToTask = false
        Logger.debug(`[TaskFileTracker] Cleared workspace scan marker for task ${this.taskId}`)
    }

    /**
     * Clear every pending path.
     * The global WorkspaceFileRegistry is intentionally left untouched — restore
     * scenarios need the full history of file ownership for per-file restore.
     */
    clearModifiedFiles(): void {
        this.modifiedFiles.clear()
        this.observedFiles.clear()
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
        this.observedFiles.clear()
        this.allModifiedFiles.clear()
        this.registeredFiles.clear()
        this.workspaceScanRequired = false
        this.scanAttributedToTask = false
        Logger.debug(`[TaskFileTracker] Disposed for task ${this.taskId}`)
    }
}

/** One path a checkpoint still owes, with the change that last touched it. */
interface PendingPath {
    readonly path: string
    readonly seq: number
}
