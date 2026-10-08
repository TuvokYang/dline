import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { TaskActivityRecord } from "@shared/task-activity"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LEGACY_ACTIVITY_MIGRATED_SUFFIX, TaskActivityRowStore } from "@/core/storage/activities/TaskActivityRowStore"
import { closeInstanceStoragesUnder } from "@/core/storage/instance"
import { TaskActivityPersistence } from "../TaskActivityPersistence"

function activity(taskId: string, activityId: string, title: string): TaskActivityRecord {
	return {
		schemaVersion: 2,
		activityId,
		taskId,
		kind: "command",
		executionMode: "foreground",
		cancellationOwner: "task",
		status: "completed",
		currentAttempt: 1,
		createdAt: 1,
		updatedAt: 2,
		title,
		events: [],
	} as unknown as TaskActivityRecord
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath)
		return true
	} catch {
		return false
	}
}

describe("TaskActivityPersistence over activities.db", () => {
	let documentsRoot: string

	beforeEach(async () => {
		documentsRoot = await mkdtemp(path.join(os.tmpdir(), "dline-activities-db-"))
		vi.stubEnv("DLINE_DOCS_DIR", documentsRoot)
	})

	afterEach(async () => {
		await closeInstanceStoragesUnder(documentsRoot)
		vi.unstubAllEnvs()
		await rm(documentsRoot, { recursive: true, force: true })
	})

	async function taskDirectory(taskId: string): Promise<string> {
		const directory = path.join(documentsRoot, "tasks", taskId)
		await mkdir(directory, { recursive: true })
		return directory
	}

	it("writes only the activities passed and keeps the others after reopening", async () => {
		const writer = new TaskActivityPersistence("task-save")
		await writer.upsert([activity("task-save", "b", "second"), activity("task-save", "a", "first")])
		await writer.upsert([activity("task-save", "b", "second v2")])
		await writer.close()

		const reader = new TaskActivityPersistence("task-save")
		const loaded = await reader.load()
		// Equal creation times fall back to the activity id, as the activity list does.
		expect(loaded.map((record) => [record.activityId, record.title])).toEqual([
			["a", "first"],
			["b", "second v2"],
		])
		await reader.close()
	})

	it("imports a legacy activities.json once and renames it to .migrated", async () => {
		const directory = await taskDirectory("task-legacy")
		const legacy = path.join(directory, "activities.json")
		const original = JSON.stringify({
			schemaVersion: 1,
			taskId: "task-legacy",
			activities: [activity("task-legacy", "x", "old")],
		})
		await writeFile(legacy, original, "utf8")

		const persistence = new TaskActivityPersistence("task-legacy")
		expect((await persistence.load()).map((record) => record.title)).toEqual(["old"])
		expect(await exists(legacy)).toBe(false)
		expect(await readFile(`${legacy}${LEGACY_ACTIVITY_MIGRATED_SUFFIX}`, "utf8")).toBe(original)
		await persistence.close()

		const reopened = new TaskActivityPersistence("task-legacy")
		expect((await reopened.load()).map((record) => record.title)).toEqual(["old"])
		await reopened.close()
	})

	it("keeps an unreadable legacy file and opens with an empty history", async () => {
		const directory = await taskDirectory("task-broken")
		const legacy = path.join(directory, "activities.json")
		await writeFile(legacy, "{not json", "utf8")

		const persistence = new TaskActivityPersistence("task-broken")
		expect(await persistence.load()).toEqual([])
		expect(await readFile(legacy, "utf8")).toBe("{not json")
		await persistence.close()
	})

	it("drops activities that belong to another task", async () => {
		const directory = await taskDirectory("task-owner")
		await writeFile(
			path.join(directory, "activities.json"),
			JSON.stringify({ schemaVersion: 2, taskId: "someone-else", activities: [activity("someone-else", "x", "foreign")] }),
			"utf8",
		)

		const persistence = new TaskActivityPersistence("task-owner")
		expect(await persistence.load()).toEqual([])
		await persistence.close()
	})

	it("rejects a second writer while the task's activity store is open", async () => {
		const owner = new TaskActivityPersistence("task-writer")
		await owner.upsert([activity("task-writer", "a", "owned")])

		const intruder = await TaskActivityRowStore.open("task-writer")
		expect(await intruder.read()).toHaveLength(1)
		await expect(intruder.upsert([activity("task-writer", "b", "intruder")])).rejects.toThrow(
			/InstanceDatabaseWriterConflict/,
		)
		await intruder.close()
		await owner.close()
	})
})
