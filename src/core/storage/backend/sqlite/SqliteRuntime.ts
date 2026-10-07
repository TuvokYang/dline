import { DatabaseSync } from "node:sqlite"

export interface SqliteRuntimeInfo {
	nodeVersion: string
	moduleAbi: string
	electronVersion?: string
}

export class SqliteRuntimeUnavailableError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = "SqliteRuntimeUnavailableError"
	}
}

export interface OpenSqliteDatabaseOptions {
	readonly: boolean
}

export class SqliteDatabaseHandle {
	private closed = false

	constructor(readonly database: DatabaseSync) {}

	transaction<T>(operation: () => T): T {
		this.ensureOpen()
		this.database.exec("BEGIN IMMEDIATE")
		try {
			const result = operation()
			this.database.exec("COMMIT")
			return result
		} catch (error) {
			try {
				this.database.exec("ROLLBACK")
			} catch {
				// Preserve the original operation error.
			}
			throw error
		}
	}

	close(): void {
		if (this.closed) return
		this.database.close()
		this.closed = true
	}

	private ensureOpen(): void {
		if (this.closed) throw new Error("SQLite database handle is closed")
	}
}

export function getSqliteRuntimeInfo(): SqliteRuntimeInfo {
	return {
		nodeVersion: process.versions.node,
		moduleAbi: process.versions.modules,
		...(process.versions.electron ? { electronVersion: process.versions.electron } : {}),
	}
}

export function openSqliteDatabase(
	location: string,
	options: OpenSqliteDatabaseOptions = { readonly: false },
): SqliteDatabaseHandle {
	let database: DatabaseSync | undefined
	try {
		database = new DatabaseSync(location, {
			readOnly: options.readonly,
		})
		database.exec("PRAGMA foreign_keys = ON")
		if (!options.readonly) {
			database.exec("PRAGMA journal_mode = WAL")
			database.exec("PRAGMA synchronous = NORMAL")
		}
		database.exec("PRAGMA busy_timeout = 5000")
		return new SqliteDatabaseHandle(database)
	} catch (error) {
		database?.close()
		throw new SqliteRuntimeUnavailableError(
			`Unable to open SQLite database with node:sqlite on Node ${process.versions.node}`,
			{ cause: error },
		)
	}
}
