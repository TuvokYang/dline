import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { openBufferedJsonlStore } from "../../jsonl/JsonlUnifyStore"

/**
 * Behavior guard for the lazily maintained timestamp index.
 *
 * Sorting eagerly inside every mutation made a burst of staged updates pay one
 * full sort each, which dominated streaming on a long conversation. The rebuild
 * is now deferred to the next reader, so these tests assert that deferral stays
 * invisible: ordering, range reads, and collision handling must be unchanged.
 */

interface Row {
	ts: number
	text: string
}

type IndexProbe = {
	timestampIndexStale: boolean
	rebuildTimestampIndex(): void
}

const roots: string[] = []

function createFixturePath(): string {
	const root = mkdtempSync(path.join(os.tmpdir(), "dline-ts-index-"))
	roots.push(root)
	return path.join(root, "rows.jsonl")
}

async function createStore(ensureUniqueAppendTimestamp = false) {
	// openBufferedJsonlStore spreads its options straight into bufferOptions, so
	// buffer flags belong at the top level. Nesting them silently disables the
	// flag and makes a uniqueness test pass for the wrong reason.
	return await openBufferedJsonlStore<Row>(createFixturePath(), {
		schemaId: "timestamp-index",
		ensureUniqueAppendTimestamp,
	})
}

function probe(store: object): IndexProbe {
	return store as unknown as IndexProbe
}

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe("BufferedUnifyStore timestamp index", () => {
	it("defers the rebuild until a reader needs the order", async () => {
		const store = await createStore()

		await store.append({ ts: 30, text: "c" })
		await store.append({ ts: 10, text: "a" })
		await store.append({ ts: 20, text: "b" })

		expect(probe(store).timestampIndexStale).toBe(true)

		const recent = await store.getRecent(3)

		expect(probe(store).timestampIndexStale).toBe(false)
		expect(recent.map((row) => row.ts)).toEqual([10, 20, 30])
	})

	it("coalesces a burst of mutations into a single rebuild", async () => {
		const store = await createStore()
		const target = probe(store)
		const original = target.rebuildTimestampIndex.bind(store)
		let rebuilds = 0
		target.rebuildTimestampIndex = () => {
			rebuilds++
			original()
		}

		for (let index = 0; index < 25; index++) {
			await store.append({ ts: 100 - index, text: `row-${index}` })
		}
		await store.getRecent(5)

		// One rebuild for 25 mutations is the whole point; eager sorting did 25.
		expect(rebuilds).toBe(1)
	})

	it("keeps a staged out-of-order entry visible to a range read", async () => {
		const store = await createStore()
		await store.append({ ts: 10, text: "a" })
		await store.append({ ts: 30, text: "c" })
		await store.getRecent(2)

		// Staged after the index was already materialized: the read must observe
		// it in sorted position, not in append order.
		await store.stageUpsertByTimestamp({ ts: 20, text: "b" })

		const range = await store.getRange(10, 31)

		expect(range.map((row) => row.ts)).toEqual([10, 20, 30])
	})

	it("keeps a staged update visible after the index was materialized", async () => {
		const store = await createStore()
		await store.append({ ts: 10, text: "a" })
		await store.append({ ts: 20, text: "b" })
		await store.getRecent(2)

		await store.stageUpsertByTimestamp({ ts: 20, text: "updated" })
		const recent = await store.getRecent(2)

		expect(recent.map((row) => row.text)).toEqual(["a", "updated"])
	})

	it("assigns unique timestamps to colliding appends against a stale index", async () => {
		const store = await createStore(true)

		await store.append({ ts: 10, text: "first" })
		await store.append({ ts: 10, text: "second" })
		await store.append({ ts: 10, text: "third" })

		const stored = await store.getRecent(3)

		// Collisions must still be broken even though no read happened between
		// the appends to refresh the index.
		expect(new Set(stored.map((row) => row.ts)).size).toBe(3)
		expect(stored.map((row) => row.text)).toEqual(["first", "second", "third"])
	})

	it("does not rebuild on every append when timestamps must stay unique", async () => {
		const store = await createStore(true)
		await store.append({ ts: 1, text: "seed" })
		await store.getRecent(1)

		const target = probe(store)
		const original = target.rebuildTimestampIndex.bind(store)
		let rebuilds = 0
		target.rebuildTimestampIndex = () => {
			rebuilds++
			original()
		}

		for (let index = 0; index < 20; index++) {
			await store.append({ ts: 100 + index, text: `row-${index}` })
		}

		// These appends have to read the index to detect collisions. Without
		// absorbing the new timestamp directly, each read would rebuild and the
		// deferral would buy nothing for this store kind.
		expect(rebuilds).toBe(0)
		const stored = await store.getRecent(21)
		expect(stored.map((row) => row.ts)).toEqual([...stored.map((row) => row.ts)].sort((a, b) => a - b))
	})

	it("reflects a reloaded committed baseline in ordered reads", async () => {
		const filePath = createFixturePath()
		const writer = await openBufferedJsonlStore<Row>(filePath, { schemaId: "timestamp-index" })
		await writer.mutate(() => [
			{ ts: 30, text: "c" },
			{ ts: 10, text: "a" },
			{ ts: 20, text: "b" },
		])

		const reader = await openBufferedJsonlStore<Row>(filePath, { schemaId: "timestamp-index" })
		const recent = await reader.getRecent(3)

		expect(recent.map((row) => row.ts)).toEqual([10, 20, 30])
	})
})
