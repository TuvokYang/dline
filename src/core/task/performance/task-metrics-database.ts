import { access, rename } from "node:fs/promises"
import path from "node:path"
import { GlobalFileNames } from "@core/storage/disk"
import { InstanceDatabase } from "@core/storage/instance/InstanceLayout"
import { ensureInstanceLayout, resolveInstanceLayout } from "@core/storage/instance/InstanceStorage"
import { Logger } from "@shared/services/Logger"

/** Files SQLite keeps beside a database; they belong to it and move with it. */
const SQLITE_SIDE_FILES = ["-wal", "-shm"] as const

/** One move per task root in this process, so concurrent openers never race the rename. */
const moves = new Map<string, Promise<string>>()

/**
 * The task's `metrics.db`, the one database every API metrics collection shares.
 *
 * Builds before the instance layout kept these metrics in `<task-id>.db`. That
 * file is moved into place, with its WAL and shared-memory files, the first time
 * the task's metrics are opened. A move that cannot happen, for example because
 * an older window still holds the file, leaves the metrics where they are and
 * serves them from there: metrics are never worth losing over a file name.
 *
 * @param location an explicit database path, used as is (tests and tools).
 */
export async function resolveTaskMetricsDatabase(taskId: string, location?: string): Promise<string> {
	if (location) return location
	const layout = await ensureInstanceLayout({ taskId })
	const target = layout.database(InstanceDatabase.Metrics)
	let move = moves.get(target)
	if (!move) {
		move = moveLegacyDatabase(path.join(layout.root, GlobalFileNames.legacyTaskDatabase(taskId)), target)
		moves.set(target, move)
		// A failed attempt is not remembered, so the next opener may try again.
		move.then(undefined, () => moves.delete(target))
	}
	return move
}

/**
 * The task's existing metrics database, without creating or moving anything.
 *
 * A history view reads what a past run recorded; it must not lay out a task
 * directory or migrate files for a task nobody is running. A task that never
 * recorded metrics has no database, and the view simply shows none.
 */
export async function findExistingTaskMetricsDatabase(taskId: string): Promise<string | undefined> {
	const layout = await resolveInstanceLayout({ taskId })
	const target = layout.database(InstanceDatabase.Metrics)
	if (await exists(target)) return target
	const legacy = path.join(layout.root, GlobalFileNames.legacyTaskDatabase(taskId))
	return (await exists(legacy)) ? legacy : undefined
}

async function moveLegacyDatabase(legacy: string, target: string): Promise<string> {
	if ((await exists(target)) || !(await exists(legacy))) return target
	try {
		await rename(legacy, target)
	} catch (error) {
		Logger.warn(
			`[metrics] Could not move ${path.basename(legacy)} to ${path.basename(target)}; reading it in place: ${error instanceof Error ? error.message : String(error)}`,
		)
		return legacy
	}
	for (const suffix of SQLITE_SIDE_FILES) {
		if (!(await exists(`${legacy}${suffix}`))) continue
		try {
			await rename(`${legacy}${suffix}`, `${target}${suffix}`)
		} catch (error) {
			Logger.warn(
				`[metrics] Could not move ${path.basename(legacy)}${suffix}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}
	return target
}

async function exists(location: string): Promise<boolean> {
	try {
		await access(location)
		return true
	} catch {
		return false
	}
}
