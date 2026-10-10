import type { DatabaseSync } from "node:sqlite"
import { SqliteFutureSchemaError, SqliteMigrationError } from "./SqliteStoreErrors"

export interface SqliteMigration {
    version: number
    name: string
    migrate(database: DatabaseSync): void
}

interface UserVersionRow {
    user_version: number
}

export class SqliteMigrationRegistry {
    readonly migrations: readonly SqliteMigration[]
    readonly latestVersion: number | undefined

    constructor(migrations: readonly SqliteMigration[]) {
        this.migrations = [...migrations]
        for (let index = 0; index < this.migrations.length; index++) {
            const migration = this.migrations[index]
            const expectedVersion = index + 1
            if (migration.version !== expectedVersion) {
                throw new Error(
                    `SQLite migration versions must be contiguous from 1; expected ${expectedVersion}, found ${migration.version}`,
                )
            }
            if (!migration.name.trim()) throw new Error(`SQLite migration ${migration.version} must have a name`)
        }
        this.latestVersion = this.migrations.at(-1)?.version
    }

    apply(database: DatabaseSync): void {
        database.exec(`
			CREATE TABLE IF NOT EXISTS store_schema_migrations (
				version INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				applied_at_ms INTEGER NOT NULL
			)
		`)
        const currentVersion = this.readUserVersion(database)
        if (this.latestVersion === undefined) return
        if (currentVersion > this.latestVersion) throw new SqliteFutureSchemaError(this.latestVersion, currentVersion)

        for (const migration of this.migrations) {
            if (migration.version <= currentVersion) continue
            database.exec("BEGIN IMMEDIATE")
            try {
                migration.migrate(database)
                database
                    .prepare("INSERT INTO store_schema_migrations(version, name, applied_at_ms) VALUES (?, ?, ?)")
                    .run(migration.version, migration.name, Date.now())
                database.exec(`PRAGMA user_version = ${migration.version}`)
                database.exec("COMMIT")
            } catch (error) {
                try {
                    database.exec("ROLLBACK")
                } catch {
                    // Preserve the migration error.
                }
                throw new SqliteMigrationError(migration.version, migration.name, { cause: error })
            }
        }
    }

    private readUserVersion(database: DatabaseSync): number {
        const row = database.prepare("PRAGMA user_version").get() as unknown as UserVersionRow
        return row.user_version
    }
}
