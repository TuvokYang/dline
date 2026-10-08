import { open, readFile, stat, truncate } from "node:fs/promises"
import path from "node:path"
import { writeJsonAtomic } from "@shared/storage/atomic-file"
import type { EntitySchema, EntityValues } from "../api/EntitySchema"
import { UnifyStoreCorruptionError } from "../api/UnifyStoreErrors"
import { decodeJsonlRow, encodeJsonlRow } from "./JsonlRowCodec"

/**
 * On-disk format of a JSONL UnifyStore database: one directory holding `database.json`
 * and one `.jsonl` file per collection.
 *
 * `database.json` is the commit point. It records, for every collection, the data file
 * and the byte length and row count that are committed. A transaction appends its rows
 * past that length, or writes a replacement file under a new name, and commits by
 * atomically replacing `database.json`. A crash before that replacement leaves bytes
 * past the recorded length, which readers ignore and the next writer truncates, or an
 * unreferenced file, which the next open removes. Nothing is ever read that was not
 * committed, and every committed byte must decode.
 */

export const JSONL_DATABASE_FORMAT = "dline-unify-store-jsonl"
export const JSONL_DATABASE_VERSION = 1
export const MANIFEST_FILE_NAME = "database.json"

const DATA_FILE_NAME = /^[A-Za-z0-9_-]+-[0-9a-f]{8}(?:\.\d+)?\.jsonl$/
const READ_CHUNK_BYTES = 1024 * 1024
const WRITE_BATCH_BYTES = 1024 * 1024
const NEWLINE = 0x0a

export interface JsonlCollectionEntry {
	readonly version: number
	readonly fingerprint: string
	/** Data file name inside the database directory. */
	readonly file: string
	/** Committed byte length of the data file. */
	readonly size: number
	/** Committed number of rows. */
	readonly rows: number
}

export interface JsonlManifest {
	readonly format: typeof JSONL_DATABASE_FORMAT
	readonly version: number
	/** Incremented by every commit; also names replacement files so a name is never reused. */
	readonly generation: number
	readonly collections: Readonly<Record<string, JsonlCollectionEntry>>
}

export function emptyManifest(): JsonlManifest {
	return { format: JSONL_DATABASE_FORMAT, version: JSONL_DATABASE_VERSION, generation: 0, collections: {} }
}

export function isDataFileName(name: string): boolean {
	return DATA_FILE_NAME.test(name)
}

/** Data file of a new collection; a replacement adds the generation that wrote it. */
export function dataFileName(schemaId: string, generation?: number): string {
	const base = `${schemaId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 72)}-${fnv1a(schemaId)}`
	return generation === undefined ? `${base}.jsonl` : `${base}.${generation}.jsonl`
}

/**
 * Reads `database.json`, or `undefined` when the directory has none yet.
 *
 * @throws UnifyStoreCorruptionError when the file is not a valid manifest.
 * @throws Error when the manifest was written by a newer format version.
 */
export async function readManifest(directory: string): Promise<JsonlManifest | undefined> {
	const manifestPath = path.join(directory, MANIFEST_FILE_NAME)
	let text: string
	try {
		text = await readFile(manifestPath, "utf8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
		throw error
	}
	let value: unknown
	try {
		value = JSON.parse(text)
	} catch (error) {
		throw new UnifyStoreCorruptionError(`Malformed ${manifestPath}`, { cause: error })
	}
	return parseManifest(value, manifestPath)
}

/** Commits `manifest`; data files it references must already be flushed. */
export async function writeManifest(directory: string, manifest: JsonlManifest): Promise<void> {
	await writeJsonAtomic(path.join(directory, MANIFEST_FILE_NAME), manifest, { fsync: true })
}

function parseManifest(value: unknown, where: string): JsonlManifest {
	if (!isRecord(value) || value.format !== JSONL_DATABASE_FORMAT) {
		throw new UnifyStoreCorruptionError(`${where} is not a UnifyStore JSONL database`)
	}
	if (!isCount(value.version) || value.version < 1) throw new UnifyStoreCorruptionError(`Invalid format version in ${where}`)
	if (value.version > JSONL_DATABASE_VERSION) {
		throw new Error(
			`UnifyStore JSONL format ${value.version} at ${where} is newer than supported version ${JSONL_DATABASE_VERSION}`,
		)
	}
	if (!isCount(value.generation) || !isRecord(value.collections)) {
		throw new UnifyStoreCorruptionError(`Invalid manifest fields in ${where}`)
	}
	const collections: Record<string, JsonlCollectionEntry> = {}
	const files = new Set<string>()
	for (const [schemaId, entry] of Object.entries(value.collections)) {
		if (
			!isRecord(entry) ||
			!isCount(entry.version) ||
			typeof entry.fingerprint !== "string" ||
			typeof entry.file !== "string" ||
			!isDataFileName(entry.file) ||
			files.has(entry.file) ||
			!isCount(entry.size) ||
			!isCount(entry.rows)
		) {
			throw new UnifyStoreCorruptionError(`Invalid collection ${schemaId} in ${where}`)
		}
		files.add(entry.file)
		collections[schemaId] = {
			version: entry.version,
			fingerprint: entry.fingerprint,
			file: entry.file,
			size: entry.size,
			rows: entry.rows,
		}
	}
	return { format: JSONL_DATABASE_FORMAT, version: value.version, generation: value.generation, collections }
}

/**
 * Decodes the rows stored in bytes `[start, end)` of `filePath`.
 *
 * The range is read in chunks so a large collection never becomes one string.
 *
 * @param firstLine number of rows before `start`, used in error locations.
 * @throws UnifyStoreCorruptionError when the file is shorter than `end`, a row does not
 * decode, or the range does not end on a record boundary.
 */
export async function readRows<TEntity extends object>(
	schema: EntitySchema<TEntity>,
	filePath: string,
	start: number,
	end: number,
	firstLine: number,
): Promise<EntityValues<TEntity>[]> {
	if (end === start) return []
	const name = path.basename(filePath)
	const handle = await open(filePath, "r")
	try {
		if ((await handle.stat()).size < end) {
			throw new UnifyStoreCorruptionError(`${name} is shorter than its committed length ${end}`)
		}
		const rows: EntityValues<TEntity>[] = []
		const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES)
		let partial: Buffer[] = []
		let line = firstLine
		let position = start
		while (position < end) {
			const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, end - position), position)
			if (bytesRead === 0) throw new UnifyStoreCorruptionError(`${name} ended before its committed length ${end}`)
			let offset = 0
			for (;;) {
				const newline = chunk.indexOf(NEWLINE, offset)
				if (newline === -1 || newline >= bytesRead) {
					if (offset < bytesRead) partial.push(Buffer.from(chunk.subarray(offset, bytesRead)))
					break
				}
				const piece = chunk.subarray(offset, newline)
				const text = partial.length > 0 ? Buffer.concat([...partial, piece]).toString("utf8") : piece.toString("utf8")
				partial = []
				line += 1
				rows.push(decodeJsonlRow(schema, text, `${name}:${line}`))
				offset = newline + 1
			}
			position += bytesRead
		}
		if (partial.length > 0) throw new UnifyStoreCorruptionError(`${name} does not end on a record boundary at ${end}`)
		return rows
	} finally {
		await handle.close()
	}
}

/** Writes `rows` as a complete, flushed data file and returns its byte length. */
export async function writeRows<TEntity extends object>(
	schema: EntitySchema<TEntity>,
	filePath: string,
	rows: readonly EntityValues<TEntity>[],
): Promise<number> {
	const handle = await open(filePath, "w")
	let size = 0
	try {
		let batch: string[] = []
		let batchBytes = 0
		for (const row of rows) {
			const line = `${encodeJsonlRow(schema, row)}\n`
			batch.push(line)
			batchBytes += line.length
			if (batchBytes >= WRITE_BATCH_BYTES) {
				size += await writeText(handle, batch.join(""))
				batch = []
				batchBytes = 0
			}
		}
		if (batch.length > 0) size += await writeText(handle, batch.join(""))
		await handle.sync()
	} finally {
		await handle.close()
	}
	return size
}

/**
 * Appends `rows` after the end of `filePath`, flushes them, and returns the byte count.
 * The caller has cut any uncommitted tail first, so the rows start at the committed length.
 */
export async function appendRows<TEntity extends object>(
	schema: EntitySchema<TEntity>,
	filePath: string,
	rows: readonly EntityValues<TEntity>[],
): Promise<number> {
	if (rows.length === 0) return 0
	const handle = await open(filePath, "a")
	try {
		const size = await writeText(handle, rows.map((row) => `${encodeJsonlRow(schema, row)}\n`).join(""))
		await handle.sync()
		return size
	} finally {
		await handle.close()
	}
}

/**
 * Cuts bytes a failed commit left past the committed length.
 *
 * @throws UnifyStoreCorruptionError when the file is shorter than its committed length.
 */
export async function discardUncommittedTail(filePath: string, committedSize: number): Promise<void> {
	const { size } = await stat(filePath)
	if (size < committedSize) {
		throw new UnifyStoreCorruptionError(`${path.basename(filePath)} lost committed data (${size} < ${committedSize})`)
	}
	if (size > committedSize) await truncate(filePath, committedSize)
}

async function writeText(handle: Awaited<ReturnType<typeof open>>, text: string): Promise<number> {
	const bytes = Buffer.from(text, "utf8")
	let written = 0
	while (written < bytes.length) {
		const result = await handle.write(bytes, written, bytes.length - written)
		written += result.bytesWritten
	}
	return bytes.length
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0
}

function fnv1a(value: string): string {
	let hash = 0x811c9dc5
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index)
		hash = Math.imul(hash, 0x01000193)
	}
	return (hash >>> 0).toString(16).padStart(8, "0")
}
