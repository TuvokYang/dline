import path from "node:path"
import { describe, expect, it } from "vitest"
import { getTaskArtifactDirectory, isTaskReadScopePath, resolveTaskArtifactPath } from "../runtime"
import { ArtifactStoreError } from "../TaskArtifactStore"

describe("task artifact runtime paths", () => {
    it("resolves artifact paths inside the current task artifact root", () => {
        const taskId = "task-paths"
        const relativePath = "images/generated.png"

        expect(resolveTaskArtifactPath(taskId, relativePath)).toBe(
            path.join(getTaskArtifactDirectory(taskId), "artifacts", "images", "generated.png"),
        )
    })

    it("rejects manifest-relative artifact paths that escape the artifact root", () => {
        expect(() => resolveTaskArtifactPath("task-paths", "../ui_messages.jsonl")).toThrow(ArtifactStoreError)
        expect(() => resolveTaskArtifactPath("task-paths", "images/../../ui_messages.jsonl")).toThrow(ArtifactStoreError)
    })

    it("limits project-scoped reads to the current task artifacts and tmp directories", () => {
        const taskId = "task-paths"
        const taskDirectory = getTaskArtifactDirectory(taskId)

        expect(isTaskReadScopePath(taskId, path.join(taskDirectory, "artifacts", "images", "generated.png"))).toBe(true)
        expect(isTaskReadScopePath(taskId, path.join(taskDirectory, "tmp", "image-previews", "preview"))).toBe(true)
        expect(isTaskReadScopePath(taskId, path.join(taskDirectory, "ui_messages.jsonl"))).toBe(false)
        expect(isTaskReadScopePath(taskId, path.join(taskDirectory, "artifacts-other", "generated.png"))).toBe(false)
        expect(
            isTaskReadScopePath(
                taskId,
                path.join(getTaskArtifactDirectory("another-task"), "artifacts", "images", "generated.png"),
            ),
        ).toBe(false)
        expect(isTaskReadScopePath(taskId, "artifacts/images/generated.png")).toBe(false)
    })
})
