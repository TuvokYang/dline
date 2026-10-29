import { subscribeWorkspaceChanges, type WorkspaceChangeListener } from "@services/search/workspace-enumeration-invalidator"
import { Logger } from "@shared/services/Logger"
import type { TaskFileTracker } from "./TaskFileTracker"

type Subscribe = (root: string, listener: WorkspaceChangeListener) => (() => void) | undefined

/** A scan that stands in for the watcher finds changes that may be anyone's, not this task's. */
const UNATTRIBUTED = { attributeToTask: false } as const

/**
 * Tells a task's checkpoints when the workspace changed, whoever changed it.
 *
 * The workspace root watchers are the only source of change: a checkpoint does
 * not depend on which tool, command, subagent or person wrote a file. Where the
 * watchers cannot vouch for completeness, a full scan stands in:
 * - when the task opens, because nothing watched the files while it was closed;
 * - after a watcher reports an error, because events may have been lost;
 * - on a root that cannot be watched at all.
 *
 * Directory events are not recorded: the files inside a created or removed
 * directory arrive as their own events, and staging a directory by name would
 * take in everything below it, ignored files included.
 */
export class WorkspaceChangeFeed {
    private readonly unsubscribers: Array<() => void> = []
    private unwatchedRoots = 0
    /** Set by `dispose`; a late `start` from a root lookup still in flight must not subscribe. */
    private disposed = false

    /** The first checkpoint after construction scans the workspace once, even before watching starts. */
    constructor(
        private readonly files: TaskFileTracker,
        private readonly subscribe: Subscribe = subscribeWorkspaceChanges,
    ) {
        this.files.markWorkspaceScanRequired(UNATTRIBUTED)
    }

    /** Start watching `roots`. */
    start(roots: readonly string[]): void {
        if (this.disposed) return
        for (const root of roots) {
            const unsubscribe = this.subscribe(root, {
                onChange: (kind, absolutePath) => {
                    if (kind === "add" || kind === "change" || kind === "unlink") this.files.notePendingChange(absolutePath)
                },
                onError: () => this.files.markWorkspaceScanRequired(UNATTRIBUTED),
            })
            if (unsubscribe) {
                this.unsubscribers.push(unsubscribe)
            } else {
                this.unwatchedRoots += 1
                Logger.warn(`[WorkspaceChangeFeed] ${root} cannot be watched; every checkpoint will scan it`)
            }
        }
    }

    /** Whether the workspace may have changed since the last checkpoint commit. */
    hasChanges(): boolean {
        if (this.unwatchedRoots > 0) this.files.markWorkspaceScanRequired(UNATTRIBUTED)
        return this.files.hasPendingChanges()
    }

    dispose(): void {
        this.disposed = true
        for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
    }
}
