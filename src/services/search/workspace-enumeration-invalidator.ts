import chokidar, { type ChokidarOptions, type FSWatcher } from "chokidar"
import * as path from "path"
import { Logger } from "@/shared/services/Logger"

/**
 * Watches one workspace root and reports when its file *set* changes.
 *
 * The enumeration cache stores the list of paths ripgrep produced, so only
 * creation, deletion and rename can make it stale — editing a file's contents
 * cannot. Watching for exactly those events is what lets the cache TTL be long
 * enough to be useful without a newly created file staying invisible until it
 * expires.
 *
 * The watcher is deliberately independent of `PromptInputFileWatcher`, which
 * only observes rule/workflow/skill inputs and answers a different question.
 */

/** Injected for tests; production uses chokidar. */
export type WatchFactory = (paths: readonly string[], options: ChokidarOptions) => FSWatcher

/**
 * Directories never worth watching.
 *
 * Mirrors the traversal floor: these produce high-volume events (build output,
 * VCS internals) that can never change the user-visible mention candidates in a
 * way worth a re-walk.
 */
const UNWATCHED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "out", "tmp"])

function isUnwatchedDirectory(candidate: string): boolean {
    return candidate.split(/[\\/]/).some((segment) => UNWATCHED_DIRECTORIES.has(segment))
}

interface RootWatch {
    readonly watcher: FSWatcher
}

const watches = new Map<string, RootWatch>()
let watchFactory: WatchFactory = (paths, options) => chokidar.watch([...paths], options)

/** Test seam: swap the watcher implementation. */
export function setWatchFactoryForTesting(factory: WatchFactory | undefined): void {
    watchFactory = factory ?? ((paths, options) => chokidar.watch([...paths], options))
}

/**
 * Ensure a root is watched, invoking `onFileSetChanged` when its contents move.
 *
 * Safe to call on every enumeration: repeat calls for a root already watched
 * are a no-op, so the watcher is created once and outlives individual walks.
 */
export function ensureWorkspaceWatched(workspacePath: string, onFileSetChanged: () => void): void {
    const root = path.resolve(workspacePath)
    if (watches.has(root)) {
        return
    }

    let watcher: FSWatcher
    try {
        watcher = watchFactory([root], {
            persistent: false,
            ignoreInitial: true,
            // A rename lands as unlink+add; coalescing them is the caller's job.
            atomic: true,
            ignored: (candidate: string) => isUnwatchedDirectory(path.relative(root, path.resolve(candidate))),
        })
    } catch (error) {
        // Watching is an optimisation: without it the TTL still bounds staleness,
        // so a failure must not break the picker.
        Logger.warn(`[file-search] failed to watch ${root} for enumeration invalidation: ${error}`)
        return
    }

    const entry: RootWatch = { watcher }
    watches.set(root, entry)

    watcher
        .on("add", onFileSetChanged)
        .on("unlink", onFileSetChanged)
        .on("addDir", onFileSetChanged)
        .on("unlinkDir", onFileSetChanged)
        .on("error", (error) => {
            Logger.warn(`[file-search] enumeration watcher error for ${root}: ${error}`)
        })
}

/** Stop watching a root; used when its cache entry is evicted for good. */
export async function stopWatchingWorkspace(workspacePath: string): Promise<void> {
    const root = path.resolve(workspacePath)
    const entry = watches.get(root)
    if (!entry) {
        return
    }
    watches.delete(root)
    try {
        await entry.watcher.close()
    } catch (error) {
        Logger.warn(`[file-search] failed to close enumeration watcher for ${root}: ${error}`)
    }
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
