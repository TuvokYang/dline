import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TransactionalUnifyStoreDatabase } from "../../api/UnifyStore"
import { JsonlUnifyStoreBackend } from "../../jsonl/JsonlDatabase"
import { MANIFEST_FILE_NAME } from "../../jsonl/JsonlDatabaseFiles"
import { ConformanceEntity, ParityEntity } from "./unify-store-conformance"

interface ManifestShape {
	version: number
	generation: number
	collections: Record<string, { file: string; size: number; rows: number }>
}

describe("JSONL database crash recovery and integrity", () => {
	let root: string
	const databases: TransactionalUnifyStoreDatabase[] = []

	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), "dline-jsonl-db-"))
	})

	afterEach(async () => {
		await Promise.allSettled(databases.splice(0).map((database) => database.close()))
		await rm(root, { recursive: true, force: true })
	})

	async function open(name = "db", backend = new JsonlUnifyStoreBackend()): Promise<TransactionalUnifyStoreDatabase> {
		const database = await backend.open(path.join(root, name))
		databases.push(database)
		return database
	}

	async function manifest(name = "db"): Promise<ManifestShape> {
		return JSON.parse(await readFile(path.join(root, name, MANIFEST_FILE_NAME), "utf8")) as ManifestShape
	}

	async function dataFile(name = "db", schemaId = ConformanceEntity.storage.schemaId): Promise<string> {
		return path.join(root, name, (await manifest(name)).collections[schemaId].file)
	}

	it("writes an indented manifest with a format version and one line per row", async () => {
		const store = await (await open()).openStore(ConformanceEntity)
		await store.insert([new ConformanceEntity("a", "g", 1, 1, "one"), new ConformanceEntity("b", "g", 2, 1, "two")])

		const text = await readFile(path.join(root, "db", MANIFEST_FILE_NAME), "utf8")
		expect(text).toMatch(/^\{\n {2}"format": "dline-unify-store-jsonl",\n/)
		expect(text.endsWith("}\n")).toBe(true)
		const lines = (await readFile(await dataFile(), "utf8")).split("\n")
		expect(lines).toHaveLength(3)
		expect(JSON.parse(lines[0])).toEqual({ id: "a", group: "g", sortKey: 1, revision: 1, value: "one" })
		expect((await manifest()).collections[ConformanceEntity.storage.schemaId].rows).toBe(2)
	})

	it("ignores rows appended by a writer that crashed before committing, and cuts them on the next write", async () => {
		const store = await (await open()).openStore(ConformanceEntity)
		await store.insert([new ConformanceEntity("a", "g", 1, 1, "committed")])
		const file = await dataFile()
		const committed = (await stat(file)).size
		// Bytes past the committed length, including a torn final line.
		await appendFile(file, `${JSON.stringify({ id: "x", group: "g", sortKey: 9, revision: 1, value: "lost" })}\n{"id":"y`)

		expect((await store.query()).records.map(({ id }) => id)).toEqual(["a"])
		await store.insert([new ConformanceEntity("b", "g", 2, 1, "next")])

		expect((await store.query()).records.map(({ id }) => id)).toEqual(["a", "b"])
		const lines = (await readFile(file, "utf8")).trimEnd().split("\n")
		expect(lines.map((line) => (JSON.parse(line) as { id: string }).id)).toEqual(["a", "b"])
		expect((await stat(file)).size).toBeGreaterThan(committed)
	})

	it("keeps the previous rows when a replacement crashed before committing, and removes the orphan file", async () => {
		const database = await open()
		const store = await database.openStore(ConformanceEntity)
		await store.insert([new ConformanceEntity("a", "g", 1, 1, "kept")])
		const current = await manifest()
		const entry = current.collections[ConformanceEntity.storage.schemaId]
		// A generation no later commit in this test reaches, so the name cannot be legitimately reused.
		const orphan = entry.file.replace(/\.jsonl$/, `.${current.generation + 50}.jsonl`)
		await writeFile(
			path.join(root, "db", orphan),
			`${JSON.stringify({ id: "z", group: "g", sortKey: 1, revision: 1, value: "x" })}\n`,
		)
		await writeFile(path.join(root, "db", `${MANIFEST_FILE_NAME}.123.00000000-0000-0000-0000-000000000000.tmp`), "{")

		// A fresh process opens the directory.
		vi.resetModules()
		const fresh = await import("../../jsonl/JsonlDatabase")
		const reopened = await open("db", new fresh.JsonlUnifyStoreBackend())
		const reader = await reopened.openStore(ConformanceEntity)
		expect((await reader.query()).records.map(({ value }) => value)).toEqual(["kept"])
		await reader.upsert([new ConformanceEntity("a", "g", 1, 2, "updated")])

		const names = await readdir(path.join(root, "db"))
		expect(names).not.toContain(orphan)
		expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([])
		expect((await reader.query()).records.map(({ value }) => value)).toEqual(["updated"])
	})

	it("replaces a collection atomically: an upsert writes a new file and retires the old one", async () => {
		const store = await (await open()).openStore(ConformanceEntity)
		await store.insert([new ConformanceEntity("a", "g", 1, 1, "old"), new ConformanceEntity("b", "g", 2, 1, "kept")])
		const before = await dataFile()

		await store.upsert([new ConformanceEntity("a", "g", 1, 2, "new")])

		const after = await dataFile()
		expect(after).not.toBe(before)
		await expect(stat(before)).rejects.toMatchObject({ code: "ENOENT" })
		expect((await store.query()).records.map(({ value }) => value)).toEqual(["new", "kept"])
	})

	it("rejects damaged committed data instead of returning a shorter history", async () => {
		const store = await (await open()).openStore(ConformanceEntity)
		await store.insert([new ConformanceEntity("a", "g", 1, 1, "one"), new ConformanceEntity("b", "g", 2, 1, "two")])
		const file = await dataFile()
		const text = await readFile(file, "utf8")
		// Same byte length, so only the value is wrong.
		await writeFile(file, text.replace('"value":"one"', '"value":12345'))

		vi.resetModules()
		const fresh = await import("../../jsonl/JsonlDatabase")
		const reader = await (await open("db", new fresh.JsonlUnifyStoreBackend())).openStore(ConformanceEntity)
		const failure = await reader.query().catch((error: unknown) => error)
		expect(failure).toMatchObject({ name: "UnifyStoreCorruptionError" })
		expect(String(failure)).toMatch(/Invalid unify-store-conformance\.value at .*:1/)
	})

	it("rejects a data file that lost committed bytes", async () => {
		const store = await (await open()).openStore(ConformanceEntity)
		await store.insert([new ConformanceEntity("a", "g", 1, 1, "one")])
		await writeFile(await dataFile(), "")

		vi.resetModules()
		const fresh = await import("../../jsonl/JsonlDatabase")
		const reader = await (await open("db", new fresh.JsonlUnifyStoreBackend())).openStore(ConformanceEntity)
		await expect(reader.query()).rejects.toThrow(/shorter than its committed length/)
	})

	it("refuses a manifest written by a newer format version", async () => {
		await (await open()).openStore(ConformanceEntity)
		const current = await manifest()
		await writeFile(path.join(root, "db", MANIFEST_FILE_NAME), JSON.stringify({ ...current, version: 99 }))

		vi.resetModules()
		const fresh = await import("../../jsonl/JsonlDatabase")
		const database = await open("db", new fresh.JsonlUnifyStoreBackend())
		await expect(database.openStore(ConformanceEntity)).rejects.toThrow(/newer than supported version/)
	})

	it("refuses a directory in the retired per-collection layout rather than removing its files", async () => {
		const legacy = path.join(root, "legacy")
		await mkdir(legacy)
		await writeFile(path.join(legacy, "unify-store-conformance-12345678.jsonl"), "{}\n")
		await writeFile(path.join(legacy, "unify-store-conformance-12345678.schema.json"), "{}")

		await expect(new JsonlUnifyStoreBackend().open(legacy)).rejects.toThrow(/retired per-collection JSONL layout/)
		expect(await readdir(legacy)).toHaveLength(2)
	})

	it("sees rows another process appends or replaces, and serializes their writers", async () => {
		const local = await (await open()).openStore(ConformanceEntity)
		await local.insert([new ConformanceEntity("a", "g", 1, 1, "local")])

		vi.resetModules()
		const other = await import("../../jsonl/JsonlDatabase")
		const remote = await (await open("db", new other.JsonlUnifyStoreBackend())).openStore(ConformanceEntity)
		await remote.insert([new ConformanceEntity("b", "g", 2, 1, "remote")])
		expect((await local.query()).records.map(({ id }) => id)).toEqual(["a", "b"])

		await Promise.all([
			local.insert([new ConformanceEntity("c", "g", 3, 1, "local")]),
			remote.insert([new ConformanceEntity("d", "g", 4, 1, "remote")]),
		])
		await remote.upsert([new ConformanceEntity("a", "g", 1, 2, "replaced remotely")])

		const { records } = await local.query()
		expect(records.map(({ id }) => id)).toEqual(["a", "b", "c", "d"])
		expect(records[0].value).toBe("replaced remotely")
		await expect(local.insert([new ConformanceEntity("d", "g", 5, 1, "duplicate")])).rejects.toThrow(/conflict/i)
	})

	it("reads rows larger than one read chunk", async () => {
		const store = await (await open()).openStore(ParityEntity)
		const large = "x".repeat(2_500_000)
		await store.insert([ParityEntity.named(1, "o", large), ParityEntity.named(2, "o", "small")])

		vi.resetModules()
		const fresh = await import("../../jsonl/JsonlDatabase")
		const reader = await (await open("db", new fresh.JsonlUnifyStoreBackend())).openStore(ParityEntity)
		const { records } = await reader.query()
		expect(records.map((record) => record.name.length)).toEqual([2_500_000, 5])
	})
})
