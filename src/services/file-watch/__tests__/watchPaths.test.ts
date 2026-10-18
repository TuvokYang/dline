import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TreeChangeKind, TreeChangeListener, WorkspaceTreeWatchHost } from "../WorkspaceTreeWatchHost"
import { type PathWatcher, type PathWatchFactory, watchPaths } from "../watchPaths"

/** Stands in for the editor: records which trees are watched and replays changes to them. */
class FakeTreeHost implements WorkspaceTreeWatchHost {
    readonly watched: string[] = []
    stopped = 0
    private readonly listeners = new Map<string, TreeChangeListener>()

    constructor(private readonly folders: readonly string[]) {}

    roots(): readonly string[] {
        return this.folders
    }

    watchTree(root: string, listener: TreeChangeListener): () => void {
        this.watched.push(root)
        this.listeners.set(root, listener)
        return () => {
            this.stopped++
            this.listeners.delete(root)
        }
    }

    fire(kind: TreeChangeKind, absolutePath: string): void {
        for (const listener of [...this.listeners.values()]) listener(kind, absolutePath)
    }
}

/** A chokidar stand-in for paths outside every folder. */
class FakeChokidar extends EventEmitter {
    constructor() {
        super()
        setImmediate(() => this.emit("ready"))
    }
    add(): this {
        return this
    }
    unwatch(): this {
        return this
    }
    async close(): Promise<void> {}
}

type Recorded = [event: string, changed: string]

function record(watcher: PathWatcher): Recorded[] {
    const events: Recorded[] = []
    for (const event of ["add", "addDir", "change", "unlink", "unlinkDir"] as const) {
        watcher.on(event, (changed) => events.push([event, changed]))
    }
    return events
}

describe("watchPaths", () => {
    let root: string
    let outsideRoot: string
    let host: FakeTreeHost
    let fallbackCalls: string[][]
    let fallbackWatchers: FakeChokidar[]
    let fallback: PathWatchFactory

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-watch-root-"))
        outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dline-watch-outside-"))
        host = new FakeTreeHost([root])
        fallbackCalls = []
        fallbackWatchers = []
        fallback = (paths) => {
            fallbackCalls.push([...paths])
            const watcher = new FakeChokidar()
            fallbackWatchers.push(watcher)
            return watcher as unknown as PathWatcher
        }
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
        await fs.rm(outsideRoot, { recursive: true, force: true })
    })

    async function file(relative: string, content = "x"): Promise<string> {
        const absolute = path.join(root, relative)
        await fs.mkdir(path.dirname(absolute), { recursive: true })
        await fs.writeFile(absolute, content)
        return absolute
    }

    it("serves a file inside a workspace folder from the host watch instead of opening its own", async () => {
        const notes = await file(path.join(".memory-bank", "notes.md"))
        const watcher = watchPaths(notes, { ignoreInitial: true }, { host, fallback })
        const events = record(watcher)
        const ready = new Promise<void>((resolve) => watcher.once("ready", resolve))

        await ready
        host.fire("changed", notes)
        host.fire("changed", path.join(root, ".memory-bank", "other.md"))

        await vi.waitFor(() => expect(events).toEqual([["change", notes]]))
        expect(host.watched).toEqual([root])
        expect(fallbackCalls).toEqual([])
        await watcher.close()
    })

    it("shares one host watch per folder and stops it with the last watcher", async () => {
        const first = watchPaths(await file("a.md"), { ignoreInitial: true }, { host, fallback })
        const second = watchPaths(await file("b.md"), { ignoreInitial: true }, { host, fallback })

        await first.close()
        const stoppedWhileSecondOpen = host.stopped
        await second.close()

        expect(host.watched).toEqual([root])
        expect(stoppedWhileSecondOpen).toBe(0)
        expect(host.stopped).toBe(1)
    })

    it("drops changes below a directory the ignored callback prunes", async () => {
        const skipped = await file(path.join("skip", "a.txt"))
        const kept = await file(path.join("keep", "b.txt"))
        const watcher = watchPaths(
            root,
            {
                ignoreInitial: true,
                ignored: (candidate, stats) => stats?.isDirectory() === true && path.basename(candidate) === "skip",
            },
            { host, fallback },
        )
        const events = record(watcher)

        host.fire("changed", skipped)
        host.fire("changed", kept)

        await vi.waitFor(() => expect(events).toEqual([["change", kept]]))
        await watcher.close()
    })

    it("tells a created directory from a created file and reports a deletion of either kind", async () => {
        const directory = path.join(root, "made")
        await fs.mkdir(directory)
        const created = await file("new.txt")
        const gone = path.join(root, "gone")
        const watcher = watchPaths(root, { ignoreInitial: true }, { host, fallback })
        const events = record(watcher)

        host.fire("created", directory)
        host.fire("created", created)
        await vi.waitFor(() => expect(events).toHaveLength(2))
        host.fire("deleted", gone)

        expect(new Set(events.slice(0, 2).map((entry) => entry.join(" ")))).toEqual(
            new Set([`addDir ${directory}`, `add ${created}`]),
        )
        expect(events.slice(2)).toEqual([
            ["unlink", gone],
            ["unlinkDir", gone],
        ])
        await watcher.close()
    })

    it("keeps chokidar for paths outside every workspace folder and forwards its events", async () => {
        const inside = await file("inside.md")
        const outside = path.join(outsideRoot, "rules.md")
        const watcher = watchPaths([inside, outside], { ignoreInitial: true }, { host, fallback })
        const events = record(watcher)

        fallbackWatchers[0]?.emit("change", outside)

        expect(fallbackCalls).toEqual([[outside]])
        expect(host.watched).toEqual([root])
        expect(events).toEqual([["change", outside]])
        await watcher.close()
    })

    it("leaves a watch that needs an initial scan entirely to chokidar", () => {
        const target = path.join(root, "scan-me")

        watchPaths(target, { ignoreInitial: false }, { host, fallback })

        expect(fallbackCalls).toEqual([[target]])
        expect(host.watched).toEqual([])
    })

    it("settles a burst of writes into one event when awaitWriteFinish is set", async () => {
        const settled = await file("settled.md")
        const watcher = watchPaths(
            settled,
            { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 40, pollInterval: 10 } },
            { host, fallback },
        )
        const events = record(watcher)

        host.fire("created", settled)
        host.fire("changed", settled)
        host.fire("changed", settled)
        await new Promise((resolve) => setTimeout(resolve, 150))

        expect(events).toEqual([["add", settled]])
        await watcher.close()
    })

    it.runIf(process.platform === "win32")(
        "reports a path the host spells with another drive-letter case in the caller's spelling",
        async () => {
            const notes = await file("notes.md")
            const watcher = watchPaths(notes, { ignoreInitial: true }, { host, fallback })
            const events = record(watcher)
            const respelledDrive = notes[0] === notes[0].toLowerCase() ? notes[0].toUpperCase() : notes[0].toLowerCase()

            host.fire("changed", respelledDrive + notes.slice(1))

            await vi.waitFor(() => expect(events).toEqual([["change", notes]]))
            await watcher.close()
        },
    )
})
