import type { EntityFieldOrder, EntityFieldRef, EntitySchema, EntityValues } from "../api/EntitySchema"
import type { LatestPerGroup, UnifyStorePredicate, UnifyStoreQuery } from "../api/UnifyStoreQuery"

export interface NormalizedUnifyStoreQuery<TEntity extends object> {
    readonly where?: UnifyStorePredicate<TEntity>
    readonly select?: LatestPerGroup<TEntity>
    readonly orderBy: readonly EntityFieldOrder<TEntity>[]
    readonly limit?: number
}

interface EvaluatedEntity<TItem, TEntity extends object> {
    readonly entity: TItem
    readonly values: EntityValues<TEntity>
}

export function normalizeUnifyStoreQuery<TEntity extends object>(
    schema: EntitySchema<TEntity>,
    query: UnifyStoreQuery<TEntity> = {},
): NormalizedUnifyStoreQuery<TEntity> {
    if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 0)) {
        throw new Error("UnifyStore query limit must be a non-negative integer")
    }
    if (query.where) validatePredicate(schema, query.where)
    const orderBy = normalizeOrder(schema, query.orderBy, schema.defaultOrder)
    const select = query.select ? normalizeLatestPerGroup(schema, query.select) : undefined
    return { where: query.where, select, orderBy, ...(query.limit === undefined ? {} : { limit: query.limit }) }
}

export function evaluateUnifyStoreQuery<TEntity extends object>(
    schema: EntitySchema<TEntity>,
    entities: readonly TEntity[],
    query: NormalizedUnifyStoreQuery<TEntity>,
): TEntity[] {
    const evaluated = entities.map((entity) => ({ entity, values: schema.dehydrate(entity) }))
    return selectEvaluated(evaluated, query).map(({ entity }) => entity)
}

/** Evaluates `query` over already validated stored values and returns the selected values in result order. */
export function evaluateUnifyStoreValues<TEntity extends object>(
    values: readonly EntityValues<TEntity>[],
    query: NormalizedUnifyStoreQuery<TEntity>,
): EntityValues<TEntity>[] {
    return selectEvaluated(
        values.map((entry) => ({ entity: entry, values: entry })),
        query,
    ).map(({ values: selected }) => selected)
}

function selectEvaluated<TItem, TEntity extends object>(
    evaluated: EvaluatedEntity<TItem, TEntity>[],
    query: NormalizedUnifyStoreQuery<TEntity>,
): EvaluatedEntity<TItem, TEntity>[] {
    let selected = evaluated
    if (query.where) selected = selected.filter(({ values }) => evaluatePredicate(query.where!, values))
    if (query.select) selected = selectLatestPerGroup(selected, query.select)
    selected.sort((left, right) => compareByOrder(left.values, right.values, query.orderBy))
    if (query.limit !== undefined) selected = selected.slice(0, query.limit)
    return selected
}

export function compareEntityValues<TEntity extends object>(
    left: EntityValues<TEntity>,
    right: EntityValues<TEntity>,
    orderBy: readonly EntityFieldOrder<TEntity>[],
): number {
    return compareByOrder(left, right, orderBy)
}

function normalizeOrder<TEntity extends object>(
    schema: EntitySchema<TEntity>,
    requested: readonly EntityFieldOrder<TEntity>[] | undefined,
    fallback: readonly EntityFieldOrder<TEntity>[],
): readonly EntityFieldOrder<TEntity>[] {
    if (requested && requested.length === 0) throw new Error("UnifyStore orderBy must contain fields")
    const order = requested ?? fallback
    for (const item of order) validateField(schema, item.field)
    return [...order]
}

function normalizeLatestPerGroup<TEntity extends object>(
    schema: EntitySchema<TEntity>,
    selection: LatestPerGroup<TEntity>,
): LatestPerGroup<TEntity> {
    if (selection.groupBy.length === 0) throw new Error("latest-per-group requires at least one grouping field")
    if (selection.orderBy.length === 0) throw new Error("latest-per-group requires at least one ordering field")
    for (const field of selection.groupBy) validateField(schema, field)
    for (const order of selection.orderBy) validateField(schema, order.field)
    const covered = new Set([
        ...selection.groupBy.map((field) => field.name),
        ...selection.orderBy.map((order) => order.field.name),
    ])
    const tieBreakers = schema.primaryFields
        .filter((field) => !covered.has(field.name))
        .map((field) => ({ field, direction: "asc" as const }))
    return {
        type: "latest-per-group",
        groupBy: [...selection.groupBy],
        orderBy: [...selection.orderBy, ...tieBreakers],
    }
}

function validatePredicate<TEntity extends object>(schema: EntitySchema<TEntity>, predicate: UnifyStorePredicate<TEntity>): void {
    if (predicate.type === "and") {
        for (const child of predicate.predicates) validatePredicate(schema, child)
        return
    }
    validateField(schema, predicate.field)
    const column = schema.columns[predicate.field.name]
    if (!column.validate(predicate.value)) {
        throw new Error(`Invalid query value for ${schema.schemaId}.${predicate.field.name}`)
    }
}

function validateField<TEntity extends object>(schema: EntitySchema<TEntity>, field: EntityFieldRef<TEntity, unknown>): void {
    if (field.schemaId !== schema.schemaId || !schema.columnEntries.some((entry) => entry.name === field.name)) {
        throw new Error(`UnifyStore query field ${field.schemaId}.${field.name} does not belong to ${schema.schemaId}`)
    }
}

/** Whether stored `values` satisfy `predicate`, with the same semantics a query filter applies. */
export function matchesUnifyStorePredicate<TEntity extends object>(
    values: EntityValues<TEntity>,
    predicate: UnifyStorePredicate<TEntity>,
): boolean {
    return evaluatePredicate(predicate, values)
}

function evaluatePredicate<TEntity extends object>(
    predicate: UnifyStorePredicate<TEntity>,
    values: EntityValues<TEntity>,
): boolean {
    if (predicate.type === "and") return predicate.predicates.every((child) => evaluatePredicate(child, values))
    const left = values[predicate.field.name]
    if (predicate.operator === "eq") return valuesEqual(left, predicate.value)
    const comparison = compareValues(left, predicate.value)
    return predicate.operator === "gte" ? comparison >= 0 : comparison < 0
}

function selectLatestPerGroup<TItem, TEntity extends object>(
    entities: readonly EvaluatedEntity<TItem, TEntity>[],
    selection: LatestPerGroup<TEntity>,
): EvaluatedEntity<TItem, TEntity>[] {
    const selected = new Map<string, EvaluatedEntity<TItem, TEntity>>()
    for (const candidate of entities) {
        const key = selection.groupBy.map((field) => serializeKeyPart(candidate.values[field.name])).join("|")
        const current = selected.get(key)
        if (!current || compareByOrder(candidate.values, current.values, selection.orderBy) < 0) selected.set(key, candidate)
    }
    return [...selected.values()]
}

function compareByOrder<TEntity extends object>(
    left: EntityValues<TEntity>,
    right: EntityValues<TEntity>,
    orderBy: readonly EntityFieldOrder<TEntity>[],
): number {
    for (const order of orderBy) {
        const comparison = compareValues(left[order.field.name], right[order.field.name])
        if (comparison !== 0) return order.direction === "asc" ? comparison : -comparison
    }
    return 0
}

function compareValues(left: unknown, right: unknown): number {
    if (left === right) return 0
    if (left === null || left === undefined) return -1
    if (right === null || right === undefined) return 1
    if (typeof left === "number" && typeof right === "number") return left - right
    if (typeof left === "bigint" && typeof right === "bigint") return left < right ? -1 : 1
    if (typeof left === "string" && typeof right === "string") return compareCodePoints(left, right)
    if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right)
    if (left instanceof Uint8Array && right instanceof Uint8Array) return Buffer.compare(left, right)
    return compareCodePoints(JSON.stringify(left), JSON.stringify(right))
}

/**
 * Orders strings by Unicode code point, which is the order of their UTF-8 bytes and
 * therefore SQLite's BINARY collation. `localeCompare` would make the in-memory
 * backends sort text differently from SQLite. UTF-16 code unit order only differs
 * from code point order where a surrogate meets a unit at or above U+E000.
 */
export function compareCodePoints(left: string, right: string): number {
    const length = Math.min(left.length, right.length)
    for (let index = 0; index < length; index++) {
        const leftUnit = left.charCodeAt(index)
        const rightUnit = right.charCodeAt(index)
        if (leftUnit !== rightUnit) return codePointRank(leftUnit) - codePointRank(rightUnit)
    }
    return left.length - right.length
}

function codePointRank(unit: number): number {
    if (unit >= 0xd800 && unit <= 0xdfff) return unit + 0x2000
    if (unit >= 0xe000) return unit - 0x800
    return unit
}

function valuesEqual(left: unknown, right: unknown): boolean {
    if (left === right) return true
    if (left instanceof Uint8Array && right instanceof Uint8Array) return Buffer.compare(left, right) === 0
    if (typeof left === "object" && left !== null && typeof right === "object" && right !== null) {
        return JSON.stringify(left) === JSON.stringify(right)
    }
    return false
}

function serializeKeyPart(value: unknown): string {
    if (typeof value === "bigint") return `bigint:${value}`
    if (value instanceof Uint8Array) return `blob:${Buffer.from(value).toString("base64")}`
    return `${typeof value}:${JSON.stringify(value)}`
}
