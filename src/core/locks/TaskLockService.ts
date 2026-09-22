import { constants } from "fs"
import fs from "fs/promises"
import path from "path"
import { Logger } from "@/shared/services/Logger"

/**
 * Time-to-live for a lock file before it is considered stale (5 minutes).
 */
const LOCK_TTL_MS = 5 * 60 * 1000

/**
 * Structure stored in .lock JSON files.
 */
interface LockData {
	held_by: string
	locked_at: number
	pid: number
}

/**
 * Status returned when checking a task lock.
 */
export interface TaskLockStatus {
	isLocked: boolean
	lockedBy?: string
	lockedAt?: number
	isStale: boolean
}

/**
 * File-based lock service.
 * Each task gets a .lock file inside its task directory:
 *   {tasksBasePath}/{taskId}/.lock
 */
export class TaskLockService {
	private pid: number
	private tasksBasePath: string

	constructor(
		tasksBasePath: string,
		/** Identity written into lock files, so callers can tell own locks from foreign ones. */
		readonly instanceAddress: string,
	) {
		this.tasksBasePath = tasksBasePath
		this.pid = process.pid
	}

	private lockFilePath(taskId: string): string {
		return path.join(this.tasksBasePath, taskId, ".lock")
	}

	private async readLockFile(taskId: string): Promise<LockData | null> {
		try {
			const raw = await fs.readFile(this.lockFilePath(taskId), "utf-8")
			return JSON.parse(raw) as LockData
		} catch {
			return null
		}
	}

	private async writeLockFile(taskId: string): Promise<boolean> {
		const data: LockData = {
			held_by: this.instanceAddress,
			locked_at: Date.now(),
			pid: this.pid,
		}
		try {
			await fs.mkdir(path.dirname(this.lockFilePath(taskId)), { recursive: true })
			await fs.writeFile(this.lockFilePath(taskId), JSON.stringify(data), {
				flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
			})
			return true
		} catch (err: any) {
			if (err.code === "EEXIST") return false
			throw err
		}
	}

	// ──────── public API ────────

	async checkTaskLock(taskId: string): Promise<TaskLockStatus> {
		const data = await this.readLockFile(taskId)
		if (!data) return { isLocked: false, isStale: false }

		const isStale = Date.now() - data.locked_at > LOCK_TTL_MS
		if (isStale) {
			await this.releaseTaskLock(taskId)
			Logger.debug(`[Lock] Released stale lock for task ${taskId}`)
			return { isLocked: false, isStale: true }
		}

		return {
			isLocked: true,
			lockedBy: data.held_by,
			lockedAt: data.locked_at,
			isStale: false,
		}
	}

	async acquireTaskLock(taskId: string): Promise<boolean> {
		const existing = await this.checkTaskLock(taskId)
		if (existing.isLocked && existing.lockedBy !== this.instanceAddress) {
			Logger.warn(`[Lock] Task ${taskId} locked by ${existing.lockedBy}`)
			return false
		}
		if (existing.isLocked && existing.lockedBy === this.instanceAddress) {
			return true
		}

		const created = await this.writeLockFile(taskId)
		if (created) {
			Logger.debug(`[Lock] Acquired for task ${taskId}`)
			return true
		}

		const data = await this.readLockFile(taskId)
		if (data?.held_by === this.instanceAddress) return true

		Logger.debug(`[Lock] Task ${taskId} locked by another instance`)
		return false
	}

	async releaseTaskLock(taskId: string): Promise<void> {
		try {
			await fs.rm(this.lockFilePath(taskId), { force: true })
			Logger.debug(`[Lock] Released for task ${taskId}`)
		} catch (error) {
			Logger.error(`[Lock] Failed to release for task ${taskId}:`, error)
		}
	}

	/**
	 * Refresh the locked_at timestamp on the lock file to prevent TTL expiry.
	 * Called periodically (e.g. every 60 s) while the task is active.
	 * Returns false if the lock file is missing or held by another instance.
	 */
	async touchTaskLock(taskId: string): Promise<boolean> {
		const data = await this.readLockFile(taskId)
		if (!data || data.held_by !== this.instanceAddress) {
			Logger.warn(`[Lock] Cannot touch - lock lost for task ${taskId}`)
			return false
		}
		data.locked_at = Date.now()
		try {
			await fs.writeFile(this.lockFilePath(taskId), JSON.stringify(data))
			return true
		} catch (error) {
			Logger.error(`[Lock] Failed to touch lock for task ${taskId}:`, error)
			return false
		}
	}

	/**
	 * Force-release the lock for a task regardless of who holds it.
	 * Used by the "Force Unlock" button in the UI when the current
	 * instance wants to take over a locked task.
	 * After calling this, the caller should call acquireTaskLock.
	 */
	async forceReleaseTaskLock(taskId: string): Promise<void> {
		await this.releaseTaskLock(taskId)
		Logger.debug(`[Lock] Force-released lock for task ${taskId}`)
	}

	async cleanupOrphaned(): Promise<void> {
		try {
			const entries = await fs.readdir(this.tasksBasePath, { withFileTypes: true })
			let cleaned = 0
			for (const entry of entries) {
				if (!entry.isDirectory()) continue
				const lp = path.join(this.tasksBasePath, entry.name, ".lock")
				try {
					const raw = await fs.readFile(lp, "utf-8")
					const data = JSON.parse(raw) as LockData
					if (Date.now() - data.locked_at > LOCK_TTL_MS) {
						await fs.rm(lp, { force: true })
						cleaned++
					}
				} catch {
					/* file may not exist */
				}
			}
			if (cleaned > 0) Logger.debug(`[Lock] Cleaned ${cleaned} stale lock(s)`)
		} catch {
			/* tasks dir may not exist */
		}
	}
}
