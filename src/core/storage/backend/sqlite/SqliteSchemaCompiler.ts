import type { SQLInputValue } from "node:sqlite"
import type { EntityFieldKind, EntitySchema } from "../api/EntitySchema"

export interface CompiledEntitySchema {
    readonly tableName: string
    readonly createTableSql: string
    readonly createIndexSql: readonly string[]
}

export function compileEntitySchema<TEntity extends object>(schema: EntitySchema<TEntity>): CompiledEntitySchema {
    const tableName = physicalTableName(schema.schemaId)
    const columnDefinitions = schema.columnEntries.map(({ name, column }) => {
        const parts = [quoteIdentifier(name), sqliteAffinity(column.kind)]
        if (!column.nullable) parts.push("NOT NULL")
        if (column.unique && !column.primary) parts.push("UNIQUE")
        return parts.join(" ")
    })
    columnDefinitions.push(`PRIMARY KEY (${schema.primaryFields.map((field) => quoteIdentifier(field.name)).join(", ")})`)

    const createIndexSql: string[] = []
    for (const { name, column } of schema.columnEntries) {
        if (!column.indexed || column.primary) continue
        createIndexSql.push(
            `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(physicalIndexName(schema.schemaId, `field-${name}`))} ON ${quoteIdentifier(tableName)} (${quoteIdentifier(name)})`,
        )
    }
    for (const index of schema.indexes) {
        createIndexSql.push(
            `CREATE ${index.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${quoteIdentifier(physicalIndexName(schema.schemaId, index.name))} ON ${quoteIdentifier(tableName)} (${index.fields.map(quoteIdentifier).join(", ")})`,
        )
    }

    return {
        tableName,
        createTableSql: `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (${columnDefinitions.join(", ")})`,
        createIndexSql,
    }
}

export function quoteIdentifier(identifier: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(identifier)) throw new Error(`Unsafe SQLite identifier: ${identifier}`)
    return `"${identifier}"`
}

export function physicalTableName(schemaId: string): string {
    return physicalName("entity", schemaId)
}

export function encodeSqliteValue(kind: EntityFieldKind, value: unknown): SQLInputValue {
    if (value === null) return null
    if (kind === "boolean") return value ? 1 : 0
    if (kind === "json") return JSON.stringify(value)
    if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value
    if (value instanceof Uint8Array) return value
    throw new Error(`Unsupported SQLite value for ${kind}`)
}

export function decodeSqliteValue(kind: EntityFieldKind, value: unknown): unknown {
    if (value === null) return null
    if (kind === "boolean") return value === 1
    if (kind === "json") {
        if (typeof value !== "string") throw new Error("Invalid SQLite JSON value")
        return JSON.parse(value) as unknown
    }
    if (kind === "blob" && value instanceof Uint8Array) return new Uint8Array(value)
    return value
}

function physicalIndexName(schemaId: string, indexName: string): string {
    return physicalName("index", `${schemaId}.${indexName}`)
}

function physicalName(prefix: string, logicalName: string): string {
    const normalized = logicalName.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 72)
    return `${prefix}_${normalized}_${fnv1a(logicalName)}`
}

function fnv1a(value: string): string {
    let hash = 0x811c9dc5
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(16).padStart(8, "0")
}

function sqliteAffinity(kind: EntityFieldKind): string {
    if (kind === "integer" || kind === "boolean") return "INTEGER"
    if (kind === "real") return "REAL"
    if (kind === "blob") return "BLOB"
    return "TEXT"
}
