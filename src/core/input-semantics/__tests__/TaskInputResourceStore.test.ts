import { mkdtempSync, readFileSync } from "node:fs"
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
		expect(resource.lineCount).toBe(3)
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
})
