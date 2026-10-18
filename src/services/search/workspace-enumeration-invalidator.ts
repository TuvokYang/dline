import type { ChokidarOptions } from "chokidar"
import * as path from "path"
import { type PathWatcher, watchPaths } from "@/services/file-watch/watchPaths"
import { Logger } from "@/shared/services/Logger"

/**
 * One watcher per workspace root, shared by everything that needs to know when
 * the root's files change.
 *
 * Two consumers subscribe today:
 * - the enumeration cache, which stores the list of paths ripgrep produced, so
 *   only creation, deletion and rename make it stale;
 * - checkpoints, which need every change to know whether the workspace moved
 *   since the last restore point.
 *
 * The watcher is deliberately independent of `PromptInputFileWatcher`, which
 * only observes rule/workflow/skill inputs and answers a different question.
 */

/** Injected for tests; production serves a workspace folder from the editor's own watch. */
export type WatchFactory = (paths: readonly string[], options: ChokidarOptions) => PathWatcher

export type WorkspaceChangeKind = "add" | "change" | "unlink" | "addDir" | "unlinkDir"

export interface WorkspaceChangeListener {
    /** A path under the root was created, modified or removed. */
    onChange(kind: WorkspaceChangeKind, absolutePath: string): void
    /** The watcher reported an error; changes may have been missed since. */
    onError?(error: unknown): void
}

/**
 * Directories no subscriber needs events from.
 *
 * Each one is high-volume (build output, VCS internals, dependencies) and is
 * also excluded from the checkpoint shadow repository, so a change inside it
 * can neither alter a mention candidate worth a re-walk nor a restore point.
 * A directory only one subscriber ignores belongs in that subscriber's filter,
 * not here: ignoring it here would hide its changes from every subscriber.
 */
export const UNWATCHED_WORKSPACE_DIRECTORIES: ReadonlySet<string> = new Set([".git", "node_modules", "dist", "build", "out"])

/** Directories the enumeration cache never lists, beyond the shared floor. */
const ENUMERATION_ONLY_UNWATCHED_DIRECTORIES = new Set(["tmp"])

function hasSegmentIn(relativePath: string, directories: ReadonlySet<string>): boolean {
    return relativePath.split(/[\\/]/).some((segment) => directories.has(segment))
}

interface RootWatch {
    readonly watcher: PathWatcher
    readonly listeners: Set<WorkspaceChangeListener>
    /** The enumeration cache's own subscription, kept apart so eviction removes only it. */
    enumeration?: WorkspaceChangeListener
}

const watches = new Map<string, RootWatch>()
let watchFactory: WatchFactory = watchPaths

/** Test seam: swap the watcher implementation. */
export function setWatchFactoryForTesting(factory: WatchFactory | undefined): void {
    watchFactory = factory ?? watchPaths
}

/** Start the root's watcher, or return the one already running. Undefined when it cannot start. */
function openRootWatch(root: string): RootWatch | undefined {
    const existing = watches.get(root)
    if (existing) return existing

    let watcher: PathWatcher
    try {
        watcher = watchFactory([root], {
            persistent: false,
            ignoreInitial: true,
            // A rename lands as unlink+add; coalescing them is the subscriber's job.
            atomic: true,
            ignored: (candidate: string) =>
                hasSegmentIn(path.relative(root, path.resolve(candidate)), UNWATCHED_WORKSPACE_DIRECTORIES),
        })
    } catch (error) {
        Logger.warn(`[workspace-watch] failed to watch ${root}: ${error}`)
        return undefined
    }

    const entry: RootWatch = { watcher, listeners: new Set() }
    watches.set(root, entry)
    const dispatch = (kind: WorkspaceChangeKind) => (candidate: string) => {
        const absolutePath = path.resolve(root, candidate)
        for (const listener of [...entry.listeners]) {
            try {
                listener.onChange(kind, absolutePath)
            } catch (error) {
                Logger.warn(`[workspace-watch] listener failed for ${root}: ${error}`)
            }
        }
    }
    watcher
        .on("add", dispatch("add"))
        .on("change", dispatch("change"))
        .on("unlink", dispatch("unlink"))
        .on("addDir", dispatch("addDir"))
        .on("unlinkDir", dispatch("unlinkDir"))
        .on("error", (error) => {
            Logger.warn(`[workspace-watch] watcher error for ${root}: ${error}`)
            for (const listener of [...entry.listeners]) {
                try {
                    listener.onError?.(error)
                } catch {
                    // A listener's own failure must not stop the others from learning of the error.
                }
            }
        })
    return entry
}

/** Close a root's watcher once nothing listens to it any more. */
async function closeIfUnused(root: string, entry: RootWatch): Promise<void> {
    if (entry.listeners.size > 0 || watches.get(root) !== entry) return
    watches.delete(root)
    try {
        await entry.watcher.close()
    } catch (error) {
        Logger.warn(`[workspace-watch] failed to close the watcher for ${root}: ${error}`)
    }
}

/**
 * Receive every change under a root until the returned function is called.
 *
 * Returns undefined when the root cannot be watched; the subscriber must then
 * assume any path may have changed.
 */
export function subscribeWorkspaceChanges(workspacePath: string, listener: WorkspaceChangeListener): (() => void) | undefined {
    const root = path.resolve(workspacePath)
    const entry = openRootWatch(root)
    if (!entry) return undefined
    entry.listeners.add(listener)
    let subscribed = true
    return () => {
        if (!subscribed) return
        subscribed = false
        entry.listeners.delete(listener)
        void closeIfUnused(root, entry)
    }
}

/**
 * Ensure a root is watched for the enumeration cache, invoking `onFileSetChanged`
 * when its file set moves.
 *
 * Safe to call on every enumeration: repeat calls for a root already subscribed
 * are a no-op, so the subscription is made once and outlives individual walks.
 * A watcher that cannot start is not an error: the cache TTL still bounds staleness.
 */
export function ensureWorkspaceWatched(workspacePath: string, onFileSetChanged: () => void): void {
    const root = path.resolve(workspacePath)
    const entry = openRootWatch(root)
    if (!entry || entry.enumeration) return
    const listener: WorkspaceChangeListener = {
        onChange: (kind, absolutePath) => {
            // Editing a file's contents cannot change a list of file names.
            if (kind === "change") return
            if (hasSegmentIn(path.relative(root, absolutePath), ENUMERATION_ONLY_UNWATCHED_DIRECTORIES)) return
            onFileSetChanged()
        },
    }
    entry.enumeration = listener
    entry.listeners.add(listener)
}

/** Drop the enumeration cache's subscription; the watcher closes once no subscriber remains. */
export async function stopWatchingWorkspace(workspacePath: string): Promise<void> {
    const root = path.resolve(workspacePath)
    const entry = watches.get(root)
    if (!entry?.enumeration) {
        return
    }
    entry.listeners.delete(entry.enumeration)
    entry.enumeration = undefined
    await closeIfUnused(root, entry)
}

/** Test seam: drop every watcher without waiting for close to settle. */
export function resetWorkspaceWatchersForTesting(): void {
    for (const [, entry] of watches) {
        void entry.watcher.close?.()
    }
    watches.clear()
}

/** Roots currently watched. Exposed for tests. */
export function watchedWorkspaceRoots(): string[] {
    return [...watches.keys()]
}
