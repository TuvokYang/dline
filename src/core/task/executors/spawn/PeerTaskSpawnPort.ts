import type { Mode } from "@shared/storage/types"

/** Host-owned peer-task launch used by the admitted `spawn_task` handler. */
export interface PeerTaskSpawnPort {
	spawn(input: {
		readonly task: string
		readonly mode: Mode
		readonly profile: string
		readonly context?: string
		readonly signal: AbortSignal
	}): Promise<{ readonly childTaskId: string }>
}
