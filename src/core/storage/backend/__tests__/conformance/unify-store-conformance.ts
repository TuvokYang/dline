import { expect, it } from "vitest"
import { column, defineEntity } from "../../api/EntitySchema"
import type { UnifyStore, UnifyStoreBackend } from "../../api/UnifyStore"
import { asc, desc, eq, gte, latestPerGroup, lt } from "../../api/UnifyStoreQuery"

export class ConformanceEntity {
	static readonly storage = defineEntity<ConformanceEntity>()({
		schemaId: "unify-store-conformance",
		version: 1,
		columns: {
			id: column.text({ primary: true }),
			group: column.text({ indexed: true }),
			sortKey: column.integer({ indexed: true }),
			revision: column.integer({ indexed: true }),
			value: column.text(),
		},
		defaultOrder: [{ field: "sortKey", direction: "asc" }],
		hydrate: (values) => new ConformanceEntity(values.id, values.group, values.sortKey, values.revision, values.value),
	})

	constructor(
		readonly id: string,
		readonly group: string,
		readonly sortKey: number,
		readonly revision: number,
		readonly value: string,
	) {}
}

export interface UnifyStoreConformanceHarness {
	readonly backend: UnifyStoreBackend
	location(testName: string): string
}

export function runUnifyStoreConformance(harness: UnifyStoreConformanceHarness): void {
	const opened: UnifyStore<ConformanceEntity>[] = []

	async function open(testName: string): Promise<UnifyStore<ConformanceEntity>> {
		const database = await harness.backend.open(harness.location(testName))
		const store = await database.openStore(ConformanceEntity)
		const originalClose = store.close.bind(store)
		let closePromise: Promise<void> | undefined
		store.close = () => {
			closePromise ??= originalClose().then(() => database.close())
			return closePromise
		}
		opened.push(store)
		return store
	}

	async function closeOpened(): Promise<void> {
		await Promise.allSettled(opened.splice(0).map((store) => store.close()))
	}

	it("detects an existing entity schema without creating it", async () => {
		const database = await harness.backend.open(harness.location("has-store"))
		try {
			expect(await database.hasStore(ConformanceEntity)).toBe(false)
			const store = await database.openStore(ConformanceEntity)
			opened.push(store)
			expect(await database.hasStore(ConformanceEntity)).toBe(true)
		} finally {
			await closeOpened()
			await database.close()
		}
	})

	it("upserts by primary key, keeping unrelated records and letting the last duplicate win", async () => {
		try {
			const store = await open("upsert")
			await store.insert([
				new ConformanceEntity("a", "g", 10, 1, "old-a"),
				new ConformanceEntity("b", "g", 20, 1, "keep-b"),
			])
			await store.upsert([
				new ConformanceEntity("a", "g", 10, 2, "new-a"),
				new ConformanceEntity("c", "g", 30, 1, "first-c"),
				new ConformanceEntity("c", "g", 30, 2, "last-c"),
			])
			await store.transaction(async (transaction) => {
				await transaction.upsert([new ConformanceEntity("b", "g", 20, 3, "tx-b")])
			})

			const { records } = await store.query()
			expect(records.map((record) => [record.id, record.revision, record.value])).toEqual([
				["a", 2, "new-a"],
				["b", 3, "tx-b"],
				["c", 2, "last-c"],
			])
		} finally {
			await closeOpened()
		}
	})

	it("rolls back upserts made inside a failed transaction", async () => {
		try {
			const store = await open("upsert-rollback")
			await store.insert([new ConformanceEntity("a", "g", 10, 1, "old-a")])
			await expect(
				store.transaction(async (transaction) => {
					await transaction.upsert([new ConformanceEntity("a", "g", 10, 2, "new-a")])
					throw new Error("abort")
				}),
			).rejects.toThrow("abort")

			const { records } = await store.query()
			expect(records.map((record) => record.value)).toEqual(["old-a"])
		} finally {
			await closeOpened()
		}
	})

	it("uses schema default order and allows explicit order override", async () => {
		try {
			const store = await open("ordering")
			await store.insert([
				new ConformanceEntity("c", "g", 30, 1, "third"),
				new ConformanceEntity("a", "g", 10, 1, "first"),
				new ConformanceEntity("b", "g", 20, 1, "second"),
			])
			expect((await store.query()).records.map(({ id }) => id)).toEqual(["a", "b", "c"])
			expect(
				(await store.query({ orderBy: [desc(ConformanceEntity.storage.fields.sortKey)] })).records.map(({ id }) => id),
			).toEqual(["c", "b", "a"])
		} finally {
			await closeOpened()
		}
	})

	it("applies where, latest-per-group, final ordering and limit in order", async () => {
		try {
			const store = await open("latest-per-group")
			await store.insert([
				new ConformanceEntity("a1", "a", 10, 1, "old-a"),
				new ConformanceEntity("a2", "a", 10, 2, "new-a"),
				new ConformanceEntity("b1", "b", 20, 1, "old-b"),
				new ConformanceEntity("b2", "b", 20, 3, "new-b"),
				new ConformanceEntity("c1", "c", 30, 1, "excluded"),
			])
			const fields = ConformanceEntity.storage.fields
			const result = await store.query({
				where: gte(fields.sortKey, 10),
				select: latestPerGroup({ groupBy: [fields.group], orderBy: [desc(fields.revision)] }),
				orderBy: [asc(fields.sortKey)],
				limit: 2,
			})
			expect(result.records.map(({ value }) => value)).toEqual(["new-a", "new-b"])
			expect(result.stats.storedRecordCount).toBe(5)
		} finally {
			await closeOpened()
		}
	})

	it("supports typed range filters", async () => {
		try {
			const store = await open("range")
			await store.insert([
				new ConformanceEntity("a", "g", 10, 1, "a"),
				new ConformanceEntity("b", "g", 20, 1, "b"),
				new ConformanceEntity("c", "g", 30, 1, "c"),
			])
			const fields = ConformanceEntity.storage.fields
			const result = await store.query({
				where: { type: "and", predicates: [gte(fields.sortKey, 10), lt(fields.sortKey, 30)] },
			})
			expect(result.records.map(({ id }) => id)).toEqual(["a", "b"])
			expect((await store.query({ where: eq(fields.id, "b") })).records.map(({ id }) => id)).toEqual(["b"])
		} finally {
			await closeOpened()
		}
	})

	it("commits transactions atomically and rolls back throwing operations", async () => {
		try {
			const store = await open("transaction")
			await store.transaction(async (transaction) => {
				await transaction.insert([new ConformanceEntity("a", "g", 10, 1, "a")])
			})
			await expect(
				store.transaction(async (transaction) => {
					await transaction.insert([new ConformanceEntity("b", "g", 20, 1, "b")])
					throw new Error("rollback")
				}),
			).rejects.toThrow("rollback")
			expect((await store.query()).records.map(({ id }) => id)).toEqual(["a"])
		} finally {
			await closeOpened()
		}
	})

	it("shares committed state across handles and reports physical stats", async () => {
		try {
			const left = await open("shared")
			const right = await open("shared")
			await left.insert([new ConformanceEntity("a", "g", 10, 1, "a")])
			expect((await right.query()).records.map(({ id }) => id)).toEqual(["a"])
			expect(await right.stats()).toMatchObject({ storedRecordCount: 1, degraded: false })
		} finally {
			await closeOpened()
		}
	})

	it("recovers the operation queue after failure and closes idempotently", async () => {
		const store = await open("queue-close")
		await store.insert([new ConformanceEntity("a", "g", 10, 1, "a")])
		await expect(store.insert([new ConformanceEntity("a", "g", 20, 2, "duplicate")])).rejects.toThrow(/conflict/i)
		await store.insert([new ConformanceEntity("b", "g", 20, 1, "b")])
		const firstClose = store.close()
		const secondClose = store.close()
		expect(secondClose).toBe(firstClose)
		await firstClose
		opened.splice(opened.indexOf(store), 1)
		await expect(store.query()).rejects.toThrow(/closed/i)
	})
}
