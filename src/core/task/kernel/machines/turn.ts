import type { Command, KernelBlock, TaskEvent, TurnSlice } from "../types"

export interface TurnReduction {
	readonly state: TurnSlice
	readonly commands: readonly Command[]
}

const TERMINAL_PHASES: ReadonlySet<KernelBlock["phase"]> = new Set(["completed", "failed", "rejected", "skipped", "cancelled"])

function replaceBlock(blocks: readonly KernelBlock[], blockId: string, phase: KernelBlock["phase"]): readonly KernelBlock[] {
	return blocks.map((block) => (block.blockId === blockId ? { ...block, phase } : block))
}

function rejectAndSkipLater(blocks: readonly KernelBlock[], blockId: string): readonly KernelBlock[] {
	const rejected = blocks.find((block) => block.blockId === blockId)
	if (!rejected) return blocks
	return blocks.map((block) => {
		if (block.blockId === blockId) return { ...block, phase: "rejected" }
		if (block.index > rejected.index && !TERMINAL_PHASES.has(block.phase) && block.phase !== "executing")
			return { ...block, phase: "skipped" }
		return block
	})
}

function clearOwnership(
	state: TurnSlice,
	blockId: string,
): Pick<TurnSlice, "manualApprovalBlockId" | "automaticApprovalBlockIds" | "executingBlockIds"> {
	return {
		manualApprovalBlockId: state.manualApprovalBlockId === blockId ? undefined : state.manualApprovalBlockId,
		automaticApprovalBlockIds: state.automaticApprovalBlockIds.filter((id) => id !== blockId),
		executingBlockIds: state.executingBlockIds.filter((id) => id !== blockId),
	}
}

export function reduceTurn(state: TurnSlice, event: TaskEvent): TurnReduction {
	if (
		event.type === "tool.started" ||
		event.type === "tool.completed" ||
		event.type === "tool.failed" ||
		event.type === "tool.cancelled"
	) {
		if (
			state.turnId !== event.turnId ||
			!state.blocks.some((block) => block.blockId === event.blockId && block.attempt === event.attempt)
		)
			return { state, commands: [] }
		if (event.type === "tool.started") {
			return {
				state: {
					...state,
					blocks: replaceBlock(state.blocks, event.blockId, "executing"),
					executingBlockIds: Array.from(new Set([...state.executingBlockIds, event.blockId])),
				},
				commands: [],
			}
		}
		const phase = event.type === "tool.completed" ? "completed" : event.type === "tool.cancelled" ? "cancelled" : "failed"
		return {
			state: {
				...state,
				blocks: replaceBlock(state.blocks, event.blockId, phase),
				...clearOwnership(state, event.blockId),
			},
			commands: [],
		}
	}
	if (event.type === "approval.requested") {
		if (state.turnId !== event.turnId) return { state, commands: [] }
		return {
			state: {
				...state,
				blocks: replaceBlock(state.blocks, event.blockId, "awaiting_approval"),
				manualApprovalBlockId: event.blockId,
			},
			commands: [],
		}
	}
	if (event.type === "approval.responded") {
		if (state.turnId !== event.turnId || state.manualApprovalBlockId !== event.blockId) return { state, commands: [] }
		return {
			state: {
				...state,
				blocks: event.approved
					? replaceBlock(state.blocks, event.blockId, "ready")
					: rejectAndSkipLater(state.blocks, event.blockId),
				manualApprovalBlockId: undefined,
				automaticApprovalBlockIds: state.automaticApprovalBlockIds.filter((id) => id !== event.blockId),
			},
			commands: [],
		}
	}
	if (event.type === "approval.evaluated") {
		return {
			state: {
				...state,
				blocks: replaceBlock(state.blocks, event.blockId, event.approved ? "ready" : "rejected"),
				automaticApprovalBlockIds: event.approved
					? Array.from(new Set([...state.automaticApprovalBlockIds, event.blockId]))
					: state.automaticApprovalBlockIds.filter((id) => id !== event.blockId),
			},
			commands: [],
		}
	}
	return { state, commands: [] }
}
