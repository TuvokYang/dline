import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { column, defineEntity } from "../../api/EntitySchema"
import { JsonlUnifyStore } from "../../jsonl/JsonlUnifyStore"

/**
 * Contract guard for a transaction whose operation edits a queried entity.
 *
 * Committing a transaction by appending only its new tail is sound only while
 * the records it read still describe the leading lines of the file. `query`
 * hands the operation live entities, so an operation that edits one in place
 * would otherwise slip past a commit that never rewrites the prefix.
 *
 * The SQLite driver reads every entity out of the database, so an in-place edit
 * there is discarded. These tests pin the JSONL driver to the same observable
 * contract on both commit paths, which is what keeps the two backends
 * interchangeable.
 */

class MutableRow {
	static readonly storage = defineEntity<MutableRow>()({
		schemaId: "jsonl-transaction-mutation",
		version: 1,
		columns: {
			id: column.text({ primary: true }),
			value: column.text(),
		},
		defaultOrder: [{ field: "id", direction: "asc" }],
		hydrate: (values) => new MutableRow(values.id, values.value),
	})

	constructor(
		public id: string,
		public value: string,
	) {}
}

const codec = {
	decode: (value: unknown): MutableRow => {
		const record = value as { id: string; value: string }
		return new MutableRow(record.id, record.value)
	},
	encode: (row: MutableRow) => ({ id: row.id, value: row.value }),
}

const roots: string[] = []

async function createFixturePath(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-jsonl-tx-mutation-"))
	roots.push(root)
	return path.join(root, "rows.jsonl")
}

async function openStore(filePath: string) {
	return await JsonlUnifyStore.openRaw({
		filePath,
		entity: MutableRow,
		codec,
		appendOnlyInsert: true,
	})
}

async function readRows(filePath: string): Promise<{ id: string; value: string }[]> {
	const content = await fs.readFile(filePath, "utf8")
	return content
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { id: string; value: string })
}

afterAll(async () => {
	await Promise.allSettled(roots.map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("JSONL transaction with an in-place edited entity", () => {
	it("discards an in-place edit when the commit appends the new tail", async () => {
		const filePath = await createFixturePath()
		const store = await openStore(filePath)
		try {
			await store.insert([new MutableRow("a", "one")])

			await store.transaction(async (transaction) => {
				const rows = await transaction.query()
				expect(rows).toHaveLength(1)
				rows[0].value = "edited-in-place"
				await transaction.insert([new MutableRow("b", "two")])
			})

			// An edit that was never handed back through insert or replaceAll is
			// not a write on any backend, so the committed prefix must be intact.
			expect(await readRows(filePath)).toEqual([
				{ id: "a", value: "one" },
				{ id: "b", value: "two" },
			])
		} finally {
			await store.close()
		}
	})

	it("discards an in-place edit when the commit rewrites the file", async () => {
		const filePath = await createFixturePath()
		const store = await openStore(filePath)
		try {
			await store.insert([new MutableRow("a", "one")])

			await store.transaction(async (transaction) => {
				const rows = await transaction.query()
				rows[0].value = "edited-in-place"
				// Replacing forces the rewrite path, so the two commit shapes are
				// held to the same contract rather than only the fast one.
				await transaction.replaceAll([new MutableRow("a", "one"), new MutableRow("c", "three")])
			})

			expect(await readRows(filePath)).toEqual([
				{ id: "a", value: "one" },
				{ id: "c", value: "three" },
			])
		} finally {
			await store.close()
		}
	})

	it("does not let a record edited after insert collide with a committed key", async () => {
		const filePath = await createFixturePath()
		const store = await openStore(filePath)
		try {
			await store.insert([new MutableRow("a", "one")])

			await store.transaction(async (transaction) => {
				const pending = new MutableRow("b", "two")
				await transaction.insert([pending])
				// The conflict check ran when insert was called, but encoding
				// happens at commit. A driver that keeps the caller's object
				// alive until then would write a duplicate of the committed key.
				// The SQLite driver writes the row during insert, so an edit
				// afterwards cannot reach storage there either.
				pending.id = "a"
			})

			const rows = await readRows(filePath)
			expect(rows.map((row) => row.id)).toEqual(["a", "b"])
		} finally {
			await store.close()
		}
	})

	it("still rejects a primary key conflict against an in-place edited entity", async () => {
		const filePath = await createFixturePath()
		const store = await openStore(filePath)
		try {
			await store.insert([new MutableRow("a", "one")])

			await expect(
				store.transaction(async (transaction) => {
					const rows = await transaction.query()
					// Renaming the committed entity must not open a hole in the
					// conflict check: the file still holds the original key.
					rows[0].id = "renamed"
					await transaction.insert([new MutableRow("a", "duplicate")])
				}),
			).rejects.toThrow(/conflict/i)

			// A rejected transaction writes nothing on either commit path.
			expect(await readRows(filePath)).toEqual([{ id: "a", value: "one" }])
		} finally {
			await store.close()
		}
	})
})
