import { access, mkdir, rename } from "node:fs/promises"
import path from "node:path"
import { Logger } from "@shared/services/Logger"
import { FileLock } from "./backend/jsonl/FileLock"
import { getDlineDocumentsPath } from "./documents-path"

export const TASK_METRICS_DATABASE_NAME = "metrics.db"
const SQLITE_SIDE_FILES = ["-wal", "-shm"] as const
const pendingMoves = new Map<string, Promise<string>>()

/** Resolve one metrics container; explicit locations are unchanged for existing storage consumers. */
export async function resolveTaskMetricsDatabase(taskId: string, location?: string, readOnly = false): Promise<string> {
	if (location) return location
	if (!taskId || path.basename(taskId) !== taskId || taskId === "." || taskId === ".." || /[\\/]/.test(taskId)) {
		throw new Error("Invalid Task metrics identity")
	}
	const directory = path.join(await getDlineDocumentsPath(), "tasks", taskId)
	const target = path.join(directory, TASK_METRICS_DATABASE_NAME)
	const key = process.platform === "win32" ? target.toLowerCase() : target
	if (readOnly) {
		await pendingMoves.get(key)
		await FileLock.waitUntilUnlocked(target)
		const legacy = path.join(directory, `${taskId}.db`)
		if (!(await exists(target))) return legacy
		if (!(await exists(legacy)) && (await hasLegacySideFiles(legacy))) {
			throw new Error("Task metrics move is incomplete; writable recovery is required")
		}
		return target
	}
	let pending = pendingMoves.get(key)
	if (!pending) {
		pending = moveLegacyDatabase(directory, taskId, target)
		pendingMoves.set(key, pending)
		void pending.then(
			() => pendingMoves.delete(key),
			() => pendingMoves.delete(key),
		)
	}
	return pending
}

async function moveLegacyDatabase(directory: string, taskId: string, target: string): Promise<string> {
	await mkdir(directory, { recursive: true })
	return new FileLock().withLock(target, () => moveDatabaseFiles(directory, taskId, target))
}

async function moveDatabaseFiles(directory: string, taskId: string, target: string): Promise<string> {
	const legacy = path.join(directory, `${taskId}.db`)
	const legacyExists = await exists(legacy)
	const targetExists = await exists(target)
	const recovering = targetExists && !legacyExists && (await hasLegacySideFiles(legacy))
	if ((targetExists && !recovering) || (!legacyExists && !recovering)) return target
	const moved: Array<{ source: string; destination: string }> = []
	try {
		for (const suffix of ["", ...SQLITE_SIDE_FILES]) {
			const source = `${legacy}${suffix}`
			const destination = `${target}${suffix}`
			if (!(await exists(source))) continue
			if (await exists(destination)) throw new Error("Task metrics destination already exists")
			await rename(source, destination)
			moved.push({ source, destination })
		}
		return target
	} catch (error) {
		// A sidecar failure must not leave the database split between two names.
		const rollbackErrors: unknown[] = []
		for (const { source, destination } of moved.reverse()) {
			try {
				await rename(destination, source)
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError)
			}
		}
		if (rollbackErrors.length > 0) {
			throw new AggregateError([error, ...rollbackErrors], `Task metrics move could not be restored for ${taskId}`)
		}
		if (recovering) throw new Error("Task metrics move could not be recovered", { cause: error })
		Logger.warn(`[Task ${taskId}] Metrics database rename deferred; keeping the existing container`, error)
		return legacy
	}
}

async function hasLegacySideFiles(legacy: string): Promise<boolean> {
	for (const suffix of SQLITE_SIDE_FILES) {
		if (await exists(`${legacy}${suffix}`)) return true
	}
	return false
}

async function exists(location: string): Promise<boolean> {
	try {
		await access(location)
		return true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
		throw error
	}
}
