import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resolveTaskMetricsDatabase } from "../task-metrics-database"

describe("resolveTaskMetricsDatabase", () => {
	let documentsRoot: string
	const previousDocs = process.env.DLINE_DOCS_DIR

	beforeEach(async () => {
		documentsRoot = await mkdtemp(path.join(os.tmpdir(), "dline-metrics-db-"))
		process.env.DLINE_DOCS_DIR = documentsRoot
	})

	afterEach(async () => {
		if (previousDocs === undefined) delete process.env.DLINE_DOCS_DIR
		else process.env.DLINE_DOCS_DIR = previousDocs
		await rm(documentsRoot, { recursive: true, force: true })
	})

	const taskRoot = (taskId: string) => path.join(documentsRoot, "tasks", taskId)

	it("names the task's metrics.db", async () => {
		expect(await resolveTaskMetricsDatabase("task-new")).toBe(path.join(taskRoot("task-new"), "metrics.db"))
	})

	// Builds before the instance layout kept metrics in <task-id>.db; they must
	// survive the rename together with the WAL that may hold recent rows.
	it("moves a legacy <task-id>.db and its WAL into metrics.db once", async () => {
		const root = taskRoot("task-old")
		await mkdir(root, { recursive: true })
		await writeFile(path.join(root, "task-old.db"), "main")
		await writeFile(path.join(root, "task-old.db-wal"), "wal")

		const location = await resolveTaskMetricsDatabase("task-old")

		expect(location).toBe(path.join(root, "metrics.db"))
		expect(await readFile(location, "utf-8")).toBe("main")
		expect(await readFile(`${location}-wal`, "utf-8")).toBe("wal")
		await expect(readFile(path.join(root, "task-old.db"))).rejects.toThrow()
	})

	it("keeps an existing metrics.db rather than overwriting it with a legacy file", async () => {
		const root = taskRoot("task-both")
		await mkdir(root, { recursive: true })
		await writeFile(path.join(root, "metrics.db"), "current")
		await writeFile(path.join(root, "task-both.db"), "legacy")

		const location = await resolveTaskMetricsDatabase("task-both")

		expect(await readFile(location, "utf-8")).toBe("current")
	})

	it("uses an explicit location as given", async () => {
		expect(await resolveTaskMetricsDatabase("task-x", "/elsewhere/custom.db")).toBe("/elsewhere/custom.db")
	})
})
