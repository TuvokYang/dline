import type { TaskLockStatus as CoreTaskLockStatus, TaskLockService } from "@core/locks/TaskLockService"
import { TaskLockStatus } from "@shared/proto/dline/task"
import { Logger } from "@shared/services/Logger"
import type { HistoryDisplaySession } from "./HistoryDisplaySession"

export interface HistoryTaskLockPreflight {
	readonly ownerless: boolean
	readonly foreignLock?: CoreTaskLockStatus
}

/** Resolve stale-lock expiry before a historical surface becomes interactive. */
export async function inspectHistoryTaskLock(lockService: TaskLockService, taskId: string): Promise<HistoryTaskLockPreflight> {
	try {
		const status = await lockService.checkTaskLock(taskId)
		const foreign = status.isLocked && status.lockedBy !== lockService.instanceAddress
		return foreign ? { ownerless: false, foreignLock: status } : { ownerless: true }
	} catch (error) {
		// A lock read failure cannot grant write ownership. Fail closed until the
		// explicit lock RPC can establish that the task is available.
		Logger.error(`[History] Failed to inspect task lock for ${taskId}:`, error)
		return {
			ownerless: false,
			foreignLock: { isLocked: true, lockedBy: "unknown", lockedAt: Date.now(), isStale: false },
		}
	}
}

/** Preserve the real holder and timestamp in the Webview lock projection. */
export function projectHistoryTaskLockStatus(session: HistoryDisplaySession | undefined): TaskLockStatus | undefined {
	const status = session?.getLockStatus()
	return status?.isLocked
		? TaskLockStatus.create({
				isLocked: true,
				lockedBy: status.lockedBy,
				lockedAt: status.lockedAt,
				isStale: status.isStale,
			})
		: undefined
}
