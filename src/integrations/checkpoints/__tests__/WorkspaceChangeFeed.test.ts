import * as path from "path"
import { describe, expect, it, vi } from "vitest"
import type { WorkspaceChangeListener } from "@/services/search/workspace-enumeration-invalidator"
import { TaskFileTracker } from "../TaskFileTracker"
import { WorkspaceChangeFeed } from "../WorkspaceChangeFeed"

function subject(options: { watchable?: boolean } = {}) {
    const files = new TaskFileTracker("task-feed")
    const listeners: WorkspaceChangeListener[] = []
    const unsubscribe = vi.fn()
    const feed = new WorkspaceChangeFeed(files, (_root, listener) => {
        if (options.watchable === false) return undefined
        listeners.push(listener)
        return unsubscribe
    })
    return { files, feed, listeners, unsubscribe }
}

describe("WorkspaceChangeFeed", () => {
    it("scans once when the task opens, since nothing watched the files while it was closed", () => {
        const { files, feed } = subject()

        feed.start([path.resolve("/workspace")])

        expect(feed.hasChanges()).toBe(true)
        expect(files.isWorkspaceScanRequired()).toBe(true)
    })

    // The manager resolves its roots asynchronously, so a dispose can land before the
    // lookup returns; the late start must not leave a listener behind for a closed task.
    it("does not subscribe when started after it was disposed", () => {
        const { feed, listeners, unsubscribe } = subject()

        feed.dispose()
        feed.start([path.resolve("/workspace")])
        feed.dispose()

        expect(listeners).toHaveLength(0)
        expect(unsubscribe).not.toHaveBeenCalled()
    })

    it("offers every changed file to the next checkpoint, whatever wrote it", () => {
        const { files, feed, listeners } = subject()
        feed.start([path.resolve("/workspace")])
        files.clearWorkspaceScanRequired()
        expect(feed.hasChanges()).toBe(false)

        const created = path.resolve("/workspace/out-of-band.txt")
        const removed = path.resolve("/workspace/old.txt")
        listeners[0].onChange("add", created)
        listeners[0].onChange("unlink", removed)

        expect(feed.hasChanges()).toBe(true)
        expect(files.getObservedFiles()).toEqual([created, removed])
        expect(files.getAllModifiedFiles()).toEqual([])
    })

    it("leaves directory events to the file events inside them", () => {
        const { files, feed, listeners } = subject()
        feed.start([path.resolve("/workspace")])
        files.clearWorkspaceScanRequired()

        listeners[0].onChange("addDir", path.resolve("/workspace/generated"))

        expect(feed.hasChanges()).toBe(false)
    })

    it("falls back to a scan after the watcher reports an error", () => {
        const { files, feed, listeners } = subject()
        feed.start([path.resolve("/workspace")])
        files.clearWorkspaceScanRequired()

        listeners[0].onError?.(new Error("EMFILE"))

        expect(files.isWorkspaceScanRequired()).toBe(true)
    })

    it("scans for every checkpoint when a root cannot be watched", () => {
        const { files, feed } = subject({ watchable: false })
        feed.start([path.resolve("/workspace")])
        files.clearWorkspaceScanRequired()

        expect(feed.hasChanges()).toBe(true)
        expect(files.isWorkspaceScanRequired()).toBe(true)
    })

    it("stops listening when disposed", () => {
        const { feed, unsubscribe } = subject()
        feed.start([path.resolve("/a"), path.resolve("/b")])

        feed.dispose()

        expect(unsubscribe).toHaveBeenCalledTimes(2)
    })
})
