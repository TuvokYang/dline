import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { openBufferedJsonlStore } from "../../jsonl/JsonlUnifyStore"

const diagnostics = vi.hoisted(() => ({ record: vi.fn() }))

vi.mock("@/services/telemetry/instrumentation/diagnostic-recorder", () => ({
	recordDiagnostic: diagnostics.record,
}))

/**
 * Behavior guard for committing from the buffered baseline.
 *
 * A task holds the only writable handle on its message files, so the buffer
 * already knows what the file holds. A commit has to use that knowledge: no
 * full read, and only the changed tail rewritten. A collection that another
 * handle changed must still go through the commit that reads and merges it,
 * because trusting a stale baseline there would cut the other writer's lines.
 */

interface Row {
	ts: number
	value: string
}

const roots: string[] = []

function createFixturePath(): string {
	const root = mkdtempSync(path.join(os.tmpdir(), "dline-baseline-commit-"))
	roots.push(root)
	return path.join(root, "rows.jsonl")
}

function seed(filePath: string, rows: readonly Row[]): void {
	writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8")
}

function readRows(filePath: string): Row[] {
	return readFileSync(filePath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Row)
}

function openStore(filePath: string, ensureUniqueAppendTimestamp = false) {
	return openBufferedJsonlStore<Row>(filePath, {
		schemaId: "baseline-commit",
		flushIntervalMs: 60_000,
		ensureUniqueAppendTimestamp,
		acceptInitialItem: (row) => row.ts > 0,
	})
}

/** Count full reads and atomic rewrites of the data file from here on. */
function watchWholeFileIo(filePath: string) {
	const readSpy = vi.spyOn(fs, "readFile")
	const writeSpy = vi.spyOn(fs, "writeFile")
	const target = path.resolve(filePath)
	return {
		fullReads: () => readSpy.mock.calls.filter(([file]) => path.resolve(String(file)) === target).length,
		// writeJsonl stages the whole collection in a sibling temp file.
		rewrites: () => writeSpy.mock.calls.filter(([file]) => String(file).startsWith(`${filePath}.tmp.`)).length,
	}
}

const ROWS: readonly Row[] = [
	{ ts: 10, value: "a" },
	{ ts: 20, value: "b" },
	{ ts: 30, value: "c" },
	{ ts: 40, value: "d" },
]

afterEach(() => {
	vi.restoreAllMocks()
	diagnostics.record.mockClear()
})

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe("BufferedUnifyStore baseline commit", () => {
	it("appends to a unique-timestamp store without reading the collection", async () => {
		const filePath = createFixturePath()
		seed(filePath, ROWS.slice(0, 2))
		const store = await openStore(filePath, true)
		const io = watchWholeFileIo(filePath)
		try {
			const inode = statSync(filePath).ino
			await store.append({ ts: 20, value: "collides" })
			await store.flush()

			expect(io.fullReads()).toBe(0)
			expect(io.rewrites()).toBe(0)
			expect(statSync(filePath).ino).toBe(inode)
			expect(readRows(filePath)).toEqual([...ROWS.slice(0, 2), { ts: 21, value: "collides" }])
		} finally {
			await store.close()
		}
	})

	it("commits a patch that changes nothing without touching the collection", async () => {
		const filePath = createFixturePath()
		seed(filePath, ROWS.slice(0, 2))
		const store = await openStore(filePath)
		const io = watchWholeFileIo(filePath)
		try {
			const before = readFileSync(filePath, "utf8")
			await store.stagePatchAt(0, { value: "a" })
			await store.flush()

			expect(io.fullReads()).toBe(0)
			expect(io.rewrites()).toBe(0)
			expect(readFileSync(filePath, "utf8")).toBe(before)
		} finally {
			await store.close()
		}
	})

	it("rewrites only the changed tail when a persisted entry is patched", async () => {
		const filePath = createFixturePath()
		seed(filePath, ROWS)
		const store = await openStore(filePath)
		const io = watchWholeFileIo(filePath)
		const expected = [...ROWS.slice(0, 3), { ts: 40, value: "edited" }]
		try {
			const inode = statSync(filePath).ino
			await store.stagePatchAt(3, { value: "edited" })
			await store.flush()

			expect(io.fullReads()).toBe(0)
			expect(io.rewrites()).toBe(0)
			expect(statSync(filePath).ino).toBe(inode)
			expect(readRows(filePath)).toEqual(expected)
		} finally {
			await store.close()
		}

		const reopened = await openStore(filePath)
		try {
			expect(reopened.getAll()).toEqual(expected)
		} finally {
			await reopened.close()
		}
	})

	it("rewrites the tail of a unique-timestamp store that was patched and appended to", async () => {
		const filePath = createFixturePath()
		seed(filePath, ROWS.slice(0, 3))
		const store = await openStore(filePath, true)
		const io = watchWholeFileIo(filePath)
		const expected = [...ROWS.slice(0, 2), { ts: 30, value: "edited" }, { ts: 31, value: "appended" }]
		try {
			await store.stagePatchAt(2, { value: "edited" })
			await store.append({ ts: 30, value: "appended" })
			await store.flush()

			expect(io.fullReads()).toBe(0)
			expect(io.rewrites()).toBe(0)
			expect(readRows(filePath)).toEqual(expected)
		} finally {
			await store.close()
		}

		const reopened = await openStore(filePath, true)
		try {
			expect(reopened.getAll()).toEqual(expected)
		} finally {
			await reopened.close()
		}
	})

	it("writes the tail back after a tail rewrite was interrupted", async () => {
		const filePath = createFixturePath()
		seed(filePath, ROWS.slice(0, 3))
		const store = await openStore(filePath)
		const expected = [...ROWS.slice(0, 2), { ts: 30, value: "edited" }]
		try {
			await store.stagePatchAt(2, { value: "edited" })
			const appendSpy = vi
				.spyOn(fs, "appendFile")
				.mockRejectedValueOnce(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }))
			await expect(store.flush()).rejects.toThrow(/ENOSPC/)
			appendSpy.mockRestore()

			await store.flush()
			expect(readRows(filePath)).toEqual(expected)
		} finally {
			await store.close()
		}

		const reopened = await openStore(filePath)
		try {
			expect(reopened.getAll()).toEqual(expected)
		} finally {
			await reopened.close()
		}
	})

	it("merges instead of trusting the baseline when another handle changed the collection", async () => {
		const filePath = createFixturePath()
		seed(filePath, ROWS.slice(0, 2))
		const stale = await openStore(filePath)
		const active = await openStore(filePath)
		try {
			await stale.stagePatchAt(1, { value: "patched" })
			await active.append({ ts: 30, value: "tail" })
			await active.flush()
			await stale.flush()

			// Truncating by the stale handle's own count would have cut the other
			// writer's line and kept the entry it was replacing.
			expect(readRows(filePath)).toEqual([
				{ ts: 10, value: "a" },
				{ ts: 20, value: "patched" },
				{ ts: 30, value: "tail" },
			])
			expect(diagnostics.record).toHaveBeenCalledWith(
				"storage",
				"baseline_diverged",
				"degraded",
				expect.objectContaining({ reason: "tail_mismatch", store_kind: "other" }),
			)
		} finally {
			await Promise.all([stale.close(), active.close()])
		}
	})

	it("rewrites the whole collection when the file holds lines the buffer does not", async () => {
		const filePath = createFixturePath()
		// The unreadable last line is skipped on load, so the file holds one line
		// more than the buffer holds entries. Cutting two entries by count would
		// remove that line and "c", keep "b", and leave "b" twice after the append.
		writeFileSync(
			filePath,
			`${ROWS.slice(0, 3)
				.map((row) => JSON.stringify(row))
				.join("\n")}\nnot json\n`,
			"utf8",
		)
		const store = await openStore(filePath)
		const expected = [ROWS[0], { ts: 20, value: "edited" }, ROWS[2]]
		try {
			await store.stagePatchAt(1, { value: "edited" })
			await store.flush()

			expect(readRows(filePath)).toEqual(expected)
		} finally {
			await store.close()
		}

		const reopened = await openStore(filePath)
		try {
			expect(reopened.getAll()).toEqual(expected)
		} finally {
			await reopened.close()
		}
	})
})
