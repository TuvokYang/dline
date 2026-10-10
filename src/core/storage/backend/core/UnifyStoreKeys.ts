import type { EntityDataKey, EntitySchema, EntityValues } from "../api/EntitySchema"

/** One unique column or unique index of a schema. */
export interface UniqueConstraint<TEntity extends object> {
    readonly fields: readonly EntityDataKey<TEntity>[]
}

/** Identity of one key component; keeps apart values that JSON alone would conflate, such as `1` and `"1"`. */
export function serializeKeyPart(value: unknown): string {
    if (typeof value === "bigint") return `bigint:${value}`
    if (value instanceof Uint8Array) return `blob:${Buffer.from(value).toString("base64")}`
    return `${typeof value}:${JSON.stringify(value)}`
}

export function primaryKeyOf<TEntity extends object>(schema: EntitySchema<TEntity>, values: EntityValues<TEntity>): string {
    return schema.primaryFields.map((field) => serializeKeyPart(values[field.name])).join("|")
}

/** Every unique column and unique index of `schema`, which SQLite enforces on each write. */
export function uniqueConstraintsOf<TEntity extends object>(schema: EntitySchema<TEntity>): UniqueConstraint<TEntity>[] {
    const constraints: UniqueConstraint<TEntity>[] = []
    for (const { name, column } of schema.columnEntries) {
        if (column.unique && !column.primary) constraints.push({ fields: [name] })
    }
    for (const index of schema.indexes) {
        if (index.unique) constraints.push({ fields: [...index.fields] })
    }
    return constraints
}

/** Key of `values` under `constraint`, or `undefined` when a field is NULL: SQLite never lets NULLs collide. */
export function uniqueKeyOf<TEntity extends object>(
    values: EntityValues<TEntity>,
    constraint: UniqueConstraint<TEntity>,
): string | undefined {
    const parts: string[] = []
    for (const field of constraint.fields) {
        const value = values[field]
        if (value === null) return undefined
        parts.push(serializeKeyPart(value))
    }
    return parts.join("|")
}

/** Whether two stored rows of `schema` hold the same value in every column. */
export function rowValuesEqual<TEntity extends object>(
    schema: EntitySchema<TEntity>,
    left: EntityValues<TEntity>,
    right: EntityValues<TEntity>,
): boolean {
    return schema.columnEntries.every(({ name }) => storedValueEqual(left[name], right[name]))
}

function storedValueEqual(left: unknown, right: unknown): boolean {
    if (left === right) return true
    if (left instanceof Uint8Array || right instanceof Uint8Array) {
        return left instanceof Uint8Array && right instanceof Uint8Array && Buffer.compare(left, right) === 0
    }
    if (typeof left === "object" && left !== null && typeof right === "object" && right !== null) {
        return JSON.stringify(left) === JSON.stringify(right)
    }
    return false
}
