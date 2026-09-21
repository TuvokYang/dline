import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	ensureTaskTempSectionSync,
	getTaskTempDirectory,
	getTaskTempSectionDirectory,
	isTaskTempPath,
	pruneTaskCommandLogs,
	resolveTaskTempLogPath,
	TaskTempSection,
} from "../task-temp"

const TASK_ID = "task-temp-subject"

let documentsDirectory: string

async function writeCommandLog(name: string, content: string, ageMs = 0): Promise<string> {
	const directory = ensureTaskTempSectionSync(TASK_ID, TaskTempSection.CommandLogs)
	const filePath = path.join(directory, name)
	await fs.writeFile(filePath, content, "utf8")
	if (ageMs > 0) {
		const stamp = new Date(Date.now() - ageMs)
		await fs.utimes(filePath, stamp, stamp)
	}
	return filePath
}

beforeEach(async () => {
	documentsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dline-task-temp-"))
	vi.stubEnv("DLINE_DOCS_DIR", documentsDirectory)
})

afterEach(async () => {
	vi.unstubAllEnvs()
	await fs.rm(documentsDirectory, { recursive: true, force: true })
})

describe("task temp storage", () => {
	it("resolves every section under the task-owned tmp root", () => {
		expect(getTaskTempDirectory(TASK_ID)).toBe(path.join(documentsDirectory, "tasks", TASK_ID, "tmp"))
		expect(getTaskTempSectionDirectory(TASK_ID, TaskTempSection.CommandLogs)).toBe(
			path.join(documentsDirectory, "tasks", TASK_ID, "tmp", "command-logs"),
		)
		expect(getTaskTempSectionDirectory(TASK_ID, TaskTempSection.ShellDiagnostics)).toBe(
			path.join(documentsDirectory, "tasks", TASK_ID, "tmp", "shell-diagnostics"),
		)
	})

	it("creates the section directory and uses the supplied stem as the log file name", async () => {
		const logPath = resolveTaskTempLogPath(TASK_ID, TaskTempSection.CommandLogs, "command_100_1")

		expect(logPath).toBe(path.join(documentsDirectory, "tasks", TASK_ID, "tmp", "command-logs", "command_100_1.log"))
		await expect(fs.stat(path.dirname(logPath))).resolves.toBeDefined()
	})

	it("rejects a stem that would leave its section", () => {
		expect(() => resolveTaskTempLogPath(TASK_ID, TaskTempSection.CommandLogs, "../escape")).toThrow(
			/Invalid task temp file stem/,
		)
		expect(() => resolveTaskTempLogPath(TASK_ID, TaskTempSection.CommandLogs, "nested/command")).toThrow(
			/Invalid task temp file stem/,
		)
		expect(() => resolveTaskTempLogPath(TASK_ID, TaskTempSection.CommandLogs, "")).toThrow(/Invalid task temp file stem/)
	})

	it("rejects a task identity that would leave the tasks root", () => {
		expect(() => getTaskTempDirectory("../other-task")).toThrow(/Invalid task identity/)
	})

	it("recognizes only paths inside the task tmp root", () => {
		const tempRoot = getTaskTempDirectory(TASK_ID)

		expect(isTaskTempPath(TASK_ID, path.join(tempRoot, "command-logs", "a.log"))).toBe(true)
		expect(isTaskTempPath(TASK_ID, path.join(tempRoot, "..", "ui_messages.jsonl"))).toBe(false)
		expect(isTaskTempPath(TASK_ID, "relative/path.log")).toBe(false)
	})

	it("keeps an old command log while the task stays within its size budget", async () => {
		const ancient = await writeCommandLog("ancient.log", "old", 400 * 24 * 60 * 60 * 1000)
		const fresh = await writeCommandLog("fresh.log", "new")

		const result = await pruneTaskCommandLogs(TASK_ID, { maxTotalBytes: 1024 })

		expect(result).toEqual({ deletedCount: 0, freedBytes: 0 })
		await expect(fs.readFile(ancient, "utf8")).resolves.toBe("old")
		await expect(fs.readFile(fresh, "utf8")).resolves.toBe("new")
	})

	it("trims the oldest command logs when the total size limit is exceeded", async () => {
		const oldest = await writeCommandLog("oldest.log", "x".repeat(600), 3 * 60 * 1000)
		const middle = await writeCommandLog("middle.log", "y".repeat(600), 2 * 60 * 1000)
		const newest = await writeCommandLog("newest.log", "z".repeat(600), 60 * 1000)

		const result = await pruneTaskCommandLogs(TASK_ID, { maxTotalBytes: 1000 })

		expect(result.deletedCount).toBe(2)
		expect(result.freedBytes).toBe(1200)
		await expect(fs.stat(oldest)).rejects.toThrow()
		await expect(fs.stat(middle)).rejects.toThrow()
		await expect(fs.readFile(newest, "utf8")).resolves.toHaveLength(600)
	})

	it("reports nothing to prune when the task never wrote a command log", async () => {
		await expect(pruneTaskCommandLogs(TASK_ID)).resolves.toEqual({ deletedCount: 0, freedBytes: 0 })
	})
})
