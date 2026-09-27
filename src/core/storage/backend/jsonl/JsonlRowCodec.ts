import type { EntitySchema, EntityValues } from "../api/EntitySchema"
import { UnifyStoreCorruptionError } from "../api/UnifyStoreErrors"

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/**
 * One stored row as a JSON line: every column in schema order, blobs as base64.
 *
 * JSON has no byte type, so a blob written as-is would come back as an object of
 * numbered keys; base64 keeps the bytes exact.
 */
export function encodeJsonlRow<TEntity extends object>(schema: EntitySchema<TEntity>, values: EntityValues<TEntity>): string {
	const encoded: Record<string, unknown> = {}
	for (const { name, column } of schema.columnEntries) {
		const value = values[name]
		encoded[name] = column.kind === "blob" && value instanceof Uint8Array ? base64Of(value) : value
	}
	return JSON.stringify(encoded)
}

/**
 * Decodes one line written by {@link encodeJsonlRow}.
 *
 * @param where file and line number reported when the line is rejected.
 * @throws UnifyStoreCorruptionError when the line is not valid JSON, has missing or
 * extra columns, or holds a value the schema does not accept.
 */
export function decodeJsonlRow<TEntity extends object>(
	schema: EntitySchema<TEntity>,
	line: string,
	where: string,
): EntityValues<TEntity> {
	let parsed: unknown
	try {
		parsed = JSON.parse(line)
	} catch (error) {
		throw new UnifyStoreCorruptionError(`Malformed ${schema.schemaId} record at ${where}`, { cause: error })
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new UnifyStoreCorruptionError(`${schema.schemaId} record at ${where} is not an object`)
	}
	const stored = parsed as Record<string, unknown>
	if (Object.keys(stored).length !== schema.columnEntries.length) {
		throw new UnifyStoreCorruptionError(`${schema.schemaId} record at ${where} does not match its columns`)
	}
	const values: Record<string, unknown> = {}
	for (const { name, column } of schema.columnEntries) {
		if (!Object.hasOwn(stored, name)) {
			throw new UnifyStoreCorruptionError(`${schema.schemaId} record at ${where} is missing ${name}`)
		}
		const raw = stored[name]
		const value = column.kind === "blob" && raw !== null ? bytesOf(raw, schema.schemaId, name, where) : raw
		if (!column.validate(value)) {
			throw new UnifyStoreCorruptionError(`Invalid ${schema.schemaId}.${name} at ${where}`)
		}
		values[name] = value
	}
	return values as EntityValues<TEntity>
}

function base64Of(bytes: Uint8Array): string {
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")
}

function bytesOf(raw: unknown, schemaId: string, name: string, where: string): Uint8Array {
	if (typeof raw !== "string" || !BASE64.test(raw)) {
		throw new UnifyStoreCorruptionError(`Invalid ${schemaId}.${name} bytes at ${where}`)
	}
	// A copy with its own buffer, like the SQLite backend returns, rather than a view of Node's pool.
	return new Uint8Array(Buffer.from(raw, "base64"))
}
