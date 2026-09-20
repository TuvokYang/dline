/**
 * Cross-process reader/writer lock over the shared `dist/` build output.
 *
 * E2E state is run-scoped everywhere except `dist/`. Playwright artifacts, VS
 * Code extension directories, and Dline data roots all carry `DLINE_E2E_RUN_ID`,
 * but every tier writes `dist/extension.js` (and optionally `dist/e2e.vsix`) to a
 * fixed path and then reads that same path for the whole run. Two concurrent E2E
 * commands therefore interleave one run's build into another run's bundle, which
 * surfaces later as an unrelated assertion failure or a corrupt VSIX.
 *
 * Builds take the exclusive side and test runs take the shared side, so one
 * prepared artifact can still serve several concurrent read-only runs while a
 * rebuild is refused for as long as any reader is still using it.
 *
 * This is a cooperative advisory lock, not a kernel mutex. It bounds the damage
 * of the common case - a developer starting a second E2E command by hand - and
 * reports the current holder instead of silently overwriting its artifacts.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")

export const DIST_DIR = path.join(PROJECT_ROOT, "dist")
export const DIST_LOCK_ROOT = path.join(DIST_DIR, ".e2e-lock")

const WRITER_ENTRY_PATH = path.join(DIST_LOCK_ROOT, "writer.json")
const READERS_DIR = path.join(DIST_LOCK_ROOT, "readers")

export const EXCLUSIVE_MODE = "exclusive"
export const SHARED_MODE = "shared"

/**
 * @typedef {{
 *   pid: number,
 *   runId: string,
 *   command: string,
 *   startedAt: string,
 * }} DistLockOwner
 */

/**
 * Whether a process that recorded a lock entry is still running.
 *
 * `EPERM` means the process exists but belongs to another user, which still
 * counts as held. Only `ESRCH` proves the recorded owner is gone.
 *
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return error?.code === "EPERM"
	}
}

/**
 * Read one lock entry.
 *
 * An entry is a single small `writeFileSync`, so an unreadable or unparseable
 * file means the writing process died mid-write rather than that a live owner
 * exists. Such an entry is reported as absent so pruning can remove it; keeping
 * it would block every later run with no way to identify the owner.
 *
 * @param {string} entryPath
 * @returns {DistLockOwner | null}
 */
function readOwner(entryPath) {
	let raw
	try {
		raw = fs.readFileSync(entryPath, "utf8")
	} catch (error) {
		if (error?.code === "ENOENT") return null
		throw error
	}

	try {
		const owner = JSON.parse(raw)
		return Number.isInteger(owner?.pid) ? owner : null
	} catch {
		return null
	}
}

/** @param {string} entryPath */
function removeEntry(entryPath) {
	fs.rmSync(entryPath, { force: true })
}

/**
 * @param {DistLockOwner} owner
 * @returns {string}
 */
function describeOwner(owner) {
	return `pid ${owner.pid}, run '${owner.runId}', command '${owner.command}', started ${owner.startedAt}`
}

/** List reader entries whose owning process is still alive, pruning the rest. */
function collectLiveReaders() {
	/** @type {Array<{ entryPath: string, owner: DistLockOwner }>} */
	const live = []
	let entries
	try {
		entries = fs.readdirSync(READERS_DIR, { withFileTypes: true })
	} catch (error) {
		if (error?.code === "ENOENT") return live
		throw error
	}

	for (const entry of entries) {
		if (!entry.isFile()) continue
		const entryPath = path.join(READERS_DIR, entry.name)
		const owner = readOwner(entryPath)
		if (owner && isProcessAlive(owner.pid)) {
			live.push({ entryPath, owner })
		} else {
			removeEntry(entryPath)
		}
	}
	return live
}

/** Return the live writer entry, pruning it when its process is gone. */
function collectLiveWriter() {
	const owner = readOwner(WRITER_ENTRY_PATH)
	if (!owner) {
		removeEntry(WRITER_ENTRY_PATH)
		return null
	}
	if (isProcessAlive(owner.pid)) return owner
	removeEntry(WRITER_ENTRY_PATH)
	return null
}

/**
 * @param {string} command
 * @returns {DistLockOwner}
 */
function createOwner(command) {
	return {
		pid: process.pid,
		runId: process.env.DLINE_E2E_RUN_ID?.trim() || "unnamed",
		command,
		startedAt: new Date().toISOString(),
	}
}

/**
 * Error raised when another process already holds an incompatible side of the lock.
 *
 * Carrying the blocking owners lets a caller print one actionable message
 * instead of a generic `EEXIST`.
 */
export class DistLockUnavailableError extends Error {
	/**
	 * @param {string} message
	 * @param {DistLockOwner[]} holders
	 */
	constructor(message, holders) {
		super(message)
		this.name = "DistLockUnavailableError"
		this.holders = holders
	}
}

function ensureLockDirectories() {
	fs.mkdirSync(READERS_DIR, { recursive: true })
}

/**
 * Remove the lock directories once they are empty.
 *
 * Leaving them behind is harmless, but an empty `.e2e-lock` directory inside
 * `dist/` invites the question of whether a run is still active.
 */
function removeEmptyLockDirectories() {
	for (const directory of [READERS_DIR, DIST_LOCK_ROOT]) {
		try {
			fs.rmdirSync(directory)
		} catch {
			// A concurrent holder still owns an entry, which is the normal case.
			return
		}
	}
}

/**
 * Build an idempotent release for one acquired entry.
 *
 * @param {string} entryPath
 * @returns {() => void}
 */
function createRelease(entryPath) {
	let released = false
	return () => {
		if (released) return
		released = true
		removeEntry(entryPath)
		removeEmptyLockDirectories()
	}
}

/**
 * Take the exclusive side of the lock for a build that rewrites `dist/`.
 *
 * @param {string} command Human-readable command, reported to a blocked caller.
 * @returns {() => void} Idempotent release.
 * @throws {DistLockUnavailableError} When another build or any test run holds the lock.
 */
export function acquireExclusiveDistLock(command) {
	ensureLockDirectories()

	const existingWriter = collectLiveWriter()
	if (existingWriter) {
		throw new DistLockUnavailableError(
			`Another build owns dist/ (${describeOwner(existingWriter)}). Wait for it to finish, then retry.`,
			[existingWriter],
		)
	}

	const owner = createOwner(command)
	try {
		fs.writeFileSync(WRITER_ENTRY_PATH, `${JSON.stringify(owner)}\n`, { flag: "wx" })
	} catch (error) {
		if (error?.code !== "EEXIST") throw error
		const raced = collectLiveWriter()
		throw new DistLockUnavailableError(
			raced
				? `Another build claimed dist/ first (${describeOwner(raced)}). Wait for it to finish, then retry.`
				: "Another build claimed dist/ first. Retry the command.",
			raced ? [raced] : [],
		)
	}

	// Claim first, then check readers. A reader that starts concurrently sees
	// this entry and backs off, so at most one side survives the race.
	const readers = collectLiveReaders()
	if (readers.length > 0) {
		removeEntry(WRITER_ENTRY_PATH)
		const holders = readers.map((reader) => reader.owner)
		throw new DistLockUnavailableError(
			`${holders.length} E2E test run(s) are still reading dist/:\n` +
				`${holders.map((holder) => `  - ${describeOwner(holder)}`).join("\n")}\n` +
				"Rebuilding now would swap the extension bundle underneath them. Wait for them to finish, then retry.",
			holders,
		)
	}

	return createRelease(WRITER_ENTRY_PATH)
}

/**
 * Take the shared side of the lock for a test run that reads `dist/`.
 *
 * Several test runs may hold this side at once, which is what allows one
 * prepared build to serve concurrent read-only runs.
 *
 * @param {string} command Human-readable command, reported to a blocked caller.
 * @returns {() => void} Idempotent release.
 * @throws {DistLockUnavailableError} When a build currently owns `dist/`.
 */
export function acquireSharedDistLock(command) {
	ensureLockDirectories()

	const blockingWriter = collectLiveWriter()
	if (blockingWriter) {
		throw new DistLockUnavailableError(
			`A build currently owns dist/ (${describeOwner(blockingWriter)}). Wait for it to finish, then retry.`,
			[blockingWriter],
		)
	}

	const owner = createOwner(command)
	const entryPath = path.join(READERS_DIR, `${owner.runId}-${owner.pid}.json`)
	fs.writeFileSync(entryPath, `${JSON.stringify(owner)}\n`)

	// A build may have claimed the writer entry between the check above and this
	// write. Re-check and yield, so a build never proceeds believing dist/ is idle.
	const racedWriter = collectLiveWriter()
	if (racedWriter) {
		removeEntry(entryPath)
		removeEmptyLockDirectories()
		throw new DistLockUnavailableError(
			`A build claimed dist/ first (${describeOwner(racedWriter)}). Wait for it to finish, then retry.`,
			[racedWriter],
		)
	}

	return createRelease(entryPath)
}

/**
 * Acquire the side of the lock matching `mode`.
 *
 * @param {typeof EXCLUSIVE_MODE | typeof SHARED_MODE} mode
 * @param {string} command
 * @returns {() => void}
 */
export function acquireDistLock(mode, command) {
	if (mode === EXCLUSIVE_MODE) return acquireExclusiveDistLock(command)
	if (mode === SHARED_MODE) return acquireSharedDistLock(command)
	throw new Error(`Unsupported dist lock mode '${mode ?? ""}'.`)
}

/**
 * Report the current holders without acquiring anything.
 *
 * Stale entries are pruned as a side effect, which is what makes a crashed run
 * recoverable without manual cleanup.
 *
 * @returns {{ writer: DistLockOwner | null, readers: DistLockOwner[] }}
 */
export function inspectDistLock() {
	ensureLockDirectories()
	const writer = collectLiveWriter()
	const readers = collectLiveReaders().map((reader) => reader.owner)
	removeEmptyLockDirectories()
	return { writer, readers }
}
