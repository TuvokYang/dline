import { access, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { column, defineEntity } from "../../backend/api/EntitySchema"
import {
	closeInstanceStoragesUnder,
	databaseLocation,
	ensureInstanceLayout,
	INSTANCE_BACKEND_ENV,
	InstanceBackend,
	InstanceDatabase,
	InstanceLayout,
	instanceRoot,
	openInstanceStorage,
	resolveInstanceLayout,
} from ".."

class Row {
	static readonly storage = defineEntity<Row>()({
		schemaId: "instance-storage-test-row",
		version: 1,
		columns: {
			id: column.integer({ primary: true }),
			text: column.text(),
		},
		hydrate: (values) => new Row(values.id, values.text),
	})

	constructor(
		readonly id: number,
		readonly text: string,
	) {}
}

async function exists(location: string): Promise<boolean> {
	return access(location).then(
		() => true,
		() => false,
	)
}

describe.each(Object.values(InstanceBackend))("instance storage on %s", (backend) => {
	let documentsRoot: string

	beforeEach(async () => {
		documentsRoot = await mkdtemp(path.join(os.tmpdir(), "dline-instance-storage-"))
		vi.stubEnv("DLINE_DOCS_DIR", documentsRoot)
		vi.stubEnv(INSTANCE_BACKEND_ENV, backend)
	})

	it("creates a new database in the configured backend", async () => {
		const layout = await ensureInstanceLayout({ taskId: "task-backend" })
		const storage = openInstanceStorage(layout.root)
		await (await (await storage.openDatabase(InstanceDatabase.Journal, "kernel-commit")).openStore(Row)).insert([
			new Row(1, "one"),
		])

		expect(storage.openBackends().get(InstanceDatabase.Journal)).toBe(backend)
		expect(await exists(databaseLocation(layout, InstanceDatabase.Journal, backend))).toBe(true)
		const other = backend === InstanceBackend.Sqlite ? InstanceBackend.Jsonl : InstanceBackend.Sqlite
		expect(await exists(databaseLocation(layout, InstanceDatabase.Journal, other))).toBe(false)
		await storage.close()
	})

	afterEach(async () => {
		vi.unstubAllEnvs()
		await closeInstanceStoragesUnder(documentsRoot)
		await rm(documentsRoot, { recursive: true, force: true })
	})

	it("lays out a subagent with the same shape directly below its task", () => {
		const task = new InstanceLayout(instanceRoot(documentsRoot, { taskId: "task-1" }))
		const subagent = new InstanceLayout(instanceRoot(documentsRoot, { taskId: "task-1", subagentId: "sub-2" }))

		expect(task.root).toBe(path.join(documentsRoot, "tasks", "task-1"))
		expect(subagent.root).toBe(path.join(documentsRoot, "tasks", "task-1", "subagents", "sub-2"))
		expect(path.relative(task.root, task.stateFile)).toBe(path.relative(subagent.root, subagent.stateFile))
		for (const kind of Object.values(InstanceDatabase)) {
			expect(path.relative(task.root, task.database(kind))).toBe(path.relative(subagent.root, subagent.database(kind)))
		}
	})

	it.each([
		["..", undefined],
		["task/../../escape", undefined],
		["", undefined],
		["task-1", ".."],
		["task-1", "a\\b"],
	])("rejects an identity that could leave the instance directory (task %j, subagent %j)", (taskId, subagentId) => {
		expect(() => instanceRoot(documentsRoot, { taskId, subagentId })).toThrow(/Invalid (task|subagent) identity/)
	})

	it("resolves without creating directories and creates them only on ensure", async () => {
		const resolved = await resolveInstanceLayout({ taskId: "task-view" })
		expect(resolved.root).toBe(path.join(documentsRoot, "tasks", "task-view"))
		expect(await exists(resolved.root)).toBe(false)

		const ensured = await ensureInstanceLayout({ taskId: "task-view", subagentId: "child" })
		expect(await exists(ensured.root)).toBe(true)
	})

	it("gives each database a single writer, lets others read, and releases the writer on close", async () => {
		const layout = await ensureInstanceLayout({ taskId: "task-writer" })
		const first = openInstanceStorage(layout.root)
		const database = await first.openDatabase(InstanceDatabase.Journal, "kernel-commit")
		await (await database.openStore(Row)).insert([new Row(1, "one")])

		const second = openInstanceStorage(layout.root)
		const intruder = await (await second.openDatabase(InstanceDatabase.Journal, "intruder")).openStore(Row)
		// A window that only shows the task may read it.
		expect((await intruder.query()).records).toEqual([new Row(1, "one")])
		await expect(intruder.insert([new Row(2, "two")])).rejects.toThrow(
			/InstanceDatabaseWriterConflict: journal\.db .* is written by kernel-commit; intruder cannot write it/,
		)
		await expect(intruder.transaction((transaction) => transaction.upsert([new Row(2, "two")]))).rejects.toThrow(
			/InstanceDatabaseWriterConflict/,
		)
		expect((await intruder.query()).records).toEqual([new Row(1, "one")])
		// A different database of the same instance has its own writer.
		const messages = await second.openDatabase(InstanceDatabase.Messages, "ui-projection")
		await expect((await messages.openStore(Row)).insert([new Row(1, "message")])).resolves.toBeUndefined()

		await first.close()
		const third = openInstanceStorage(layout.root)
		const reopened = await (await third.openDatabase(InstanceDatabase.Journal, "kernel-commit")).openStore(Row)
		await reopened.insert([new Row(2, "two")])
		expect((await reopened.query()).records).toEqual([new Row(1, "one"), new Row(2, "two")])
		await second.close()
		await third.close()
	})

	it("rejects opening the same database twice in one instance storage", async () => {
		const layout = await ensureInstanceLayout({ taskId: "task-twice" })
		const storage = openInstanceStorage(layout.root)
		await storage.openDatabase(InstanceDatabase.Journal, "kernel-commit")
		await expect(storage.openDatabase(InstanceDatabase.Journal, "kernel-commit")).rejects.toThrow(/already open/)
		await storage.close()
	})

	it("rejects new opens after close and treats repeated close as a no-op", async () => {
		const layout = await ensureInstanceLayout({ taskId: "task-closed" })
		const storage = openInstanceStorage(layout.root)
		await storage.openDatabase(InstanceDatabase.Activities, "activity-store")
		await storage.close()
		await storage.close()

		await expect(storage.openDatabase(InstanceDatabase.Activities, "activity-store")).rejects.toThrow(/is closed/)
	})

	it("closes every task and subagent database under a task root so the directory can be removed", async () => {
		const task = await ensureInstanceLayout({ taskId: "task-delete" })
		const child = await ensureInstanceLayout({ taskId: "task-delete", subagentId: "child" })
		const other = await ensureInstanceLayout({ taskId: "task-keep" })
		const taskStorage = openInstanceStorage(task.root)
		const childStorage = openInstanceStorage(child.root)
		const otherStorage = openInstanceStorage(other.root)
		await (await (await taskStorage.openDatabase(InstanceDatabase.Journal, "kernel-commit")).openStore(Row)).insert([
			new Row(1, "task"),
		])
		await (await (await childStorage.openDatabase(InstanceDatabase.Journal, "kernel-commit")).openStore(Row)).insert([
			new Row(1, "child"),
		])
		await (await (await otherStorage.openDatabase(InstanceDatabase.Journal, "kernel-commit")).openStore(Row)).insert([
			new Row(1, "other"),
		])

		await closeInstanceStoragesUnder(task.root)
		await rm(task.root, { recursive: true, force: true })

		expect(await exists(task.root)).toBe(false)
		await expect(taskStorage.openDatabase(InstanceDatabase.Journal, "kernel-commit")).rejects.toThrow(/is closed/)
		await expect(childStorage.openDatabase(InstanceDatabase.Journal, "kernel-commit")).rejects.toThrow(/is closed/)
		// The sibling task stays open and keeps its writer claim.
		const secondWriter = openInstanceStorage(other.root)
		const store = await (await secondWriter.openDatabase(InstanceDatabase.Journal, "second-writer")).openStore(Row)
		await expect(store.insert([new Row(2, "second")])).rejects.toThrow(/InstanceDatabaseWriterConflict/)
		await secondWriter.close()
		await otherStorage.close()
	})

	it("does not treat a sibling whose name shares a prefix as being under the task root", async () => {
		const task = await ensureInstanceLayout({ taskId: "task-a" })
		const sibling = await ensureInstanceLayout({ taskId: "task-ab" })
		const siblingStorage = openInstanceStorage(sibling.root)
		await siblingStorage.openDatabase(InstanceDatabase.Metrics, "metrics")

		await closeInstanceStoragesUnder(task.root)

		await expect(siblingStorage.openDatabase(InstanceDatabase.Journal, "kernel-commit")).resolves.toBeDefined()
		await siblingStorage.close()
	})
})
