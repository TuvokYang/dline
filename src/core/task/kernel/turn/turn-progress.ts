import type { TaskEvent, TaskState } from "../types"

/** Block phases after which a block never runs again in its turn. */
export const TERMINAL_BLOCK_PHASES: ReadonlySet<string> = new Set(["completed", "failed", "rejected", "skipped", "cancelled"])

export function hasRunningBlocks(state: TaskState): boolean {
	return state.turn.blocks.some((block) => !TERMINAL_BLOCK_PHASES.has(block.phase))
}

export function allBlocksTerminal(state: TaskState): boolean {
	return state.turn.blocks.length > 0 && state.turn.blocks.every((block) => TERMINAL_BLOCK_PHASES.has(block.phase))
}

export function hasActiveRound(state: TaskState): boolean {
	return state.flow.compose?.status === "running" || state.flow.provider?.status === "running"
}

/** Whether the kernel is free to open the next round itself. */
export function canOpenNextRound(state: TaskState): boolean {
	if (state.halt.status === "stopping") return false
	if (["paused", "terminated", "completed", "error"].includes(state.flow.phase)) return false
	// An awaiting question is the user's turn; continuing would answer over them.
	if (state.dialog.primary) return false
	// A round still in flight already owns the next request.
	return !hasActiveRound(state)
}

/**
 * Whether a human refusal settles the turn and the conversation continues.
 *
 * Refusing the last open block is the same edge as the last tool finishing: the
 * model has to see every block's outcome, the refusal and its feedback included,
 * in the next round. Siblings that already finished do not change that, and a
 * sibling still executing settles the turn itself when it ends. A policy refusal
 * is not a continuation; it hands the task back to the user.
 */
export function refusalContinuesTurn(previous: TaskState, next: TaskState, event: TaskEvent): boolean {
	return (
		event.type === "approval.responded" &&
		!event.approved &&
		!allBlocksTerminal(previous) &&
		allBlocksTerminal(next) &&
		canOpenNextRound(next)
	)
}
