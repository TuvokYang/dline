import type { TaskState } from "../types"

/**
 * Settle the blocks a terminate left running and keep a completion that was already shown.
 *
 * Nothing can settle them later: executor feedback carries the generation the
 * halt replaced, and a terminated task rejects every further event. A block
 * that had put its completion on screen ends the task finished rather than
 * interrupted, because the user already saw the result; the completion it
 * would have offered becomes the task's dialog, as if its request had landed.
 */
export function settleTerminatedTurn(state: TaskState, revision: number): TaskState {
	const executing = new Set(state.turn.executingBlockIds)
	for (const block of state.turn.blocks) if (block.phase === "executing") executing.add(block.blockId)
	if (executing.size === 0) return state
	const presented = state.turn.blocks.filter((block) => executing.has(block.blockId) && block.presentedCompletion)
	const completion = presented.length === 1 ? presented[0] : undefined
	const turnId = state.turn.turnId
	return {
		...state,
		turn: {
			...state.turn,
			blocks: state.turn.blocks.map((block) =>
				executing.has(block.blockId) ? { ...block, phase: "cancelled" as const } : block,
			),
			executingBlockIds: [],
			automaticApprovalBlockIds: state.turn.automaticApprovalBlockIds.filter((blockId) => !executing.has(blockId)),
		},
		dialog:
			completion?.presentedCompletion && turnId && !state.dialog.primary
				? {
						...state.dialog,
						primary: {
							interactionId: completion.blockId,
							turnId,
							kind: "completion",
							status: "planned",
							createdRevision: revision,
							presentationRef: completion.presentedCompletion.presentationRef,
							actionRules: completion.presentedCompletion.actionRules,
							prepareKey: `dialog.prepare:${completion.blockId}`,
						},
					}
				: state.dialog,
	}
}
