import * as path from "path"
import { describe, expect, it } from "vitest"
import { TaskFileTracker } from "../TaskFileTracker"

describe("TaskFileTracker", () => {
    it("keeps lifetime edited files after checkpoint increment is cleared", () => {
        const tracker = new TaskFileTracker("task-1")
        const filePath = path.resolve("src/example.ts")

        tracker.trackModification(filePath)
        tracker.clearModifiedFiles()

        expect(tracker.getModifiedFiles()).toEqual([])
        expect(tracker.getAllModifiedFiles()).toEqual([filePath])
    })

    it("clears lifetime edited files on dispose", () => {
        const tracker = new TaskFileTracker("task-1")
        const filePath = path.resolve("src/example.ts")

        tracker.trackModification(filePath)
        tracker.dispose()

        expect(tracker.getModifiedFiles()).toEqual([])
        expect(tracker.getAllModifiedFiles()).toEqual([])
    })

    it("keeps the on-disk spelling so the path stays usable as a Git pathspec", () => {
        const tracker = new TaskFileTracker("task-1")
        const filePath = path.resolve("src/CMakeLists.txt")

        tracker.trackModification(filePath)

        expect(tracker.getModifiedFiles()).toEqual([filePath])
    })

    it("de-duplicates paths that differ only by case", () => {
        const tracker = new TaskFileTracker("task-1")
        const filePath = path.resolve("src/README.md")

        tracker.trackModification(filePath)
        tracker.trackModification(filePath.toLowerCase())

        expect(tracker.getModifiedFiles()).toEqual([filePath])
    })

    it("drops paths the checkpoint layer proved unstageable so they are not replayed", () => {
        const tracker = new TaskFileTracker("task-1")
        const stageable = path.resolve("src/keep.ts")
        const rejected = path.resolve(".worktree/feature/src/owned.ts")

        tracker.trackModification(stageable)
        tracker.trackModification(rejected)

        expect(tracker.dropModifiedFiles([rejected])).toBe(1)
        expect(tracker.getModifiedFiles()).toEqual([stageable])
    })

    it("queues a watched change for the next checkpoint without attributing it to the task", () => {
        const tracker = new TaskFileTracker("task-watch")
        const filePath = path.resolve("src/changed-elsewhere.ts")

        tracker.notePendingChange(filePath)

        expect(tracker.hasPendingChanges()).toBe(true)
        expect(tracker.getObservedFiles()).toEqual([filePath])
        // Never force-staged and never reported as this task's edit.
        expect(tracker.getModifiedFiles()).toEqual([])
        expect(tracker.getAllModifiedFiles()).toEqual([])
    })

    it("still attributes a file the task edits after the watcher reported it", () => {
        const tracker = new TaskFileTracker("task-watch-then-edit")
        const filePath = path.resolve("src/edited.ts")

        tracker.notePendingChange(filePath)
        tracker.trackModification(filePath)

        expect(tracker.getAllModifiedFiles()).toEqual([filePath])
        expect(tracker.getModifiedFiles()).toEqual([filePath])
    })

    it("has nothing pending once the checkpoint committed it", () => {
        const tracker = new TaskFileTracker("task-clean")
        tracker.notePendingChange(path.resolve("src/a.ts"))

        tracker.clearModifiedFiles()

        expect(tracker.hasPendingChanges()).toBe(false)
        tracker.markWorkspaceScanRequired()
        expect(tracker.hasPendingChanges()).toBe(true)
    })

    it("keeps a path that changed again while a checkpoint was committing it", () => {
        const tracker = new TaskFileTracker("task-concurrent")
        const settled = path.resolve("src/settled.ts")
        const rewritten = path.resolve("src/rewritten.ts")
        tracker.trackModification(settled)
        tracker.notePendingChange(rewritten)
        const watermark = tracker.pendingWatermark()

        // A background writer touches one of the paths after the commit read them.
        tracker.notePendingChange(rewritten)
        tracker.settlePending([settled, rewritten], watermark)

        expect(tracker.getModifiedFiles()).toEqual([])
        expect(tracker.getObservedFiles()).toEqual([rewritten])
        expect(tracker.hasPendingChanges()).toBe(true)
    })

    it("reports zero when dropping paths that are not tracked", () => {
        const tracker = new TaskFileTracker("task-1")
        tracker.trackModification(path.resolve("src/keep.ts"))

        expect(tracker.dropModifiedFiles([path.resolve("src/absent.ts")])).toBe(0)
        expect(tracker.getModifiedFiles()).toEqual([path.resolve("src/keep.ts")])
    })
})
