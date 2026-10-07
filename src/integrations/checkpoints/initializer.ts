import type { ICheckpointManager } from "@integrations/checkpoints/types"
import pTimeout from "p-timeout"

export const CHECKPOINT_INITIALIZATION_TOTAL_TIMEOUT_MS = 120_000
export const CHECKPOINT_TRACKER_ATTEMPT_TIMEOUT_MS = 55_000

/** Ensures the task checkpoint owner has initialized its tracker within a bounded time. */
export async function ensureCheckpointInitialized({
	checkpointManager,
	timeoutMs = CHECKPOINT_INITIALIZATION_TOTAL_TIMEOUT_MS,
	timeoutMessage = "Checkpoints taking too long to initialize. Consider re-opening Dline in a project that uses git, or disabling checkpoints.",
}: {
	checkpointManager: ICheckpointManager | undefined
	timeoutMs?: number
	timeoutMessage?: string
}): Promise<void> {
	if (!checkpointManager) {
		return
	}
	const maybeInit = checkpointManager.checkpointTrackerCheckAndInit
	if (typeof maybeInit === "function") {
		await pTimeout(maybeInit.call(checkpointManager), {
			milliseconds: timeoutMs,
			message: timeoutMessage,
		})
	}
}
