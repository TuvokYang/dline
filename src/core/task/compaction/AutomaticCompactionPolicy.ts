import { shouldCompactProjectedUsage } from "@core/context/context-management/context-window-utils"
import type { TaskState } from "../kernel"

/** What the task knows about the context window when a request settles. */
export interface CompactionPressure {
	/** Tokens the last request actually occupied. */
	readonly contextTokens: number
	/** Tokens at which the conversation should be compacted. */
	readonly compactTriggerTokens: number
}

/**
 * Whether the observed pressure should schedule an automatic compaction.
 *
 * Compaction is decided from the usage a request reported, so it can only be
 * judged after a request settles. The comparison is the shared projected-usage
 * rule, which keeps the estimation tolerance below the trigger exactly as the
 * ordinary request guard does. A run already scheduled or in flight owns the
 * next summary, and a halting or finished task has no next request to protect,
 * so neither case starts another one.
 */
export function shouldCompactAutomatically(state: TaskState, pressure: CompactionPressure): boolean {
	if (pressure.compactTriggerTokens <= 0) return false
	if (!shouldCompactProjectedUsage(pressure.contextTokens, pressure.compactTriggerTokens)) return false
	if (state.halt.status === "stopping") return false
	if (["paused", "terminated", "completed", "error"].includes(state.flow.phase)) return false
	return !isCompactionInFlight(state)
}

/** Whether a compaction run already owns the next summary. */
function isCompactionInFlight(state: TaskState): boolean {
	const status = state.flow.compaction?.status
	return status === "scheduled" || status === "running"
}
