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

    it("reports zero when dropping paths that are not tracked", () => {
        const tracker = new TaskFileTracker("task-1")
        tracker.trackModification(path.resolve("src/keep.ts"))

        expect(tracker.dropModifiedFiles([path.resolve("src/absent.ts")])).toBe(0)
        expect(tracker.getModifiedFiles()).toEqual([path.resolve("src/keep.ts")])
    })
})
