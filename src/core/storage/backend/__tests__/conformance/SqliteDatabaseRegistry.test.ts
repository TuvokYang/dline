import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { SqliteDatabaseRegistry } from "../../sqlite/SqliteDatabaseRegistry"
import { type SqliteMigration, SqliteMigrationRegistry } from "../../sqlite/SqliteMigrationRegistry"
import { SqliteApplicationMismatchError, SqliteFutureSchemaError, SqliteMigrationError } from "../../sqlite/SqliteStoreErrors"

const APPLICATION_ID = 0x444c494e

function migrations(onVersion?: (version: number) => void): readonly SqliteMigration[] {
    return [
        {
            version: 1,
            name: "create_values",
            migrate(database) {
                onVersion?.(1)
                database.exec("CREATE TABLE values_table(value INTEGER NOT NULL)")
            },
        },
        {
            version: 2,
            name: "seed_values",
            migrate(database) {
                onVersion?.(2)
                database.prepare("INSERT INTO values_table(value) VALUES (?)").run(7)
            },
        },
    ]
}

describe("Sqlite database and migration infrastructure", () => {
    let root: string
    let registry: SqliteDatabaseRegistry

    beforeEach(async () => {
        root = await mkdtemp(path.join(os.tmpdir(), "dline-sqlite-registry-"))
        registry = new SqliteDatabaseRegistry()
    })

    afterEach(async () => {
        registry.closeAll()
        await rm(root, { recursive: true, force: true })
    })

    it("applies ordered migrations once and records their versions", async () => {
        const applied: number[] = []
        const location = path.join(root, "task.db")
        const lease = await registry.acquire(location, {
            applicationId: APPLICATION_ID,
            migrations: migrations((version) => applied.push(version)),
        })

        expect(applied).toEqual([1, 2])
        expect(lease.database.prepare("PRAGMA application_id").get()).toEqual({ application_id: APPLICATION_ID })
        expect(lease.database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 })
        expect(lease.database.prepare("SELECT value FROM values_table").get()).toEqual({ value: 7 })
        expect(lease.database.prepare("SELECT version, name FROM store_schema_migrations ORDER BY version").all()).toEqual([
            { version: 1, name: "create_values" },
            { version: 2, name: "seed_values" },
        ])
        lease.close()

        const reopened = await registry.acquire(location, {
            applicationId: APPLICATION_ID,
            migrations: migrations((version) => applied.push(version)),
        })
        expect(applied).toEqual([1, 2])
        reopened.close()
    })

    it("rejects a database created by another application", async () => {
        const location = path.join(root, "wrong-app.db")
        const lease = await registry.acquire(location, { applicationId: 123, migrations: [] })
        lease.close()

        await expect(
            registry.acquire(location, { applicationId: APPLICATION_ID, migrations: migrations() }),
        ).rejects.toBeInstanceOf(SqliteApplicationMismatchError)
    })

    it("rejects a future schema without mutating it", async () => {
        const location = path.join(root, "future.db")
        const lease = await registry.acquire(location, { applicationId: APPLICATION_ID, migrations: [] })
        lease.database.exec("PRAGMA user_version = 99")
        lease.close()

        await expect(
            registry.acquire(location, { applicationId: APPLICATION_ID, migrations: migrations() }),
        ).rejects.toBeInstanceOf(SqliteFutureSchemaError)

        const inspection = await registry.acquire(location, { applicationId: APPLICATION_ID, migrations: [] })
        expect(inspection.database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 99 })
        inspection.close()
    })

    it("rolls back a failed migration and preserves the previous version", async () => {
        const location = path.join(root, "failed.db")
        const failing: readonly SqliteMigration[] = [
            ...migrations().slice(0, 1),
            {
                version: 2,
                name: "failing_change",
                migrate(database) {
                    database.exec("CREATE TABLE should_rollback(value INTEGER)")
                    throw new Error("migration exploded")
                },
            },
        ]

        await expect(registry.acquire(location, { applicationId: APPLICATION_ID, migrations: failing })).rejects.toBeInstanceOf(
            SqliteMigrationError,
        )

        const inspection = await registry.acquire(location, {
            applicationId: APPLICATION_ID,
            migrations: migrations().slice(0, 1),
        })
        expect(inspection.database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 })
        expect(
            inspection.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'").get(),
        ).toBeUndefined()
        inspection.close()
    })

    it("reuses one connection until the final lease closes", async () => {
        const location = path.join(root, "shared.db")
        const options = { applicationId: APPLICATION_ID, migrations: migrations() }
        const first = await registry.acquire(location, options)
        const second = await registry.acquire(path.join(root, ".", "shared.db"), options)

        expect(second.database).toBe(first.database)
        expect(registry.getReferenceCount(location)).toBe(2)
        first.close()
        expect(registry.getReferenceCount(location)).toBe(1)
        expect(second.database.prepare("SELECT value FROM values_table").get()).toEqual({ value: 7 })

        second.close()
        expect(registry.getReferenceCount(location)).toBe(0)
        expect(() => second.database.prepare("SELECT 1").get()).toThrow()
    })

    it("validates migration sequences before opening the database", () => {
        expect(() => new SqliteMigrationRegistry([{ version: 2, name: "missing_one", migrate() {} }])).toThrow("contiguous")
    })
})
