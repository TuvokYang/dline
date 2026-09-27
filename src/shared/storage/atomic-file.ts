import { randomUUID } from "node:crypto"
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises"
import path from "node:path"

/**
 * The single atomic file replacement primitive for extension-host code.
 *
 * Every write lands in a uniquely named temporary file in the target directory and becomes
 * visible through one rename, so readers observe either the previous or the next complete
 * document. Windows reports transient EPERM/EBUSY/EACCES while another handle (antivirus,
 * indexer, a concurrent reader) holds the destination, so renames retry with bounded backoff.
 *
 * Node-only: never import this module from the Webview bundle.
 */

const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"])
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100] as const
const BACKUP_SUFFIX = ".bak"
const DEFAULT_FILE_MODE = 0o666
const DEFAULT_STALE_TEMP_AGE_MS = 60_000
const TEMP_FILE_PATTERN = /^.+\.\d+\.[0-9a-f-]{36}\.tmp$/
/** Temporary files left by the removed `disk.ts` implementation. */
const LEGACY_TEMP_FILE_PATTERN = /^.+\.tmp\.\d{13}\.[0-9a-z-]+\.json$/
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4))

export interface AtomicWriteOptions {
	/**
	 * Move the current file to `<path>.bak` before the new content replaces it. Rotation is a
	 * rename, not a copy, so it adds no write volume. A crash between the two renames leaves
	 * only the backup, which {@link readJsonWithBackup} returns.
	 */
	readonly backup?: boolean
	/** Flush file contents to stable storage before the rename publishes them. */
	readonly fsync?: boolean
	/** Permission bits of the published file, for example `0o600` for credentials. */
	readonly mode?: number
	/**
	 * Backoff between rename attempts after a transient sharing error. Documents that several
	 * windows watch and re-read (the API profile catalog) need a longer budget than the default.
	 */
	readonly renameRetryDelaysMs?: readonly number[]
}

export type BackupReadResult<T> =
	| { readonly status: "primary"; readonly value: T }
	| { readonly status: "backup"; readonly value: T; readonly primaryError: unknown }
	| { readonly status: "missing" }
	| { readonly status: "invalid"; readonly error: unknown }

type CandidateResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly missing: boolean; readonly error: unknown }

export function backupPathOf(filePath: string): string {
	return `${filePath}${BACKUP_SUFFIX}`
}

/** JSON layout shared by every persisted document: two-space indentation and a trailing newline. */
export function serializeJson(value: unknown): string {
	const text = JSON.stringify(value, null, 2)
	if (text === undefined) throw new TypeError("Atomic JSON write requires a JSON-serializable value")
	return `${text}\n`
}

export async function writeFileAtomic(
	filePath: string,
	data: string | Uint8Array,
	options: AtomicWriteOptions = {},
): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true })
	const temporaryPath = temporaryPathOf(filePath)
	let rotated = false
	try {
		await writeTemporaryFile(temporaryPath, data, options)
		if (options.backup) rotated = await rotateToBackup(filePath)
		await renameWithRetry(temporaryPath, filePath, options.renameRetryDelaysMs)
	} catch (error) {
		await rm(temporaryPath, { force: true }).catch(() => undefined)
		if (rotated) await renameWithRetry(backupPathOf(filePath), filePath).catch(() => undefined)
		throw error
	}
}

export async function writeJsonAtomic(filePath: string, value: unknown, options: AtomicWriteOptions = {}): Promise<void> {
	await writeFileAtomic(filePath, serializeJson(value), options)
}

/**
 * Read a JSON document, falling back to `<path>.bak` when the primary file is missing or
 * rejected by `parse`. `parse` must throw for values it does not accept.
 */
export async function readJsonWithBackup<T>(filePath: string, parse: (value: unknown) => T): Promise<BackupReadResult<T>> {
	const primary = await readJsonCandidate(filePath, parse)
	if (primary.ok) return { status: "primary", value: primary.value }
	return resolveBackupRead(primary, await readJsonCandidate(backupPathOf(filePath), parse))
}

/** Remove temporary files abandoned by a crash between write and rename. */
export async function removeStaleAtomicTempFiles(
	directory: string,
	maxAgeMs: number = DEFAULT_STALE_TEMP_AGE_MS,
	now: number = Date.now(),
): Promise<void> {
	let names: string[]
	try {
		names = await readdir(directory)
	} catch {
		return
	}
	for (const name of names.filter(isAtomicTempFileName)) {
		const filePath = path.join(directory, name)
		try {
			if (now - (await stat(filePath)).mtimeMs > maxAgeMs) await rm(filePath, { force: true })
		} catch {
			// Another process already published or removed it.
		}
	}
}

export function writeFileAtomicSync(filePath: string, data: string | Uint8Array, options: AtomicWriteOptions = {}): void {
	mkdirSync(path.dirname(filePath), { recursive: true })
	const temporaryPath = temporaryPathOf(filePath)
	let rotated = false
	try {
		writeTemporaryFileSync(temporaryPath, data, options)
		if (options.backup) rotated = rotateToBackupSync(filePath)
		renameWithRetrySync(temporaryPath, filePath, options.renameRetryDelaysMs)
	} catch (error) {
		rmSync(temporaryPath, { force: true })
		if (rotated) restoreBackupSync(filePath)
		throw error
	}
}

export function writeJsonAtomicSync(filePath: string, value: unknown, options: AtomicWriteOptions = {}): void {
	writeFileAtomicSync(filePath, serializeJson(value), options)
}

export function readJsonWithBackupSync<T>(filePath: string, parse: (value: unknown) => T): BackupReadResult<T> {
	const primary = readJsonCandidateSync(filePath, parse)
	if (primary.ok) return { status: "primary", value: primary.value }
	return resolveBackupRead(primary, readJsonCandidateSync(backupPathOf(filePath), parse))
}

export function removeStaleAtomicTempFilesSync(
	directory: string,
	maxAgeMs: number = DEFAULT_STALE_TEMP_AGE_MS,
	now: number = Date.now(),
): void {
	let names: string[]
	try {
		names = readdirSync(directory)
	} catch {
		return
	}
	for (const name of names.filter(isAtomicTempFileName)) {
		const filePath = path.join(directory, name)
		try {
			if (now - statSync(filePath).mtimeMs > maxAgeMs) rmSync(filePath, { force: true })
		} catch {
			// Another process already published or removed it.
		}
	}
}

/**
 * A fresh temporary path next to `filePath`. Files with this shape that outlive their
 * writer are removed by {@link removeStaleAtomicTempFiles}.
 */
export function temporaryPathOf(filePath: string): string {
	return `${filePath}.${process.pid}.${randomUUID()}.tmp`
}

function isAtomicTempFileName(name: string): boolean {
	return TEMP_FILE_PATTERN.test(name) || LEGACY_TEMP_FILE_PATTERN.test(name)
}

function errorCode(error: unknown): string | undefined {
	const code = (error as NodeJS.ErrnoException | undefined)?.code
	return typeof code === "string" ? code : undefined
}

function isRetryableRenameError(error: unknown): boolean {
	const code = errorCode(error)
	return code !== undefined && RETRYABLE_RENAME_CODES.has(code)
}

function isMissingFileError(error: unknown): boolean {
	return errorCode(error) === "ENOENT"
}

function resolveBackupRead<T>(primary: CandidateResult<T>, backup: CandidateResult<T>): BackupReadResult<T> {
	if (primary.ok) return { status: "primary", value: primary.value }
	if (backup.ok) return { status: "backup", value: backup.value, primaryError: primary.error }
	if (primary.missing && backup.missing) return { status: "missing" }
	return { status: "invalid", error: primary.missing ? backup.error : primary.error }
}

function parseCandidate<T>(raw: string, parse: (value: unknown) => T): CandidateResult<T> {
	try {
		return { ok: true, value: parse(JSON.parse(raw)) }
	} catch (error) {
		return { ok: false, missing: false, error }
	}
}

async function readJsonCandidate<T>(filePath: string, parse: (value: unknown) => T): Promise<CandidateResult<T>> {
	let raw: string
	try {
		raw = await readFile(filePath, "utf8")
	} catch (error) {
		return { ok: false, missing: isMissingFileError(error), error }
	}
	return parseCandidate(raw, parse)
}

function readJsonCandidateSync<T>(filePath: string, parse: (value: unknown) => T): CandidateResult<T> {
	let raw: string
	try {
		raw = readFileSync(filePath, "utf8")
	} catch (error) {
		return { ok: false, missing: isMissingFileError(error), error }
	}
	return parseCandidate(raw, parse)
}

async function writeTemporaryFile(temporaryPath: string, data: string | Uint8Array, options: AtomicWriteOptions): Promise<void> {
	const handle = await open(temporaryPath, "wx", options.mode ?? DEFAULT_FILE_MODE)
	try {
		await handle.writeFile(data)
		if (options.fsync) await handle.sync()
	} finally {
		await handle.close()
	}
}

function writeTemporaryFileSync(temporaryPath: string, data: string | Uint8Array, options: AtomicWriteOptions): void {
	const descriptor = openSync(temporaryPath, "wx", options.mode ?? DEFAULT_FILE_MODE)
	try {
		writeFileSync(descriptor, data)
		if (options.fsync) fsyncSync(descriptor)
	} finally {
		closeSync(descriptor)
	}
}

async function rotateToBackup(filePath: string): Promise<boolean> {
	try {
		await renameWithRetry(filePath, backupPathOf(filePath))
		return true
	} catch (error) {
		if (isMissingFileError(error)) return false
		throw error
	}
}

function rotateToBackupSync(filePath: string): boolean {
	try {
		renameWithRetrySync(filePath, backupPathOf(filePath))
		return true
	} catch (error) {
		if (isMissingFileError(error)) return false
		throw error
	}
}

function restoreBackupSync(filePath: string): void {
	try {
		renameWithRetrySync(backupPathOf(filePath), filePath)
	} catch {
		// The backup stays readable through readJsonWithBackupSync.
	}
}

/** Renames `sourcePath` over `destinationPath`, retrying the transient Windows sharing errors. */
export async function renameWithRetry(
	sourcePath: string,
	destinationPath: string,
	retryDelaysMs: readonly number[] = RENAME_RETRY_DELAYS_MS,
): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await rename(sourcePath, destinationPath)
			return
		} catch (error) {
			if (!isRetryableRenameError(error) || attempt >= retryDelaysMs.length) throw error
			await new Promise<void>((resolve) => setTimeout(resolve, retryDelaysMs[attempt]))
		}
	}
}

function renameWithRetrySync(
	sourcePath: string,
	destinationPath: string,
	retryDelaysMs: readonly number[] = RENAME_RETRY_DELAYS_MS,
): void {
	for (let attempt = 0; ; attempt++) {
		try {
			renameSync(sourcePath, destinationPath)
			return
		} catch (error) {
			if (!isRetryableRenameError(error) || attempt >= retryDelaysMs.length) throw error
			Atomics.wait(SLEEP_CELL, 0, 0, retryDelaysMs[attempt])
		}
	}
}
