import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const previousDocumentsDir = process.env.DLINE_DOCS_DIR

beforeAll(() => {
    process.env.DLINE_DOCS_DIR = mkdtempSync(path.join(tmpdir(), "dline-input-resources-"))
})

afterAll(() => {
    if (previousDocumentsDir === undefined) delete process.env.DLINE_DOCS_DIR
    else process.env.DLINE_DOCS_DIR = previousDocumentsDir
})

async function load() {
    const [{ openTaskInputResources, taskInputResourceRoot }, { referenceOf }, { isTaskTempPath }] = await Promise.all([
        import("../TaskInputResourceStore"),
        import("../InputResourceStore"),
        import("@core/storage/task-temp"),
    ])
    return { openTaskInputResources, taskInputResourceRoot, referenceOf, isTaskTempPath }
}

describe("taskInputResourceRoot", () => {
    it("keeps each resource in its own directory inside the task's input-resource storage", async () => {
        const { taskInputResourceRoot } = await load()
        const root = taskInputResourceRoot("task-resources-1")
        const resourceId = "6f1c1f5e-3c55-4a8e-9a43-0c7b8a1e2d3f"

        expect(root.owner).toEqual({ kind: "task", taskId: "task-resources-1" })
        // Task storage lives as long as the task, so nothing needs to keep it alive.
        expect(root.onVerifiedAccess).toBeUndefined()
        expect(root.resourceDirectory(resourceId)).toBe(
            path.join(process.env.DLINE_DOCS_DIR as string, "tasks", "task-resources-1", "tmp", "input-resources", resourceId),
        )
    })

    it("refuses an identity that would address a directory outside the section", async () => {
        const { taskInputResourceRoot } = await load()

        expect(() => taskInputResourceRoot("../other-task")).toThrow(/task identity/i)
        expect(() => taskInputResourceRoot("task-resources-2").resourceDirectory("../escape")).toThrow(/stem/i)
    })
})

describe("openTaskInputResources", () => {
    it("stages a resource the task read scope already covers", async () => {
        const { openTaskInputResources, referenceOf, isTaskTempPath } = await load()
        const store = openTaskInputResources("task-resources-3")

        const staged = await store.stageText("first\nsecond\nthird")
        if (!staged.ok) throw new Error(staged.failure.message)
        const resolved = await store.resolve(referenceOf(staged.value))

        expect(staged.value.owner).toEqual({ kind: "task", taskId: "task-resources-3" })
        expect(resolved.ok && isTaskTempPath("task-resources-3", resolved.value.contentPath)).toBe(true)
    })

    it("does not resolve a resource that belongs to another task", async () => {
        const { openTaskInputResources, referenceOf } = await load()
        const other = await openTaskInputResources("task-resources-4").stageText("other task content")
        if (!other.ok) throw new Error(other.failure.message)

        const result = await openTaskInputResources("task-resources-5").resolve(referenceOf(other.value))

        expect(result.ok ? undefined : result.failure.code).toBe("semantic_input_resource_invalid")
    })
})
