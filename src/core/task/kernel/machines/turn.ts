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
): Pick<TurnSlice, "manualApprovalBlockIds" | "automaticApprovalBlockIds" | "executingBlockIds"> {
	return {
		manualApprovalBlockIds: state.manualApprovalBlockIds.filter((id) => id !== blockId),
		automaticApprovalBlockIds: state.automaticApprovalBlockIds.filter((id) => id !== blockId),
		executingBlockIds: state.executingBlockIds.filter((id) => id !== blockId),
	}
}

export function reduceTurn(state: TurnSlice, event: TaskEvent): TurnReduction {
	if (event.type === "provider.turn_ready") {
		const blocks: readonly KernelBlock[] = event.turnPlan.blocks.map((block) => ({
			blockId: block.blockId,
			index: block.index,
			phase:
				block.approval.kind === "manual"
					? "awaiting_approval"
					: block.approval.kind === "automatic"
						? "pending"
						: "ready",
			attempt: block.attempt,
			lanes: block.lanes,
			turnEnding: block.turnEnding,
			invocationRef: block.invocationRef,
		}))
		return {
			state: {
				turnId: event.turnId,
				mode: event.turnPlan.mode,
				blocks,
				manualApprovalBlockIds: event.turnPlan.blocks
					.filter((block) => block.approval.kind === "manual")
					.map((block) => block.blockId),
				automaticApprovalBlockIds: [],
				executingBlockIds: [],
			},
			commands: [],
		}
	}
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
				manualApprovalBlockIds: Array.from(new Set([...state.manualApprovalBlockIds, event.blockId])),
			},
			commands: [],
		}
	}
	if (event.type === "approval.responded") {
		if (state.turnId !== event.turnId || !state.manualApprovalBlockIds.includes(event.blockId)) return { state, commands: [] }
		const decidedBlocks = event.approved
			? replaceBlock(state.blocks, event.blockId, "ready")
			: rejectAndSkipLater(state.blocks, event.blockId)
		const terminalized = new Set(
			decidedBlocks
				.filter((block) => block.phase === "rejected" || block.phase === "skipped")
				.map((block) => block.blockId),
		)
		terminalized.add(event.blockId)
		return {
			state: {
				...state,
				blocks: decidedBlocks.map((block) =>
					terminalized.has(block.blockId) && block.policy?.status === "running"
						? { ...block, policy: { ...block.policy, status: "cancelled" as const } }
						: block,
				),
				manualApprovalBlockIds: state.manualApprovalBlockIds.filter((id) => !terminalized.has(id)),
				automaticApprovalBlockIds: state.automaticApprovalBlockIds.filter((id) => !terminalized.has(id)),
			},
			commands: [],
		}
	}
	if (event.type === "approval.evaluated" || event.type === "approval.failed") {
		return {
			state: {
				...state,
				blocks: state.blocks.map((block) => {
					if (block.blockId !== event.blockId) return block
					if (event.type === "approval.failed")
						return { ...block, policy: block.policy && { ...block.policy, status: "failed" as const } }
					return {
						...block,
						phase: event.approved ? ("ready" as const) : ("rejected" as const),
						policy: block.policy && { ...block.policy, status: "completed" as const },
					}
				}),
				manualApprovalBlockIds:
					event.type === "approval.evaluated"
						? state.manualApprovalBlockIds.filter((id) => id !== event.blockId)
						: state.manualApprovalBlockIds,
				automaticApprovalBlockIds:
					event.type === "approval.evaluated" && event.approved
						? Array.from(new Set([...state.automaticApprovalBlockIds, event.blockId]))
						: state.automaticApprovalBlockIds.filter((id) => id !== event.blockId),
			},
			commands: [],
		}
	}
	return { state, commands: [] }
}
