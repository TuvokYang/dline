import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { openBufferedJsonlStore } from "../../jsonl/JsonlUnifyStore"

/**
 * Behavior guard for committing a flush by appending instead of rewriting.
 *
 * A buffered store that forces unique timestamps has to read the committed
 * state inside the file lock to resolve cross-process collisions, and that read
 * previously forced a full rewrite of the file on every flush. The commit now
 * appends when the merge only grew a tail, so these tests pin both halves: the
 * file must stop being rewritten, and the uniqueness semantics must survive.
 */

interface Row {
	ts: number
	value: string
}

const roots: string[] = []

function createFixturePath(): string {
	const root = mkdtempSync(path.join(os.tmpdir(), "dline-append-commit-"))
	roots.push(root)
	return path.join(root, "rows.jsonl")
}

function openStore(filePath: string, ensureUniqueAppendTimestamp = true) {
	return openBufferedJsonlStore<Row>(filePath, {
		schemaId: "append-commit",
		ensureUniqueAppendTimestamp,
	})
}

function readRows(filePath: string): Row[] {
	return readFileSync(filePath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Row)
}

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe("BufferedUnifyStore append commit", () => {
	it("grows the file in place instead of rewriting it when a flush only appends", async () => {
		const filePath = createFixturePath()
		const seed = await openStore(filePath)
		await seed.append({ ts: 10, value: "a" })
		await seed.append({ ts: 20, value: "b" })
		await seed.flush()
		await seed.close()

		const store = await openStore(filePath)
		try {
			const before = statSync(filePath)
			await store.append({ ts: 30, value: "c" })
			await store.flush()
			const after = statSync(filePath)

			// A rewrite replaces the file through a temp/rename, so the inode
			// changes. Keeping it is the observable proof that the existing lines
			// were never rewritten.
			expect(after.ino).toBe(before.ino)
			expect(readRows(filePath).map((row) => row.value)).toEqual(["a", "b", "c"])
		} finally {
			await store.close()
		}
	})

	it("skips a physical rewrite when a staged patch makes no logical change", async () => {
		const filePath = createFixturePath()
		const seed = await openStore(filePath)
		await seed.append({ ts: 10, value: "a" })
		await seed.append({ ts: 20, value: "b" })
		await seed.flush()
		await seed.close()

		const store = await openStore(filePath)
		try {
			const before = statSync(filePath)
			await store.stagePatchAt(0, { value: "a" })
			await store.flush()
			const after = statSync(filePath)

			expect(after.ino).toBe(before.ino)
			expect(readRows(filePath)).toEqual([
				{ ts: 10, value: "a" },
				{ ts: 20, value: "b" },
			])
		} finally {
			await store.close()
		}
	})

	it("still rewrites when an existing entry changes", async () => {
		const filePath = createFixturePath()
		const seed = await openStore(filePath)
		await seed.append({ ts: 10, value: "a" })
		await seed.append({ ts: 20, value: "b" })
		await seed.flush()
		await seed.close()

		const store = await openStore(filePath)
		try {
			await store.stageUpdateAt(0, { ts: 10, value: "edited" })
			await store.flush()

			expect(readRows(filePath).map((row) => row.value)).toEqual(["edited", "b"])
		} finally {
			await store.close()
		}
	})

	it("keeps timestamps unique across concurrent appenders", async () => {
		const filePath = createFixturePath()
		const left = await openStore(filePath)
		const right = await openStore(filePath)
		try {
			await left.append({ ts: 100, value: "left" })
			await right.append({ ts: 100, value: "right" })
			await Promise.all([left.flush(), right.flush()])

			const rows = readRows(filePath)
			expect(rows.map((row) => row.value).sort()).toEqual(["left", "right"])
			// The second writer has to observe the first one's committed timestamp
			// inside the lock and move off it.
			expect(new Set(rows.map((row) => row.ts)).size).toBe(2)
		} finally {
			await Promise.all([left.close(), right.close()])
		}
	})

	it("preserves a same-length replacement made by another writer", async () => {
		const filePath = createFixturePath()
		const seed = await openStore(filePath)
		await seed.append({ ts: 10, value: "a" })
		await seed.append({ ts: 20, value: "b" })
		await seed.flush()
		await seed.close()

		const stale = await openStore(filePath)
		const other = await openStore(filePath)
		try {
			await stale.append({ ts: 30, value: "stale-addition" })

			// Same entry count, different content: a commit that trusted a row
			// count or the local baseline would silently drop this.
			await other.replaceAll([
				{ ts: 10, value: "a" },
				{ ts: 20, value: "rewritten" },
			])

			await stale.flush()

			const rows = readRows(filePath)
			expect(rows.map((row) => row.value)).toContain("rewritten")
			expect(rows.map((row) => row.value)).toContain("stale-addition")
			expect(new Set(rows.map((row) => row.ts)).size).toBe(rows.length)
		} finally {
			await Promise.all([stale.close(), other.close()])
		}
	})

	it("does not append when an insert supersedes an existing key", async () => {
		const filePath = createFixturePath()
		const seed = await openStore(filePath, false)
		await seed.append({ ts: 10, value: "a" })
		await seed.append({ ts: 20, value: "b" })
		await seed.flush()
		await seed.close()

		const store = await openStore(filePath, false)
		try {
			// Dropping one entry and adding one keeps the total count identical.
			// A commit that only compared counts would append and leave the
			// removed row behind in the file.
			await store.mutate((items) => [...items.filter((row) => row.ts !== 10), { ts: 30, value: "c" }])

			expect(readRows(filePath).map((row) => row.value)).toEqual(["b", "c"])
		} finally {
			await store.close()
		}
	})

	it("keeps a legacy JSON array readable after appending", async () => {
		const filePath = createFixturePath()
		// The reader accepts this shape, so a store can be opened on it. Appending
		// a line after the closing bracket would leave content JSON.parse rejects,
		// losing every existing entry.
		writeFileSync(filePath, JSON.stringify([{ ts: 10, value: "legacy" }]), "utf8")

		const store = await openStore(filePath)
		try {
			await store.append({ ts: 20, value: "added" })
			await store.flush()
		} finally {
			await store.close()
		}

		const reopened = await openStore(filePath)
		try {
			expect(reopened.getAll().map((row) => row.value)).toEqual(["legacy", "added"])
		} finally {
			await reopened.close()
		}
	})

	it("keeps a legacy JSON array with leading whitespace readable after appending", async () => {
		const filePath = createFixturePath()
		// The reader accepts an array after leading whitespace, so the append
		// guard has to apply the same rule: looking only at the very first byte
		// would classify this as JSONL and concatenate a line after the closing
		// bracket, leaving a file the reader can no longer parse at all.
		writeFileSync(filePath, `\n  ${JSON.stringify([{ ts: 10, value: "legacy" }])}\n`, "utf8")

		const store = await openStore(filePath)
		try {
			await store.append({ ts: 20, value: "appended" })
			await store.flush()
		} finally {
			await store.close()
		}

		const reopened = await openStore(filePath)
		try {
			expect(reopened.getAll()).toEqual([
				{ ts: 10, value: "legacy" },
				{ ts: 20, value: "appended" },
			])
		} finally {
			await reopened.close()
		}
	})

	it("keeps a file without a trailing newline readable after appending", async () => {
		const filePath = createFixturePath()
		// Without the newline the appended record would be concatenated onto the
		// last one, producing a line that parses as neither.
		writeFileSync(filePath, JSON.stringify({ ts: 10, value: "unterminated" }), "utf8")

		const store = await openStore(filePath)
		try {
			await store.append({ ts: 20, value: "added" })
			await store.flush()
		} finally {
			await store.close()
		}

		const reopened = await openStore(filePath)
		try {
			expect(reopened.getAll().map((row) => row.value)).toEqual(["unterminated", "added"])
		} finally {
			await reopened.close()
		}
	})

	it("leaves the file untouched when a transaction fails", async () => {
		const filePath = createFixturePath()
		const seed = await openStore(filePath)
		await seed.append({ ts: 10, value: "a" })
		await seed.flush()
		await seed.close()

		const before = readFileSync(filePath, "utf8")
		const store = await openStore(filePath)
		try {
			await expect(
				store.mutate(() => {
					throw new Error("transaction failed")
				}),
			).rejects.toThrow("transaction failed")

			// Appending commits must keep the same all-or-nothing guarantee the
			// rewrite path had.
			expect(readFileSync(filePath, "utf8")).toBe(before)
		} finally {
			await store.close()
		}
	})
})
