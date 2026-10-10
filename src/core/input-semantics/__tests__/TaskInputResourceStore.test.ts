import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
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

async function openStore(taskId: string) {
    const { TaskInputResourceStore } = await import("../TaskInputResourceStore")
    return new TaskInputResourceStore(taskId)
}

describe("TaskInputResourceStore", () => {
    it("keeps the authoritative copy inside the task temp storage", async () => {
        const store = await openStore("task-resources-1")

        const resource = await store.storeText("first\nsecond\nthird")

        expect(resource.absolutePath).toContain(path.join("tasks", "task-resources-1", "tmp", "input-resources"))
        expect(readFileSync(resource.absolutePath, "utf8")).toBe("first\nsecond\nthird")
        expect(resource.ownerTaskId).toBe("task-resources-1")
        expect(resource.origin).toBe("pasted_text")
        expect(resource.lineCount).toBe(3)
        expect(resource.byteSize).toBe(18)
    })

    it("names the file readably and keeps two pastes in the same millisecond apart", async () => {
        const store = await openStore("task-resources-naming")

        const [first, second] = await Promise.all([store.storeText("one"), store.storeText("two")])

        expect(first.displayName).toMatch(/^input_\d{14}_[0-9a-f]{8}\.txt$/)
        expect(second.absolutePath).not.toBe(first.absolutePath)
        expect(readFileSync(first.absolutePath, "utf8")).toBe("one")
        expect(readFileSync(second.absolutePath, "utf8")).toBe("two")
    })

    it("reads a stored resource back when the content still matches its binding", async () => {
        const store = await openStore("task-resources-2")
        const resource = await store.storeText("payload")

        expect(await store.readText(resource)).toBe("payload")
        expect(await store.readText({ ...resource, contentHash: "0".repeat(64) })).toBeUndefined()
    })

    it("reports a missing resource instead of throwing", async () => {
        const store = await openStore("task-resources-3")

        expect(await store.readText({ absolutePath: path.join(tmpdir(), "absent.txt"), contentHash: "x" })).toBeUndefined()
    })

    it("refuses to read a path outside the task's own input resources", async () => {
        const store = await openStore("task-resources-4")
        const foreign = await (await openStore("task-resources-5")).storeText("other task content")

        expect(await store.readText(foreign)).toBeUndefined()
    })

    it("adopts a resource into the receiving task under a new identity", async () => {
        const source = await (await openStore("task-handoff-source")).storeText("handed over\npayload")
        const target = await openStore("task-handoff-target")

        const adopted = await target.adopt(source)

        expect(adopted.resourceId).not.toBe(source.resourceId)
        expect(adopted.ownerTaskId).toBe("task-handoff-target")
        expect(adopted.contentHash).toBe(source.contentHash)
        expect(adopted.lineCount).toBe(source.lineCount)
        expect(target.owns(adopted.absolutePath)).toBe(true)
        expect(readFileSync(adopted.absolutePath, "utf8")).toBe("handed over\npayload")
        expect(readFileSync(source.absolutePath, "utf8")).toBe("handed over\npayload")
    })

    it("leaves no partial copy when the adopted content does not match its binding", async () => {
        const source = await (await openStore("task-handoff-changed")).storeText("original")
        const target = await openStore("task-handoff-rejects")
        writeFileSync(source.absolutePath, "tampered", "utf8")

        await expect(target.adopt(source)).rejects.toThrow(/adopt input resource/i)
        expect(readFileSync(source.absolutePath, "utf8")).toBe("tampered")
    })
})
