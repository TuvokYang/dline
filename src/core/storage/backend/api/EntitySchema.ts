export type EntityFieldKind = "integer" | "real" | "text" | "boolean" | "blob" | "json"

export type EntityFieldValue = string | number | bigint | boolean | Uint8Array | object | null

export type EntityDataKey<TEntity extends object> = Extract<
    {
        [K in keyof TEntity]-?: TEntity[K] extends (...args: never[]) => unknown ? never : K
    }[keyof TEntity],
    string
>

export interface EntityColumnOptions {
    primary?: boolean
    nullable?: boolean
    indexed?: boolean
    unique?: boolean
}

export interface EntityColumn<TValue> {
    readonly kind: EntityFieldKind
    readonly primary: boolean
    readonly nullable: boolean
    readonly indexed: boolean
    readonly unique: boolean
    readonly validate: (value: unknown) => value is TValue
}

export interface EntityFieldRef<TEntity extends object, TValue> {
    readonly schemaId: string
    readonly name: EntityDataKey<TEntity>
    readonly kind: EntityFieldKind
    readonly nullable: boolean
    readonly __value?: TValue
}

export interface EntityFieldOrder<TEntity extends object> {
    readonly field: EntityFieldRef<TEntity, unknown>
    readonly direction: "asc" | "desc"
}

export interface EntityOrderDefinition<TEntity extends object> {
    readonly field: EntityDataKey<TEntity>
    readonly direction: "asc" | "desc"
}

export type EntityColumns<TEntity extends object> = {
    [K in EntityDataKey<TEntity>]-?: EntityColumn<TEntity[K]>
}

export type EntityFields<TEntity extends object> = {
    [K in EntityDataKey<TEntity>]-?: EntityFieldRef<TEntity, TEntity[K]>
}

export type EntityValues<TEntity extends object> = {
    [K in EntityDataKey<TEntity>]-?: TEntity[K]
}

export interface EntityIndex<TEntity extends object> {
    readonly name: string
    readonly fields: readonly EntityDataKey<TEntity>[]
    readonly unique?: boolean
}

export interface EntitySchemaDefinition<TEntity extends object> {
    readonly schemaId: string
    readonly version: number
    readonly columns: EntityColumns<TEntity>
    readonly indexes?: readonly EntityIndex<TEntity>[]
    readonly defaultOrder?: readonly EntityOrderDefinition<TEntity>[]
    readonly hydrate: (values: EntityValues<TEntity>) => TEntity
}

export interface EntityColumnEntry<TEntity extends object> {
    readonly name: EntityDataKey<TEntity>
    readonly column: EntityColumn<TEntity[EntityDataKey<TEntity>]>
    readonly field: EntityFieldRef<TEntity, TEntity[EntityDataKey<TEntity>]>
}

export interface EntitySchema<TEntity extends object> {
    readonly schemaId: string
    readonly version: number
    readonly columns: EntityColumns<TEntity>
    readonly fields: EntityFields<TEntity>
    readonly indexes: readonly EntityIndex<TEntity>[]
    readonly primaryFields: readonly EntityFieldRef<TEntity, unknown>[]
    readonly defaultOrder: readonly EntityFieldOrder<TEntity>[]
    readonly columnEntries: readonly EntityColumnEntry<TEntity>[]
    readonly fingerprint: string
    dehydrate(entity: TEntity): EntityValues<TEntity>
    hydrate(values: EntityValues<TEntity>): TEntity
}

export interface StoredEntityClass<TEntity extends object> {
    readonly storage: EntitySchema<TEntity>
    new (...args: never[]): TEntity
}

type NullableColumnValue<TValue, TNullable extends boolean> = TNullable extends true ? TValue | null : TValue

type TypedColumnOptions<TNullable extends boolean> = Omit<EntityColumnOptions, "nullable"> & {
    readonly nullable?: TNullable
}

function createColumn<TValue, TNullable extends boolean = false>(
    kind: EntityFieldKind,
    options: TypedColumnOptions<TNullable> | undefined,
    validate: (value: unknown) => value is TValue,
): EntityColumn<NullableColumnValue<TValue, TNullable>> {
    const nullable = options?.nullable === true
    return Object.freeze({
        kind,
        primary: options?.primary ?? false,
        nullable,
        indexed: options?.indexed ?? false,
        unique: options?.unique ?? false,
        validate: (value: unknown): value is NullableColumnValue<TValue, TNullable> =>
            (nullable && value === null) || validate(value),
    })
}

export const column = {
    text<TNullable extends boolean = false>(
        options?: TypedColumnOptions<TNullable>,
    ): EntityColumn<NullableColumnValue<string, TNullable>> {
        return createColumn("text", options, (value): value is string => typeof value === "string")
    },
    enumText<TValue extends string, TNullable extends boolean = false>(
        values: readonly TValue[],
        options?: TypedColumnOptions<TNullable>,
    ): EntityColumn<NullableColumnValue<TValue, TNullable>> {
        const allowed = new Set<string>(values)
        return createColumn("text", options, (value): value is TValue => typeof value === "string" && allowed.has(value))
    },
    integer<TNullable extends boolean = false>(
        options?: TypedColumnOptions<TNullable>,
    ): EntityColumn<NullableColumnValue<number, TNullable>> {
        return createColumn("integer", options, (value): value is number => Number.isSafeInteger(value))
    },
    real<TNullable extends boolean = false>(
        options?: TypedColumnOptions<TNullable>,
    ): EntityColumn<NullableColumnValue<number, TNullable>> {
        return createColumn("real", options, (value): value is number => typeof value === "number" && Number.isFinite(value))
    },
    boolean<TNullable extends boolean = false>(
        options?: TypedColumnOptions<TNullable>,
    ): EntityColumn<NullableColumnValue<boolean, TNullable>> {
        return createColumn("boolean", options, (value): value is boolean => typeof value === "boolean")
    },
    blob<TNullable extends boolean = false>(
        options?: TypedColumnOptions<TNullable>,
    ): EntityColumn<NullableColumnValue<Uint8Array, TNullable>> {
        return createColumn("blob", options, (value): value is Uint8Array => value instanceof Uint8Array)
    },
    json<TValue extends object, TNullable extends boolean = false>(
        options: TypedColumnOptions<TNullable> & { validate: (value: unknown) => value is TValue },
    ): EntityColumn<NullableColumnValue<TValue, TNullable>> {
        return createColumn("json", options, options.validate)
    },
}

const LOGICAL_IDENTIFIER = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/
const FIELD_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

export function defineEntity<TEntity extends object>() {
    return (definition: EntitySchemaDefinition<TEntity>): EntitySchema<TEntity> => {
        assertLogicalIdentifier("schema", definition.schemaId)
        if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
            throw new Error(`Entity schema ${definition.schemaId} must use a positive integer version`)
        }

        const columnEntries = Object.entries(definition.columns).map(([name, rawColumn]) => {
            assertFieldIdentifier(name)
            const typedName = name as EntityDataKey<TEntity>
            const entityColumn = rawColumn as EntityColumn<TEntity[EntityDataKey<TEntity>]>
            const field: EntityFieldRef<TEntity, TEntity[EntityDataKey<TEntity>]> = Object.freeze({
                schemaId: definition.schemaId,
                name: typedName,
                kind: entityColumn.kind,
                nullable: entityColumn.nullable,
            })
            return Object.freeze({ name: typedName, column: entityColumn, field })
        })
        if (columnEntries.length === 0) throw new Error(`Entity schema ${definition.schemaId} must define columns`)

        const primaryFields = columnEntries.filter(({ column: entityColumn }) => entityColumn.primary).map(({ field }) => field)
        if (primaryFields.length === 0) throw new Error(`Entity schema ${definition.schemaId} must define a primary key`)

        const indexes = definition.indexes ?? []
        const indexNames = new Set<string>()
        for (const index of indexes) {
            assertLogicalIdentifier("index", index.name)
            if (indexNames.has(index.name)) throw new Error(`Duplicate entity index ${index.name}`)
            indexNames.add(index.name)
            if (index.fields.length === 0) throw new Error(`Entity index ${index.name} must contain fields`)
            for (const field of index.fields) assertKnownField(definition.schemaId, columnEntries, field)
        }

        const fields = Object.fromEntries(columnEntries.map(({ name, field }) => [name, field])) as EntityFields<TEntity>
        const defaultOrder = createDefaultOrder(definition, columnEntries, primaryFields)
        const fingerprint = JSON.stringify({
            schemaId: definition.schemaId,
            version: definition.version,
            columns: columnEntries.map(({ name, column: entityColumn }) => ({
                name,
                kind: entityColumn.kind,
                primary: entityColumn.primary,
                nullable: entityColumn.nullable,
                indexed: entityColumn.indexed,
                unique: entityColumn.unique,
            })),
            indexes: indexes.map((index) => ({ name: index.name, fields: [...index.fields], unique: index.unique ?? false })),
            defaultOrder: defaultOrder.map((order) => ({ field: order.field.name, direction: order.direction })),
        })

        return Object.freeze({
            schemaId: definition.schemaId,
            version: definition.version,
            columns: definition.columns,
            fields,
            indexes,
            primaryFields,
            defaultOrder,
            columnEntries,
            fingerprint,
            dehydrate(entity: TEntity): EntityValues<TEntity> {
                const values: Partial<EntityValues<TEntity>> = {}
                for (const { name, column: entityColumn } of columnEntries) {
                    const value = entity[name]
                    if (!entityColumn.validate(value)) throw new Error(`Invalid value for ${definition.schemaId}.${name}`)
                    Object.assign(values, { [name]: value })
                }
                return values as EntityValues<TEntity>
            },
            hydrate(values: EntityValues<TEntity>): TEntity {
                for (const { name, column: entityColumn } of columnEntries) {
                    if (!entityColumn.validate(values[name])) {
                        throw new Error(`Invalid persisted value for ${definition.schemaId}.${name}`)
                    }
                }
                return definition.hydrate(values)
            },
        })
    }
}

function createDefaultOrder<TEntity extends object>(
    definition: EntitySchemaDefinition<TEntity>,
    columnEntries: readonly EntityColumnEntry<TEntity>[],
    primaryFields: readonly EntityFieldRef<TEntity, unknown>[],
): readonly EntityFieldOrder<TEntity>[] {
    if (definition.defaultOrder && definition.defaultOrder.length === 0) {
        throw new Error(`Entity schema ${definition.schemaId} default order must contain fields`)
    }
    const configured =
        definition.defaultOrder?.map((order) => {
            assertKnownField(definition.schemaId, columnEntries, order.field)
            const field = columnEntries.find((entry) => entry.name === order.field)?.field
            if (!field) throw new Error(`Entity schema ${definition.schemaId} references unknown field ${order.field}`)
            return Object.freeze({ field, direction: order.direction })
        }) ?? []
    const orderedNames = new Set(configured.map((order) => order.field.name))
    const tieBreakers = primaryFields
        .filter((field) => !orderedNames.has(field.name))
        .map((field) => Object.freeze({ field, direction: "asc" as const }))
    return Object.freeze(configured.length > 0 ? [...configured, ...tieBreakers] : tieBreakers)
}

function assertKnownField<TEntity extends object>(
    schemaId: string,
    columnEntries: readonly EntityColumnEntry<TEntity>[],
    field: EntityDataKey<TEntity>,
): void {
    if (!columnEntries.some(({ name }) => name === field)) {
        throw new Error(`Entity schema ${schemaId} references unknown field ${field}`)
    }
}

function assertLogicalIdentifier(kind: "schema" | "index", value: string): void {
    if (!LOGICAL_IDENTIFIER.test(value)) throw new Error(`Invalid entity ${kind} identifier: ${value}`)
}

function assertFieldIdentifier(value: string): void {
    if (!FIELD_IDENTIFIER.test(value)) throw new Error(`Invalid entity field identifier: ${value}`)
}
