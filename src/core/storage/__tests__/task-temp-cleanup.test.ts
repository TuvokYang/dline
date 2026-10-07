import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanupStaleTaskTempFiles, ensureTaskDirectoryExists } from "@/core/storage/disk"

describe("cleanupStaleTaskTempFiles", () => {
	let dlineDocsDir: string

	beforeEach(async () => {
		dlineDocsDir = await fs.mkdtemp(path.join(os.tmpdir(), "dline-task-temp-"))
		vi.stubEnv("DLINE_DOCS_DIR", dlineDocsDir)
	})

	afterEach(async () => {
		vi.unstubAllEnvs()
		await fs.rm(dlineDocsDir, { recursive: true, force: true })
	})

	async function writeFile(dir: string, name: string, ageMs: number): Promise<void> {
		const filePath = path.join(dir, name)
		await fs.writeFile(filePath, "x", "utf8")
		const mtime = new Date(Date.now() - ageMs)
		await fs.utimes(filePath, mtime, mtime)
	}

	it("removes stale temp files of every atomic writer and keeps fresh or unrelated files", async () => {
		const taskId = "stale-temp"
		const dir = await ensureTaskDirectoryExists(taskId)
		const stale = 5 * 60_000
		const staleTempNames = [
			"settings.json.tmp.1791122313218.k3j9x.json",
			"ui_messages.jsonl.tmp.0f8e2c1a-5b6d-4e7f-8a9b-0c1d2e3f4a5b",
			"snapshot.json.tmp.1791122313218",
		]
		for (const name of staleTempNames) await writeFile(dir, name, stale)
		await writeFile(dir, "activities.json.tmp.1791122313999", 0)
		await writeFile(dir, "notes.tmp", stale)
		await writeFile(dir, "ui_messages.jsonl", stale)
		await writeFile(dir, "snapshot.json.tmp.123", stale)

		await cleanupStaleTaskTempFiles(taskId)

		expect((await fs.readdir(dir)).sort()).toEqual(
			["activities.json.tmp.1791122313999", "notes.tmp", "snapshot.json.tmp.123", "ui_messages.jsonl"].sort(),
		)
	})

	it("ignores directories whose names look like temp files", async () => {
		const taskId = "temp-directory"
		const dir = await ensureTaskDirectoryExists(taskId)
		const nested = path.join(dir, "snapshot.json.tmp.1791122313218")
		await fs.mkdir(nested)
		const mtime = new Date(Date.now() - 5 * 60_000)
		await fs.utimes(nested, mtime, mtime)

		await cleanupStaleTaskTempFiles(taskId)

		expect((await fs.stat(nested)).isDirectory()).toBe(true)
	})
})
