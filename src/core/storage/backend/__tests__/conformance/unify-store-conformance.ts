import { expect, it } from "vitest"
import { column, defineEntity } from "../../api/EntitySchema"
import type { TransactionalUnifyStoreBackend, TransactionalUnifyStoreDatabase, UnifyStore } from "../../api/UnifyStore"
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

interface ParityMeta {
    readonly tags: string[]
    readonly note?: string
}

function isParityMeta(value: unknown): value is ParityMeta {
    return typeof value === "object" && value !== null && Array.isArray((value as { tags?: unknown }).tags)
}

/** Every column kind, a nullable unique column and a composite unique index. */
export class ParityEntity {
    static readonly storage = defineEntity<ParityEntity>()({
        schemaId: "unify-store-parity",
        version: 1,
        columns: {
            id: column.integer({ primary: true }),
            slug: column.text({ unique: true, nullable: true }),
            owner: column.text(),
            name: column.text({ indexed: true }),
            bytes: column.blob({ nullable: true }),
            meta: column.json<ParityMeta, true>({ nullable: true, validate: isParityMeta }),
            flag: column.boolean(),
            score: column.real(),
        },
        indexes: [{ name: "owner-name", fields: ["owner", "name"], unique: true }],
        defaultOrder: [{ field: "id", direction: "asc" }],
        hydrate: (values) =>
            new ParityEntity(
                values.id,
                values.slug,
                values.owner,
                values.name,
                values.bytes,
                values.meta,
                values.flag,
                values.score,
            ),
    })

    constructor(
        readonly id: number,
        readonly slug: string | null,
        readonly owner: string,
        readonly name: string,
        readonly bytes: Uint8Array | null,
        readonly meta: ParityMeta | null,
        readonly flag: boolean,
        readonly score: number,
    ) {}

    static named(id: number, owner: string, name: string, slug: string | null = null): ParityEntity {
        return new ParityEntity(id, slug, owner, name, null, null, false, 0)
    }
}

/** Never opened before a database transaction in these tests. */
class UnopenedEntity {
    static readonly storage = defineEntity<UnopenedEntity>()({
        schemaId: "unify-store-unopened",
        version: 1,
        columns: { id: column.integer({ primary: true }) },
        hydrate: (values) => new UnopenedEntity(values.id),
    })

    constructor(readonly id: number) {}
}

/** Same schema id as {@link ConformanceEntity} with different columns. */
class ChangedConformanceEntity {
    static readonly storage = defineEntity<ChangedConformanceEntity>()({
        schemaId: "unify-store-conformance",
        version: 1,
        columns: { id: column.text({ primary: true }), other: column.integer() },
        hydrate: (values) => new ChangedConformanceEntity(values.id, values.other),
    })

    constructor(
        readonly id: string,
        readonly other: number,
    ) {}
}

export interface UnifyStoreConformanceHarness {
    readonly backend: TransactionalUnifyStoreBackend
    location(testName: string): string
}

export function runUnifyStoreConformance(harness: UnifyStoreConformanceHarness): void {
    const opened: UnifyStore<ConformanceEntity>[] = []
    const databases: TransactionalUnifyStoreDatabase[] = []

    async function openDatabase(testName: string): Promise<TransactionalUnifyStoreDatabase> {
        const database = await harness.backend.open(harness.location(testName))
        databases.push(database)
        return database
    }

    async function closeDatabases(): Promise<void> {
        await Promise.allSettled(databases.splice(0).map((database) => database.close()))
    }

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

    it("round-trips bytes, JSON, booleans, reals and NULLs exactly", async () => {
        try {
            const store = await (await openDatabase("round-trip")).openStore(ParityEntity)
            const bytes = new Uint8Array([0, 1, 10, 13, 127, 128, 255])
            const meta = { tags: ["line\nbreak", "é😀", ""], note: 'quote " and \\' }
            await store.insert([
                new ParityEntity(1, "one", "o", "a", bytes, meta, true, 0.1 + 0.2),
                new ParityEntity(2, null, "o", "b", null, null, false, -1.5e-7),
            ])

            const [first, second] = (await store.query()).records
            expect(first.bytes).toBeInstanceOf(Uint8Array)
            expect(Array.from(first.bytes ?? [])).toEqual(Array.from(bytes))
            expect(first.meta).toEqual(meta)
            expect(first.flag).toBe(true)
            expect(first.score).toBe(0.1 + 0.2)
            expect(second).toEqual(new ParityEntity(2, null, "o", "b", null, null, false, -1.5e-7))
        } finally {
            await closeDatabases()
        }
    })

    it("stores a snapshot, so editing an entity after writing or reading it changes nothing", async () => {
        try {
            const store = await (await openDatabase("snapshot")).openStore(ParityEntity)
            const bytes = new Uint8Array([1, 2, 3])
            const written = new ParityEntity(1, null, "o", "a", bytes, { tags: ["kept"] }, false, 1)
            await store.insert([written])
            bytes[0] = 99
            written.meta?.tags.push("added after insert")

            const [read] = (await store.query()).records
            read.meta?.tags.push("added after read")
            read.bytes?.fill(0)

            const [again] = (await store.query()).records
            expect(again.meta).toEqual({ tags: ["kept"] })
            expect(Array.from(again.bytes ?? [])).toEqual([1, 2, 3])
        } finally {
            await closeDatabases()
        }
    })

    it("enforces unique columns and composite unique indexes like primary keys, letting NULLs repeat", async () => {
        try {
            const store = await (await openDatabase("unique")).openStore(ParityEntity)
            await store.insert([ParityEntity.named(1, "o", "a", "x")])

            await expect(store.insert([ParityEntity.named(2, "o", "b", "x")])).rejects.toThrow(/conflict/i)
            await expect(store.insert([ParityEntity.named(3, "o", "a")])).rejects.toThrow(/conflict/i)
            await expect(
                store.insert([ParityEntity.named(4, "o", "c", "y"), ParityEntity.named(5, "o", "d", "y")]),
            ).rejects.toThrow(/conflict/i)
            await store.insert([ParityEntity.named(6, "o", "e"), ParityEntity.named(7, "p", "a")])

            // Moving a row onto its own unique value is not a conflict; taking another row's is.
            await store.upsert([ParityEntity.named(1, "o", "a", "x"), ParityEntity.named(6, "o", "e", "z")])
            await expect(store.upsert([ParityEntity.named(7, "p", "a", "x")])).rejects.toThrow(/conflict/i)
            await expect(
                store.transaction(async (transaction) => {
                    await transaction.upsert([ParityEntity.named(7, "q", "a")])
                    await transaction.insert([ParityEntity.named(8, "q", "a")])
                }),
            ).rejects.toThrow(/conflict/i)

            const { records } = await store.query()
            expect(records.map((record) => [record.id, record.slug, record.owner, record.name])).toEqual([
                [1, "x", "o", "a"],
                [6, "z", "o", "e"],
                [7, null, "p", "a"],
            ])
        } finally {
            await closeDatabases()
        }
    })

    it("orders text by code point, like SQLite's BINARY collation", async () => {
        try {
            const store = await (await openDatabase("collation")).openStore(ParityEntity)
            const names = ["b", "é", "B", "😀", "ab", "\uffff", "a", "Z"]
            await store.insert(names.map((name, index) => ParityEntity.named(index + 1, "o", name)))

            const fields = ParityEntity.storage.fields
            const ascending = (await store.query({ orderBy: [asc(fields.name)] })).records.map((record) => record.name)
            expect(ascending).toEqual(["B", "Z", "a", "ab", "b", "é", "\uffff", "😀"])
            const below = (await store.query({ where: lt(fields.name, "a"), orderBy: [asc(fields.name)] })).records
            expect(below.map((record) => record.name)).toEqual(["B", "Z"])
        } finally {
            await closeDatabases()
        }
    })

    it("commits writes to several collections together and rolls all of them back on failure", async () => {
        try {
            const database = await openDatabase("database-transaction")
            const entities = await database.openStore(ConformanceEntity)
            const parity = await database.openStore(ParityEntity)
            await database.transaction(async (transaction) => {
                await transaction.store(ConformanceEntity).insert([new ConformanceEntity("a", "g", 1, 1, "value")])
                await transaction.store(ParityEntity).upsert([ParityEntity.named(1, "o", "a")])
                // A read inside the transaction sees its own writes.
                expect((await transaction.store(ConformanceEntity).query()).map(({ id }) => id)).toEqual(["a"])
            })

            await expect(
                database.transaction(async (transaction) => {
                    await transaction.store(ConformanceEntity).insert([new ConformanceEntity("b", "g", 2, 1, "value")])
                    await transaction.store(ParityEntity).upsert([ParityEntity.named(1, "o", "renamed")])
                    await transaction.store(ParityEntity).insert([ParityEntity.named(1, "o", "duplicate")])
                }),
            ).rejects.toThrow(/conflict/i)

            expect((await entities.query()).records.map(({ id }) => id)).toEqual(["a"])
            expect((await parity.query()).records.map(({ name }) => name)).toEqual(["a"])
        } finally {
            await closeDatabases()
        }
    })

    it("rejects a collection that was not opened before a database transaction and writes nothing", async () => {
        try {
            const database = await openDatabase("unopened")
            const entities = await database.openStore(ConformanceEntity)
            await expect(
                database.transaction(async (transaction) => {
                    await transaction.store(ConformanceEntity).insert([new ConformanceEntity("a", "g", 1, 1, "value")])
                    transaction.store(UnopenedEntity)
                }),
            ).rejects.toThrow("must be opened before a database transaction")

            expect((await entities.query()).records).toEqual([])
            expect(await database.hasStore(UnopenedEntity)).toBe(false)
        } finally {
            await closeDatabases()
        }
    })

    it("lists every collection with the schema that created it", async () => {
        try {
            const database = await openDatabase("collections")
            expect(await database.collections()).toEqual([])
            await database.openStore(ParityEntity)
            await database.openStore(ConformanceEntity)

            expect(await database.collections()).toEqual(
                [ConformanceEntity.storage, ParityEntity.storage].map(({ schemaId, version, fingerprint }) => ({
                    schemaId,
                    version,
                    fingerprint,
                })),
            )
        } finally {
            await closeDatabases()
        }
    })

    it("refuses to open a stored collection with a changed schema", async () => {
        try {
            const database = await openDatabase("schema-conflict")
            await (await database.openStore(ConformanceEntity)).insert([new ConformanceEntity("a", "g", 1, 1, "value")])

            await expect(database.openStore(ChangedConformanceEntity)).rejects.toThrow("Entity schema conflict")
            await expect(database.hasStore(ChangedConformanceEntity)).rejects.toThrow("Entity schema conflict")
        } finally {
            await closeDatabases()
        }
    })

    it("keeps committed rows of every collection after the database is closed and reopened", async () => {
        try {
            const first = await openDatabase("reopen")
            await (await first.openStore(ConformanceEntity)).insert([new ConformanceEntity("a", "g", 1, 1, "value")])
            await (await first.openStore(ParityEntity)).upsert([
                new ParityEntity(1, "s", "o", "a", new Uint8Array([7]), { tags: ["t"] }, true, 2.5),
            ])
            await first.close()

            const reopened = await openDatabase("reopen")
            expect((await (await reopened.openStore(ConformanceEntity)).query()).records).toEqual([
                new ConformanceEntity("a", "g", 1, 1, "value"),
            ])
            const [row] = (await (await reopened.openStore(ParityEntity)).query()).records
            expect({ ...row, bytes: Array.from(row.bytes ?? []) }).toEqual({
                ...new ParityEntity(1, "s", "o", "a", null, { tags: ["t"] }, true, 2.5),
                bytes: [7],
            })
        } finally {
            await closeDatabases()
        }
    })
}
