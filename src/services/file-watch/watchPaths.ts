import { EventEmitter } from "node:events"
import fs from "node:fs"
import path from "node:path"
import chokidar, { type ChokidarOptions } from "chokidar"
import { HostProvider } from "@/hosts/host-provider"
import type { TreeChangeKind, TreeChangeListener, WorkspaceTreeWatchHost } from "./WorkspaceTreeWatchHost"

export type PathEvent = "add" | "addDir" | "change" | "unlink" | "unlinkDir"

/** The part of chokidar's watcher Dline relies on; a chokidar watcher and a host-served watcher both provide it. */
export interface PathWatcher {
    on(event: PathEvent, listener: (path: string) => void): this
    on(event: "ready", listener: () => void): this
    on(event: "error", listener: (error: unknown) => void): this
    once(event: "ready", listener: () => void): this
    add(paths: string | string[]): this
    unwatch(paths: string | string[]): this
    close(): Promise<void>
}

export type PathWatchFactory = (paths: readonly string[], options: ChokidarOptions) => PathWatcher

export interface WatchPathsDeps {
    /** Defaults to the host registered on {@link HostProvider}; none means every path goes to chokidar. */
    readonly host?: WorkspaceTreeWatchHost
    readonly fallback?: PathWatchFactory
}

const PATH_EVENTS: readonly PathEvent[] = ["add", "addDir", "change", "unlink", "unlinkDir"]
/** chokidar's default `awaitWriteFinish.stabilityThreshold`. */
const DEFAULT_WRITE_SETTLE_MS = 2_000
/** Every path between a watched target and an event is a directory; `ignored` callbacks receive it as one. */
const DIRECTORY_STATS = { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false } as fs.Stats

const chokidarFactory: PathWatchFactory = (paths, options) => chokidar.watch([...paths], options)

/**
 * Watch `paths` with chokidar's event contract.
 *
 * A path inside a folder the host already watches is served from that one
 * recursive host watch, so Dline opens no handle inside the workspace and a
 * directory there stays renamable on Windows. Any other path, and any option
 * set the hosted view cannot honour, keeps a chokidar watcher, which is also
 * what the editor does for files outside its workspace.
 */
export function watchPaths(paths: string | readonly string[], options: ChokidarOptions, deps: WatchPathsDeps = {}): PathWatcher {
    const fallback = deps.fallback ?? chokidarFactory
    const host = deps.host ?? registeredHost()
    const targets = typeof paths === "string" ? [paths] : [...paths]
    if (!host || !servableFromHost(options)) return fallback(targets, options)
    return new HostedPathWatcher(hubFor(host), host, targets, options, fallback)
}

function registeredHost(): WorkspaceTreeWatchHost | undefined {
    return HostProvider.isInitialized() ? HostProvider.get().workspaceTreeWatch : undefined
}

/**
 * The hosted view reports changes only, never the initial scan, and filters with
 * an `ignored` callback; polling, depth limits and matcher lists stay with chokidar.
 */
function servableFromHost(options: ChokidarOptions): boolean {
    return (
        options.ignoreInitial === true &&
        (options.ignored === undefined || typeof options.ignored === "function") &&
        !options.usePolling &&
        options.depth === undefined
    )
}

/** Case-insensitive on Windows, where the file system is. */
function pathKey(absolutePath: string): string {
    return process.platform === "win32" ? absolutePath.toLowerCase() : absolutePath
}

function isWithin(parent: string, candidate: string): boolean {
    const relative = path.relative(parent, candidate)
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/** Spell `candidate` with the root's spelling, so a lower-case drive letter from the host matches the caller's paths. */
export function respellUnderRoot(root: string, candidate: string): string | undefined {
    if (!isWithin(root, candidate)) return undefined
    const relative = path.relative(root, candidate)
    return relative ? path.join(root, relative) : root
}

interface Tree {
    readonly listeners: Set<TreeChangeListener>
    readonly stop: () => void
}

/** One host watch per root, shared by every hosted watcher below it and stopped with its last subscriber. */
class TreeWatchHub {
    private readonly trees = new Map<string, Tree>()

    constructor(private readonly host: WorkspaceTreeWatchHost) {}

    subscribe(root: string, listener: TreeChangeListener): () => void {
        const key = pathKey(root)
        let tree = this.trees.get(key)
        if (!tree) {
            const listeners = new Set<TreeChangeListener>()
            const stop = this.host.watchTree(root, (kind, absolutePath) => {
                const respelled = respellUnderRoot(root, absolutePath)
                if (respelled === undefined) return
                for (const notify of [...listeners]) {
                    try {
                        notify(kind, respelled)
                    } catch {
                        // One watcher's failing consumer must not hide the change from the others.
                    }
                }
            })
            tree = { listeners, stop }
            this.trees.set(key, tree)
        }
        tree.listeners.add(listener)
        const subscribed = tree
        return () => {
            subscribed.listeners.delete(listener)
            if (subscribed.listeners.size > 0 || this.trees.get(key) !== subscribed) return
            this.trees.delete(key)
            subscribed.stop()
        }
    }
}

const hubs = new WeakMap<WorkspaceTreeWatchHost, TreeWatchHub>()

function hubFor(host: WorkspaceTreeWatchHost): TreeWatchHub {
    let hub = hubs.get(host)
    if (!hub) {
        hub = new TreeWatchHub(host)
        hubs.set(host, hub)
    }
    return hub
}

type IgnoredCallback = (candidate: string, stats?: fs.Stats) => boolean

interface PendingWrite {
    readonly event: "add" | "change"
    readonly timer: NodeJS.Timeout
}

/**
 * A chokidar-shaped watcher fed by the host's tree watch.
 *
 * The host reports created, changed and deleted paths without saying whether
 * they are files or directories, so a created or changed path is stat'ed to
 * pick `add`, `addDir` or `change`, and a deletion is reported as both
 * `unlink` and `unlinkDir`. Paths outside every host root go to a chokidar
 * watcher created on demand, whose events are forwarded unchanged.
 */
class HostedPathWatcher extends EventEmitter implements PathWatcher {
    private readonly targets = new Map<string, string>()
    private readonly subscriptions = new Map<string, { count: number; readonly unsubscribe: () => void }>()
    private readonly pendingWrites = new Map<string, PendingWrite>()
    private readonly ignored: IgnoredCallback | undefined
    private readonly writeSettleMs: number
    private fallbackWatcher: PathWatcher | undefined
    private closed = false
    private readyEmitted = false

    constructor(
        private readonly hub: TreeWatchHub,
        private readonly host: WorkspaceTreeWatchHost,
        paths: readonly string[],
        private readonly options: ChokidarOptions,
        private readonly fallback: PathWatchFactory,
    ) {
        super()
        this.ignored = typeof options.ignored === "function" ? (options.ignored as IgnoredCallback) : undefined
        this.writeSettleMs = settleTime(options.awaitWriteFinish)
        this.add([...paths])
        // chokidar announces readiness after its scan; the host watch has no scan, so only the fallback can delay it.
        if (this.fallbackWatcher) this.fallbackWatcher.once("ready", () => this.emitReady())
        else setImmediate(() => this.emitReady())
    }

    add(paths: string | string[]): this {
        if (this.closed) return this
        const roots = this.host.roots()
        const outside: string[] = []
        for (const candidate of typeof paths === "string" ? [paths] : paths) {
            const target = path.resolve(candidate)
            const root = roots.find((folder) => isWithin(folder, target))
            if (!root) {
                outside.push(target)
                continue
            }
            const key = pathKey(target)
            if (this.targets.has(key)) continue
            this.targets.set(key, target)
            this.retainRoot(root)
        }
        if (outside.length > 0) this.watchOutside(outside)
        return this
    }

    unwatch(paths: string | string[]): this {
        const roots = this.host.roots()
        const outside: string[] = []
        for (const candidate of typeof paths === "string" ? [paths] : paths) {
            const target = path.resolve(candidate)
            if (!this.targets.delete(pathKey(target))) {
                outside.push(target)
                continue
            }
            const root = roots.find((folder) => isWithin(folder, target))
            if (root) this.releaseRoot(root)
        }
        if (outside.length > 0) this.fallbackWatcher?.unwatch(outside)
        return this
    }

    async close(): Promise<void> {
        if (this.closed) return
        this.closed = true
        for (const subscription of this.subscriptions.values()) subscription.unsubscribe()
        this.subscriptions.clear()
        this.targets.clear()
        for (const pending of this.pendingWrites.values()) clearTimeout(pending.timer)
        this.pendingWrites.clear()
        await this.fallbackWatcher?.close()
    }

    private retainRoot(root: string): void {
        const key = pathKey(root)
        const subscription = this.subscriptions.get(key)
        if (subscription) subscription.count++
        else this.subscriptions.set(key, { count: 1, unsubscribe: this.hub.subscribe(root, this.onTreeChange) })
    }

    private releaseRoot(root: string): void {
        const key = pathKey(root)
        const subscription = this.subscriptions.get(key)
        if (!subscription || --subscription.count > 0) return
        this.subscriptions.delete(key)
        subscription.unsubscribe()
    }

    private watchOutside(paths: string[]): void {
        if (this.fallbackWatcher) {
            this.fallbackWatcher.add(paths)
            return
        }
        const watcher = this.fallback(paths, this.options)
        for (const event of PATH_EVENTS) watcher.on(event, (changed) => this.emit(event, changed))
        watcher.on("error", (error) => this.emit("error", error))
        this.fallbackWatcher = watcher
    }

    private emitReady(): void {
        if (this.readyEmitted || this.closed) return
        this.readyEmitted = true
        this.emit("ready")
    }

    private readonly onTreeChange = (kind: TreeChangeKind, changed: string): void => {
        if (this.closed || !this.isWatched(changed)) return
        if (kind === "deleted") {
            this.cancelPendingWrite(changed)
            if (this.ignored?.(changed)) return
            this.emit("unlink", changed)
            this.emit("unlinkDir", changed)
            return
        }
        void this.reportPresent(kind, changed)
    }

    /** Covered by a target, and not inside a directory the `ignored` callback prunes on the way down from it. */
    private isWatched(changed: string): boolean {
        for (const target of this.targets.values()) {
            if (isWithin(target, changed) && !this.prunedBetween(target, changed)) return true
        }
        return false
    }

    private prunedBetween(target: string, changed: string): boolean {
        if (!this.ignored) return false
        const relative = path.relative(target, changed)
        if (!relative) return false
        const segments = relative.split(path.sep)
        let directory = target
        for (const segment of segments.slice(0, -1)) {
            if (this.ignored(directory, DIRECTORY_STATS)) return true
            directory = path.join(directory, segment)
        }
        return this.ignored(directory, DIRECTORY_STATS)
    }

    private async reportPresent(kind: Exclude<TreeChangeKind, "deleted">, changed: string): Promise<void> {
        const stats = await fs.promises.stat(changed).catch(() => undefined)
        // Gone again before it could be inspected: the deletion that follows reports it.
        if (!stats || this.closed || this.ignored?.(changed, stats)) return
        if (stats.isDirectory()) {
            if (kind === "created") this.emit("addDir", changed)
            return
        }
        const event = kind === "created" ? "add" : "change"
        if (this.writeSettleMs > 0) this.settleWrite(changed, event)
        else this.emit(event, changed)
    }

    /** chokidar's `awaitWriteFinish`: report a file once its writes have been quiet for the threshold. */
    private settleWrite(changed: string, event: "add" | "change"): void {
        const key = pathKey(changed)
        const pending = this.pendingWrites.get(key)
        if (pending) clearTimeout(pending.timer)
        // A file created and then written reads as one `add`, as it would after chokidar's wait.
        const settled = pending?.event === "add" ? "add" : event
        const timer = setTimeout(() => {
            this.pendingWrites.delete(key)
            if (!this.closed) this.emit(settled, changed)
        }, this.writeSettleMs)
        timer.unref?.()
        this.pendingWrites.set(key, { event: settled, timer })
    }

    private cancelPendingWrite(changed: string): void {
        const key = pathKey(changed)
        const pending = this.pendingWrites.get(key)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pendingWrites.delete(key)
    }
}

function settleTime(awaitWriteFinish: ChokidarOptions["awaitWriteFinish"]): number {
    if (!awaitWriteFinish) return 0
    if (awaitWriteFinish === true) return DEFAULT_WRITE_SETTLE_MS
    return awaitWriteFinish.stabilityThreshold ?? DEFAULT_WRITE_SETTLE_MS
}
