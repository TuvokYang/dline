import type { SQLInputValue } from "node:sqlite"
import type { EntityFieldOrder, EntitySchema } from "../api/EntitySchema"
import type { UnifyStorePredicate } from "../api/UnifyStoreQuery"
import type { NormalizedUnifyStoreQuery } from "../core/UnifyStoreQueryEvaluator"
import { encodeSqliteValue, physicalTableName, quoteIdentifier } from "./SqliteSchemaCompiler"

export interface CompiledSqliteQuery {
    readonly sql: string
    readonly bindings: readonly SQLInputValue[]
}

export function compileSqliteQuery<TEntity extends object>(
    schema: EntitySchema<TEntity>,
    query: NormalizedUnifyStoreQuery<TEntity>,
): CompiledSqliteQuery {
    const bindings: SQLInputValue[] = []
    const columns = schema.columnEntries.map(({ name }) => quoteIdentifier(name)).join(", ")
    const table = quoteIdentifier(physicalTableName(schema.schemaId))
    const where = query.where ? compilePredicate(schema, query.where, bindings) : undefined
    let sql: string

    if (query.select) {
        const rankAlias = createRankAlias(schema)
        const partition = query.select.groupBy.map((field) => quoteField(schema, field.schemaId, field.name)).join(", ")
        const selectionOrder = compileOrder(schema, query.select.orderBy)
        sql = `WITH ${quoteIdentifier("unify_ranked")} AS (SELECT ${columns}, ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY ${selectionOrder}) AS ${quoteIdentifier(rankAlias)} FROM ${table}${where ? ` WHERE ${where}` : ""}) SELECT ${columns} FROM ${quoteIdentifier("unify_ranked")} WHERE ${quoteIdentifier(rankAlias)} = 1`
    } else {
        sql = `SELECT ${columns} FROM ${table}${where ? ` WHERE ${where}` : ""}`
    }

    sql += ` ORDER BY ${compileOrder(schema, query.orderBy)}`
    if (query.limit !== undefined) {
        sql += " LIMIT ?"
        bindings.push(query.limit)
    }
    return { sql, bindings }
}

function compilePredicate<TEntity extends object>(
    schema: EntitySchema<TEntity>,
    predicate: UnifyStorePredicate<TEntity>,
    bindings: SQLInputValue[],
): string {
    if (predicate.type === "and") {
        if (predicate.predicates.length === 0) return "1 = 1"
        return `(${predicate.predicates.map((child) => compilePredicate(schema, child, bindings)).join(" AND ")})`
    }

    const field = quoteField(schema, predicate.field.schemaId, predicate.field.name)
    if (predicate.value === null) {
        if (predicate.operator === "eq") return `${field} IS NULL`
        return predicate.operator === "gte" ? "1 = 1" : "0 = 1"
    }

    bindings.push(encodeSqliteValue(predicate.field.kind, predicate.value))
    if (predicate.operator === "eq") return `${field} = ?`
    if (predicate.operator === "gte") return `${field} >= ?`
    return predicate.field.nullable ? `(${field} IS NULL OR ${field} < ?)` : `${field} < ?`
}

function compileOrder<TEntity extends object>(
    schema: EntitySchema<TEntity>,
    orderBy: readonly EntityFieldOrder<TEntity>[],
): string {
    return orderBy
        .map((order) => `${quoteField(schema, order.field.schemaId, order.field.name)} ${order.direction.toUpperCase()}`)
        .join(", ")
}

function quoteField<TEntity extends object>(schema: EntitySchema<TEntity>, schemaId: string, name: string): string {
    if (schemaId !== schema.schemaId || !schema.columnEntries.some((entry) => entry.name === name)) {
        throw new Error(`Field ${schemaId}.${name} does not belong to schema ${schema.schemaId}`)
    }
    return quoteIdentifier(name)
}

function createRankAlias<TEntity extends object>(schema: EntitySchema<TEntity>): string {
    const names = new Set(schema.columnEntries.map(({ name }) => name))
    let alias = "__unify_rank"
    while (names.has(alias as never)) alias = `_${alias}`
    return alias
}
