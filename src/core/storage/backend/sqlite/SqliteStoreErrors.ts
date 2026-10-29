export class SqliteStoreError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options)
        this.name = new.target.name
    }
}

export class SqliteApplicationMismatchError extends SqliteStoreError {
    constructor(expected: number, actual: number) {
        super(`SQLite application_id mismatch: expected ${expected}, found ${actual}`)
    }
}

export class SqliteFutureSchemaError extends SqliteStoreError {
    constructor(supported: number, actual: number) {
        super(`SQLite schema version ${actual} is newer than supported version ${supported}`)
    }
}

export class SqliteMigrationError extends SqliteStoreError {
    constructor(version: number, name: string, options?: ErrorOptions) {
        super(`SQLite migration ${version} (${name}) failed`, options)
    }
}
