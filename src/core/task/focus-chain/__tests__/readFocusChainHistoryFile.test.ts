import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { readFocusChainHistoryFile } from "../file-utils"

describe("readFocusChainHistoryFile", () => {
	let docsDir: string
	let previousDocsDir: string | undefined

	beforeEach(async () => {
		docsDir = await fs.mkdtemp(path.join(os.tmpdir(), "dline-focus-history-"))
		previousDocsDir = process.env.DLINE_DOCS_DIR
		process.env.DLINE_DOCS_DIR = docsDir
	})

	afterEach(async () => {
		if (previousDocsDir === undefined) delete process.env.DLINE_DOCS_DIR
		else process.env.DLINE_DOCS_DIR = previousDocsDir
		await fs.rm(docsDir, { recursive: true, force: true })
	})

	it("reads the history a task recorded", async () => {
		const taskDir = path.join(docsDir, "tasks", "task-1")
		await fs.mkdir(taskDir, { recursive: true })
		await fs.writeFile(path.join(taskDir, "focus_chain_taskid_task-1_history.md"), "- [x] done\n", "utf8")

		await expect(readFocusChainHistoryFile("task-1")).resolves.toBe("- [x] done\n")
	})

	// A task opened only for viewing must not gain a directory.
	it("returns null without creating the task directory when no history was recorded", async () => {
		await expect(readFocusChainHistoryFile("task-2")).resolves.toBeNull()
		await expect(fs.stat(path.join(docsDir, "tasks", "task-2"))).rejects.toMatchObject({ code: "ENOENT" })
	})
})
