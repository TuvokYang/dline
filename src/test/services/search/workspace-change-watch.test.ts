import type { FSWatcher } from "chokidar"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { getDefaultExclusions } from "@/integrations/checkpoints/CheckpointExclusions"
import {
    ensureWorkspaceWatched,
    resetWorkspaceWatchersForTesting,
    setWatchFactoryForTesting,
    stopWatchingWorkspace,
    subscribeWorkspaceChanges,
    UNWATCHED_WORKSPACE_DIRECTORIES,
    type WatchFactory,
    watchedWorkspaceRoots,
} from "@/services/search/workspace-enumeration-invalidator"

const root = path.resolve("/workspace")

/** A chokidar stand-in that records its options and lets a case fire events. */
function fakeWatch() {
    const listeners = new Map<string, Array<(value: unknown) => void>>()
    const created: Array<{ paths: readonly string[]; ignored: (candidate: string) => boolean }> = []
    let closed = 0
    const watcher = {
        on(event: string, handler: (value: unknown) => void) {
            listeners.set(event, [...(listeners.get(event) ?? []), handler])
            return watcher
        },
        close: async () => {
            closed += 1
        },
    } as unknown as FSWatcher
    const factory: WatchFactory = (paths, options) => {
        created.push({ paths, ignored: options.ignored as (candidate: string) => boolean })
        return watcher
    }
    return {
        factory,
        created,
        closed: () => closed,
        emit: (event: string, value: unknown) => {
            for (const handler of listeners.get(event) ?? []) handler(value)
        },
    }
}

describe("workspace change watch", () => {
    afterEach(() => {
        resetWorkspaceWatchersForTesting()
        setWatchFactoryForTesting(undefined)
    })

    it("shares one watcher between the enumeration cache and change subscribers", () => {
        const watch = fakeWatch()
        setWatchFactoryForTesting(watch.factory)
        const onFileSetChanged = vi.fn()
        const onChange = vi.fn()

        ensureWorkspaceWatched(root, onFileSetChanged)
        subscribeWorkspaceChanges(root, { onChange })

        expect(watch.created).toHaveLength(1)
        watch.emit("add", path.join(root, "src", "a.ts"))
        expect(onFileSetChanged).toHaveBeenCalledOnce()
        expect(onChange).toHaveBeenCalledWith("add", path.join(root, "src", "a.ts"))
    })

    it("reports content changes to change subscribers but not to the enumeration cache", () => {
        const watch = fakeWatch()
        setWatchFactoryForTesting(watch.factory)
        const onFileSetChanged = vi.fn()
        const onChange = vi.fn()
        ensureWorkspaceWatched(root, onFileSetChanged)
        subscribeWorkspaceChanges(root, { onChange })

        watch.emit("change", path.join(root, "src", "a.ts"))

        expect(onChange).toHaveBeenCalledWith("change", path.join(root, "src", "a.ts"))
        expect(onFileSetChanged).not.toHaveBeenCalled()
    })

    it("keeps tmp out of the enumeration cache while still reporting it to change subscribers", () => {
        const watch = fakeWatch()
        setWatchFactoryForTesting(watch.factory)
        const onFileSetChanged = vi.fn()
        const onChange = vi.fn()
        ensureWorkspaceWatched(root, onFileSetChanged)
        subscribeWorkspaceChanges(root, { onChange })

        watch.emit("add", path.join(root, "tmp", "scratch.txt"))

        expect(watch.created[0].ignored(path.join(root, "tmp", "scratch.txt"))).toBe(false)
        expect(onChange).toHaveBeenCalledOnce()
        expect(onFileSetChanged).not.toHaveBeenCalled()
    })

    it("keeps watching for change subscribers after the enumeration cache lets the root go", async () => {
        const watch = fakeWatch()
        setWatchFactoryForTesting(watch.factory)
        const onChange = vi.fn()
        ensureWorkspaceWatched(root, vi.fn())
        const unsubscribe = subscribeWorkspaceChanges(root, { onChange })

        await stopWatchingWorkspace(root)
        watch.emit("unlink", path.join(root, "a.ts"))

        expect(watch.closed()).toBe(0)
        expect(onChange).toHaveBeenCalledWith("unlink", path.join(root, "a.ts"))
        unsubscribe?.()
        await vi.waitFor(() => expect(watch.closed()).toBe(1))
        expect(watchedWorkspaceRoots()).toEqual([])
    })

    it("tells subscribers when the watcher fails so they can stop trusting it", () => {
        const watch = fakeWatch()
        setWatchFactoryForTesting(watch.factory)
        const onError = vi.fn()
        subscribeWorkspaceChanges(root, { onChange: vi.fn(), onError })

        watch.emit("error", new Error("EMFILE"))

        expect(onError).toHaveBeenCalledOnce()
    })

    it("returns no subscription when the root cannot be watched", () => {
        setWatchFactoryForTesting(() => {
            throw new Error("EMFILE: too many open files")
        })

        expect(subscribeWorkspaceChanges(root, { onChange: vi.fn() })).toBeUndefined()
    })

    it("only ignores directories the checkpoint shadow repository also excludes", () => {
        const excluded = new Set(getDefaultExclusions().map((pattern) => pattern.replace(/\/$/, "")))

        for (const directory of UNWATCHED_WORKSPACE_DIRECTORIES) {
            expect(excluded, directory).toContain(directory)
        }
    })
})
