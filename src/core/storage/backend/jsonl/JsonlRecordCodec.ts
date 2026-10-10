import type { EntitySchema, EntityValues } from "../api/EntitySchema"

export interface JsonlRecordCodec<TEntity extends object, TPersisted = unknown> {
    decode(value: unknown, ordinal: number): TEntity
    encode(entity: TEntity): TPersisted
}

export function createSchemaJsonlRecordCodec<TEntity extends object>(
    schema: EntitySchema<TEntity>,
): JsonlRecordCodec<TEntity, EntityValues<TEntity>> {
    return {
        decode: (value) => {
            if (typeof value !== "object" || value === null || Array.isArray(value)) {
                throw new Error(`Invalid persisted JSONL record for ${schema.schemaId}`)
            }
            return schema.hydrate(value as EntityValues<TEntity>)
        },
        encode: (entity) => schema.dehydrate(entity),
    }
}
