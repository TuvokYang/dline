import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { column, defineEntity } from "../../api/EntitySchema"
import type { TransactionalUnifyStoreDatabase } from "../../api/UnifyStore"
import { SqliteUnifyStoreBackend } from "../../sqlite/SqliteUnifyStore"
import { ConformanceEntity } from "./unify-store-conformance"

class LedgerEntry {
    static readonly storage = defineEntity<LedgerEntry>()({
        schemaId: "unify-store-ledger-entry",
        version: 1,
        columns: {
            seq: column.integer({ primary: true }),
            note: column.text(),
        },
        defaultOrder: [{ field: "seq", direction: "asc" }],
        hydrate: (values) => new LedgerEntry(values.seq, values.note),
    })

    constructor(
        readonly seq: number,
        readonly note: string,
    ) {}
}

describe("SqliteUnifyStore database transaction", () => {
    const roots: string[] = []
    const databases: TransactionalUnifyStoreDatabase[] = []

    afterEach(async () => {
        await Promise.allSettled(databases.splice(0).map((database) => database.close()))
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
    })

    async function openDatabase(): Promise<{ database: TransactionalUnifyStoreDatabase; location: string }> {
        const root = await mkdtemp(path.join(os.tmpdir(), "dline-sqlite-db-tx-"))
        roots.push(root)
        const location = path.join(root, "journal.db")
        const database = await new SqliteUnifyStoreBackend().open(location)
        databases.push(database)
        return { database, location }
    }

    it("commits writes to several collections together", async () => {
        const { database, location } = await openDatabase()
        const entities = await database.openStore(ConformanceEntity)
        const ledger = await database.openStore(LedgerEntry)

        await database.transaction(async (transaction) => {
            await transaction.store(ConformanceEntity).insert([new ConformanceEntity("a", "g", 1, 1, "value")])
            await transaction.store(LedgerEntry).upsert([new LedgerEntry(1, "created a")])
        })

        expect((await entities.query()).records.map((record) => record.id)).toEqual(["a"])
        expect((await ledger.query()).records.map((record) => record.note)).toEqual(["created a"])

        await database.close()
        const reopened = await new SqliteUnifyStoreBackend().open(location)
        databases.push(reopened)
        expect((await (await reopened.openStore(LedgerEntry)).query()).records.map((record) => record.seq)).toEqual([1])
    })

    it("rolls back every collection when the operation fails after partial writes", async () => {
        const { database } = await openDatabase()
        const entities = await database.openStore(ConformanceEntity)
        const ledger = await database.openStore(LedgerEntry)
        await ledger.insert([new LedgerEntry(1, "existing")])

        await expect(
            database.transaction(async (transaction) => {
                await transaction.store(ConformanceEntity).insert([new ConformanceEntity("a", "g", 1, 1, "value")])
                await transaction.store(LedgerEntry).upsert([new LedgerEntry(1, "overwritten")])
                await transaction.store(LedgerEntry).insert([new LedgerEntry(1, "conflict")])
            }),
        ).rejects.toThrow("UnifyStore conflict")

        expect((await entities.query()).records).toEqual([])
        expect((await ledger.query()).records.map((record) => record.note)).toEqual(["existing"])
    })

    it("rejects collections that were not opened before the transaction and leaves the file unchanged", async () => {
        const { database } = await openDatabase()
        const entities = await database.openStore(ConformanceEntity)

        await expect(
            database.transaction(async (transaction) => {
                await transaction.store(ConformanceEntity).insert([new ConformanceEntity("a", "g", 1, 1, "value")])
                transaction.store(LedgerEntry)
            }),
        ).rejects.toThrow("must be opened before a database transaction")

        expect((await entities.query()).records).toEqual([])
        expect(await database.hasStore(LedgerEntry)).toBe(false)
    })
})
