import type { EntityFieldOrder, EntityFieldRef } from "./EntitySchema"

export type UnifyStoreComparisonOperator = "eq" | "gte" | "lt"

export interface UnifyStoreComparison<TEntity extends object> {
    readonly type: "comparison"
    readonly operator: UnifyStoreComparisonOperator
    readonly field: EntityFieldRef<TEntity, unknown>
    readonly value: unknown
}

export interface UnifyStoreAnd<TEntity extends object> {
    readonly type: "and"
    readonly predicates: readonly UnifyStorePredicate<TEntity>[]
}

export type UnifyStorePredicate<TEntity extends object> = UnifyStoreComparison<TEntity> | UnifyStoreAnd<TEntity>

export type UnifyStoreOrder<TEntity extends object> = EntityFieldOrder<TEntity>

export interface LatestPerGroup<TEntity extends object> {
    readonly type: "latest-per-group"
    readonly groupBy: readonly EntityFieldRef<TEntity, unknown>[]
    readonly orderBy: readonly UnifyStoreOrder<TEntity>[]
}

export type UnifyStoreSelection<TEntity extends object> = LatestPerGroup<TEntity>

export interface UnifyStoreQuery<TEntity extends object> {
    readonly where?: UnifyStorePredicate<TEntity>
    readonly select?: UnifyStoreSelection<TEntity>
    readonly orderBy?: readonly UnifyStoreOrder<TEntity>[]
    readonly limit?: number
}

export function eq<TEntity extends object, TValue>(
    field: EntityFieldRef<TEntity, TValue>,
    value: NoInfer<TValue>,
): UnifyStoreComparison<TEntity> {
    return { type: "comparison", operator: "eq", field, value }
}

export function gte<TEntity extends object, TValue>(
    field: EntityFieldRef<TEntity, TValue>,
    value: NoInfer<TValue>,
): UnifyStoreComparison<TEntity> {
    return { type: "comparison", operator: "gte", field, value }
}

export function lt<TEntity extends object, TValue>(
    field: EntityFieldRef<TEntity, TValue>,
    value: NoInfer<TValue>,
): UnifyStoreComparison<TEntity> {
    return { type: "comparison", operator: "lt", field, value }
}

export function and<TEntity extends object>(...predicates: readonly UnifyStorePredicate<TEntity>[]): UnifyStoreAnd<TEntity> {
    return { type: "and", predicates }
}

export function asc<TEntity extends object>(field: EntityFieldRef<TEntity, unknown>): UnifyStoreOrder<TEntity> {
    return { field, direction: "asc" }
}

export function desc<TEntity extends object>(field: EntityFieldRef<TEntity, unknown>): UnifyStoreOrder<TEntity> {
    return { field, direction: "desc" }
}

export function latestPerGroup<TEntity extends object>(options: {
    groupBy: readonly EntityFieldRef<TEntity, unknown>[]
    orderBy: readonly UnifyStoreOrder<TEntity>[]
}): LatestPerGroup<TEntity> {
    if (options.groupBy.length === 0) throw new Error("latest-per-group requires at least one grouping field")
    if (options.orderBy.length === 0) throw new Error("latest-per-group requires at least one ordering field")
    const schemaId = options.groupBy[0].schemaId
    const fieldNames = new Set<string>()
    for (const field of options.groupBy) {
        assertSchema(schemaId, field)
        if (fieldNames.has(field.name)) throw new Error(`latest-per-group contains duplicate grouping field ${field.name}`)
        fieldNames.add(field.name)
    }
    for (const order of options.orderBy) assertSchema(schemaId, order.field)
    return {
        type: "latest-per-group",
        groupBy: [...options.groupBy],
        orderBy: [...options.orderBy],
    }
}

function assertSchema<TEntity extends object>(schemaId: string, field: EntityFieldRef<TEntity, unknown>): void {
    if (field.schemaId !== schemaId) {
        throw new Error(`UnifyStore query cannot combine ${schemaId} with ${field.schemaId}`)
    }
}
