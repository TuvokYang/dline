import { afterEach, describe, expect, it } from "vitest"
import { getSqliteRuntimeInfo, openSqliteDatabase, type SqliteDatabaseHandle } from "../../sqlite/SqliteRuntime"

describe("SqliteRuntime", () => {
    let handle: SqliteDatabaseHandle | undefined

    afterEach(() => {
        handle?.close()
        handle = undefined
    })

    it("opens node:sqlite with the approved runtime metadata", () => {
        handle = openSqliteDatabase(":memory:")
        const info = getSqliteRuntimeInfo()

        expect(Number.parseInt(info.nodeVersion.split(".")[0] ?? "0", 10)).toBeGreaterThanOrEqual(24)
        expect(info.moduleAbi).toBe(process.versions.modules)
        expect(handle.database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 })
        expect(handle.database.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 })
    })

    it("commits a successful immediate transaction", () => {
        handle = openSqliteDatabase(":memory:")
        handle.database.exec("CREATE TABLE values_table(value INTEGER NOT NULL)")

        handle.transaction(() => {
            handle?.database.prepare("INSERT INTO values_table(value) VALUES (?)").run(7)
        })

        expect(handle.database.prepare("SELECT value FROM values_table").get()).toEqual({ value: 7 })
    })

    it("rolls back a failed immediate transaction and remains usable", () => {
        handle = openSqliteDatabase(":memory:")
        handle.database.exec("CREATE TABLE values_table(value INTEGER NOT NULL)")

        expect(() =>
            handle?.transaction(() => {
                handle?.database.prepare("INSERT INTO values_table(value) VALUES (?)").run(11)
                throw new Error("expected failure")
            }),
        ).toThrow("expected failure")
        expect(handle.database.prepare("SELECT COUNT(*) AS count FROM values_table").get()).toEqual({ count: 0 })

        handle.transaction(() => {
            handle?.database.prepare("INSERT INTO values_table(value) VALUES (?)").run(13)
        })
        expect(handle.database.prepare("SELECT value FROM values_table").get()).toEqual({ value: 13 })
    })

    it("closes idempotently and rejects later transactions", () => {
        handle = openSqliteDatabase(":memory:")
        handle.close()
        handle.close()

        expect(() => handle?.transaction(() => undefined)).toThrow("SQLite database handle is closed")
    })
})
