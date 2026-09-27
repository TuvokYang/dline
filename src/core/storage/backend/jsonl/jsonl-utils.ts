import crypto from "node:crypto"
import fs, { type FileHandle } from "fs/promises"
import { fileExistsAtPath } from "@/utils/fs"

/**
 * JSONL (JSON Lines) utility functions for incremental storage.
 *
 * Replaces full-array JSON read/write with line-by-line JSONL format,
 * enabling append-only writes and streaming reads for large datasets.
 *
 * Legacy JSON array files are detected and parsed on read, but NOT overwritten.
 * The original file is preserved as a natural backup. New data is written
 * to .jsonl files exclusively.
 */

const TRIM_START_REGEX = /^\s+/
/**
 * Bytes examined when deciding whether a file is a legacy JSON array.
 *
 * Enough to pass any realistic run of leading whitespace and a BOM without
 * reading a file that exists precisely because it is too large to rewrite.
 */
const LEGACY_ARRAY_PROBE_BYTES = 64
const NEWLINE = 0x0a
/** Read size used when scanning a file backwards for its final lines. */
const TAIL_CHUNK_BYTES = 64 * 1024
const ATOMIC_RENAME_MAX_ATTEMPTS = 3
const ATOMIC_RENAME_RETRY_DELAYS_MS = [10, 25] as const
const RETRYABLE_ATOMIC_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"])

async function renameAtomicFile(sourcePath: string, destinationPath: string): Promise<void> {
	for (let attempt = 1; attempt <= ATOMIC_RENAME_MAX_ATTEMPTS; attempt++) {
		try {
			await fs.rename(sourcePath, destinationPath)
			return
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code
			if (!code || !RETRYABLE_ATOMIC_RENAME_CODES.has(code) || attempt === ATOMIC_RENAME_MAX_ATTEMPTS) {
				throw error
			}
			await new Promise<void>((resolve) => setTimeout(resolve, ATOMIC_RENAME_RETRY_DELAYS_MS[attempt - 1] ?? 0))
		}
	}
}

/** Check whether file content is a JSON array (starts with '[' after whitespace). */
function isJsonArray(content: string): boolean {
	return content.replace(TRIM_START_REGEX, "").startsWith("[")
}

/**
 * Drop a leading byte order mark.
 *
 * Decoding utf8 leaves the BOM in the string, so a file that carries one would
 * otherwise fail the array check by a single character.
 */
function stripByteOrderMark(content: string): string {
	return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
}

/**
 * Read a JSONL file and return parsed entries as an array.
 * Supports both JSONL format (one JSON object per line) and legacy
 * JSON array format. Legacy files are parsed but NOT modified —
 * they serve as natural backups.
 *
 * @param filePath Absolute path to the JSONL/JSON file
 * @returns Parsed entries (empty array if file does not exist)
 */
export async function readJsonl<T>(filePath: string): Promise<T[]> {
	if (!(await fileExistsAtPath(filePath))) {
		return []
	}

	const content = await fs.readFile(filePath, "utf8")

	// Empty file
	if (!content.trim()) {
		return []
	}

	// Legacy JSON array — parse directly, do NOT overwrite the original file
	if (isJsonArray(content)) {
		try {
			const parsed = JSON.parse(content)
			return Array.isArray(parsed) ? (parsed as T[]) : [parsed as T]
		} catch {
			return []
		}
	}

	// JSONL: one JSON object per line
	return parseJsonlContent<T>(content)
}

/**
 * Append one or more entries as JSONL lines to a file.
 * Creates the file if it does not exist.
 *
 * @param filePath Absolute path to the JSONL file
 * @param entries Entry or entries to append
 */
export async function appendJsonl<T>(filePath: string, entries: T | T[]): Promise<void> {
	const items = Array.isArray(entries) ? entries : [entries]
	if (items.length === 0) return

	const lines = `${items.map((item) => JSON.stringify(item)).join("\n")}\n`
	await fs.appendFile(filePath, lines, "utf8")
}

/**
 * Report whether new lines can be concatenated onto this file as-is.
 *
 * Reading accepts shapes that appending cannot extend: a legacy JSON array
 * stays one document, and a final line without its newline would swallow the
 * next record into itself. Both produce a file that no longer parses, so a
 * caller that cannot append must rewrite instead.
 *
 * Only a short prefix and the final byte are inspected, so this stays cheap on
 * a file whose whole point is being too large to rewrite.
 */
export async function canAppendJsonl(filePath: string): Promise<boolean> {
	if (!(await fileExistsAtPath(filePath))) return true

	let handle: FileHandle | undefined
	try {
		handle = await fs.open(filePath, "r")
		const { size } = await handle.stat()
		if (size === 0) return true

		// The reader recognizes a legacy array after leading whitespace and a
		// BOM, so the same prefix has to be examined here. Judging from the very
		// first byte alone would classify `\n  [...]` as JSONL and concatenate a
		// line after the closing bracket, leaving a document that no longer
		// parses and a history that reads back as empty.
		const prefixLength = Math.min(size, LEGACY_ARRAY_PROBE_BYTES)
		const prefix = Buffer.alloc(prefixLength)
		await handle.read(prefix, 0, prefixLength, 0)
		if (isJsonArray(stripByteOrderMark(prefix.toString("utf8")))) return false

		const tail = Buffer.alloc(1)
		await handle.read(tail, 0, 1, size - 1)
		return tail.toString("utf8") === "\n"
	} catch {
		// An unreadable file is never assumed appendable: rewriting is the
		// recoverable choice, concatenating onto unknown bytes is not.
		return false
	} finally {
		await handle?.close()
	}
}

/** Keep the first N JSONL records by scanning only the removed tail. */
export async function truncateJsonlTail(filePath: string, keepLineCount: number, expectedLineCount: number): Promise<void> {
	if (!Number.isInteger(keepLineCount) || !Number.isInteger(expectedLineCount)) {
		throw new Error("JSONL tail truncation requires integer line counts")
	}
	if (keepLineCount < 0 || expectedLineCount < keepLineCount) {
		throw new Error(`Invalid JSONL tail truncation boundary: keep=${keepLineCount}, expected=${expectedLineCount}`)
	}
	if (keepLineCount === expectedLineCount) return

	const handle = await fs.open(filePath, "r+")
	try {
		if (keepLineCount === 0) {
			await handle.truncate(0)
			return
		}
		const { size } = await handle.stat()
		if (size === 0) throw new Error("JSONL tail truncation expected persisted records in an empty file")

		const lastByte = Buffer.allocUnsafe(1)
		await handle.read(lastByte, 0, 1, size - 1)
		const removedLineCount = expectedLineCount - keepLineCount
		const boundaryNewlineOrdinal = removedLineCount + (lastByte[0] === 0x0a ? 1 : 0)
		const chunk = Buffer.allocUnsafe(64 * 1024)
		let position = size
		let seenNewlines = 0
		while (position > 0) {
			const length = Math.min(chunk.length, position)
			position -= length
			const { bytesRead } = await handle.read(chunk, 0, length, position)
			for (let index = bytesRead - 1; index >= 0; index--) {
				if (chunk[index] !== 0x0a) continue
				seenNewlines += 1
				if (seenNewlines === boundaryNewlineOrdinal) {
					await handle.truncate(position + index + 1)
					return
				}
			}
		}
		throw new Error(`JSONL tail truncation could not locate boundary: keep=${keepLineCount}, expected=${expectedLineCount}`)
	} finally {
		await handle.close()
	}
}

/** One final JSONL line and the byte offset where it starts. */
interface JsonlTailLine {
	readonly offset: number
	readonly text: string
}

interface JsonlTail {
	readonly size: number
	/** Whether the file ends with a newline, so another line can follow directly. */
	readonly terminated: boolean
	/** Up to the requested number of final lines, in file order. */
	readonly lines: readonly JsonlTailLine[]
}

/**
 * Read the final lines of a JSONL file without reading the lines before them.
 *
 * A file holding fewer lines than requested returns all of them, which lets a
 * caller tell a short file apart from a matching one.
 */
async function readJsonlTail(handle: FileHandle, lineCount: number): Promise<JsonlTail> {
	const { size } = await handle.stat()
	if (size === 0) return { size, terminated: true, lines: [] }
	const lastByte = Buffer.alloc(1)
	await handle.read(lastByte, 0, 1, size - 1)
	const terminated = lastByte[0] === NEWLINE
	if (lineCount === 0) return { size, terminated, lines: [] }

	// The newline ending the line just before the requested ones. A final
	// newline terminates the last line rather than starting another one.
	const boundaryOrdinal = lineCount + (terminated ? 1 : 0)
	const chunks: Buffer[] = []
	let position = size
	let seenNewlines = 0
	let start = 0
	scan: while (position > 0) {
		const length = Math.min(TAIL_CHUNK_BYTES, position)
		position -= length
		const chunk = Buffer.allocUnsafe(length)
		const { bytesRead } = await handle.read(chunk, 0, length, position)
		// Every offset below is derived from `position`, so a short read would
		// point a later truncation at the wrong byte.
		if (bytesRead !== length) throw new Error("JSONL tail read returned fewer bytes than the file holds")
		chunks.unshift(chunk)
		for (let index = length - 1; index >= 0; index--) {
			if (chunk[index] !== NEWLINE) continue
			seenNewlines += 1
			if (seenNewlines === boundaryOrdinal) {
				start = position + index + 1
				break scan
			}
		}
	}

	// Split on bytes rather than on decoded text so every offset stays a byte
	// offset that truncation can use directly.
	const region = Buffer.concat(chunks).subarray(start - position)
	const lines: JsonlTailLine[] = []
	let lineStart = 0
	for (let index = 0; index < region.length; index++) {
		if (region[index] !== NEWLINE) continue
		lines.push({ offset: start + lineStart, text: region.toString("utf8", lineStart, index) })
		lineStart = index + 1
	}
	if (lineStart < region.length) lines.push({ offset: start + lineStart, text: region.toString("utf8", lineStart) })
	return { size, terminated, lines }
}

function lineTimestamp(text: string): number | undefined {
	try {
		const value: unknown = JSON.parse(text)
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
		const ts = (value as { ts?: unknown }).ts
		return typeof ts === "number" ? ts : undefined
	} catch {
		return undefined
	}
}

function endsWithTimestamps(tail: JsonlTail, expected: readonly number[]): boolean {
	if (expected.length === 0) return tail.size === 0
	if (tail.lines.length !== expected.length) return false
	return tail.lines.every((line, index) => lineTimestamp(line.text) === expected[index])
}

export interface JsonlTailReplacement<T> {
	/**
	 * Timestamps the final lines must carry, in order. An empty list asserts
	 * an empty file.
	 */
	readonly expectedTailTimestamps: readonly number[]
	/** Final lines replaced by `entries`; zero appends after the last line. */
	readonly replacedLineCount: number
	readonly entries: readonly T[]
}

/**
 * Replace the end of a JSONL file, provided it still ends the way the caller
 * last saw it.
 *
 * Only the final lines are read: enough to confirm they carry the expected
 * timestamps and to find where the replaced lines begin. A mismatch writes
 * nothing and resolves false, leaving the caller to fall back to a full read.
 * That covers a file another writer extended, a legacy JSON array, and an
 * unreadable or unterminated final line.
 *
 * Cutting and appending are two writes, so a process that dies between them
 * loses the replaced lines from disk while every earlier line stays intact.
 * The caller must hold the file lock.
 */
export async function replaceJsonlTail<T>(filePath: string, replacement: JsonlTailReplacement<T>): Promise<boolean> {
	const { expectedTailTimestamps, replacedLineCount, entries } = replacement
	if (!Number.isInteger(replacedLineCount) || replacedLineCount < 0 || replacedLineCount > expectedTailTimestamps.length) {
		throw new Error(
			`Invalid JSONL tail replacement: replaced=${replacedLineCount}, verified=${expectedTailTimestamps.length}`,
		)
	}

	let tail: JsonlTail = { size: 0, terminated: true, lines: [] }
	if (await fileExistsAtPath(filePath)) {
		const handle = await fs.open(filePath, "r")
		try {
			tail = await readJsonlTail(handle, expectedTailTimestamps.length)
		} finally {
			await handle.close()
		}
	}
	if (!endsWithTimestamps(tail, expectedTailTimestamps)) return false

	if (replacedLineCount === 0) {
		// An unterminated final line would absorb the first appended record.
		if (!tail.terminated) return false
		await appendJsonl(filePath, [...entries])
		return true
	}
	await fs.truncate(filePath, tail.lines[tail.lines.length - replacedLineCount].offset)
	await appendJsonl(filePath, [...entries])
	return true
}

/**
 * Write the full array as JSONL with atomic write-then-rename.
 * Prevents file truncation on crash compared to direct fs.writeFile.
 *
 * @param filePath Absolute path to the JSONL file
 * @param entries Full array to write
 */
export async function writeJsonl<T>(filePath: string, entries: T[]): Promise<void> {
	const lines = entries.map((item) => JSON.stringify(item)).join("\n")
	const content = lines ? `${lines}\n` : ""
	const tmpPath = `${filePath}.tmp.${crypto.randomUUID()}`
	await fs.writeFile(tmpPath, content, "utf8")
	try {
		await renameAtomicFile(tmpPath, filePath)
	} catch (renameErr) {
		// Best-effort cleanup: if rename fails, remove the orphaned temp file
		try {
			await fs.unlink(tmpPath)
		} catch {
			// ignore unlink errors
		}
		throw renameErr
	}
}

/**
 * Parse JSONL content into an array of entries.
 * Skips empty lines gracefully.
 *
 * @param content Raw JSONL file content
 * @returns Parsed entries
 */
function parseJsonlContent<T>(content: string): T[] {
	const results: T[] = []
	const lines = content.split("\n")
	for (const line of lines) {
		const trimmed = line.trim()
		if (!trimmed) continue
		try {
			results.push(JSON.parse(trimmed) as T)
		} catch {
			// Skip malformed lines silently — preserves as much data as possible
		}
	}
	return results
}
