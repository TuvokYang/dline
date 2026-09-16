import type { AssistantMessageContent, ToolUse } from "@core/assistant-message"
import type { ClineAssistantToolUseBlock } from "@/shared/messages"
import { ClineDefaultTool } from "@/shared/tools"

/**
 * Single source of turn-ending tool identity.
 *
 * A turn-ending tool hands control back to the user, so it must never be
 * offered as an ordinary selectable capability and must never run alongside
 * another turn-ending tool. Consumers import this set instead of restating it;
 * a second literal list is how the selection UI drifted from execution.
 */
export const TURN_ENDING_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
	ClineDefaultTool.ATTEMPT,
	ClineDefaultTool.ASK,
	ClineDefaultTool.MAKE_PLAN,
	ClineDefaultTool.QNA_RESPOND,
	ClineDefaultTool.GENERATE_REPORT,
	ClineDefaultTool.NEW_TASK,
])

export function isTurnEndingToolName(name?: string): boolean {
	return typeof name === "string" && TURN_ENDING_TOOL_NAMES.has(name)
}

export function isTurnEndingToolUse(block: AssistantMessageContent): block is ToolUse {
	return block.type === "tool_use" && isTurnEndingToolName(block.name)
}

export function orderTurnEndingContentBlocks<T extends AssistantMessageContent>(blocks: T[]): T[] {
	return orderTurnEndingBlocksLast(blocks, (block) => isTurnEndingToolUse(block))
}

export function orderTurnEndingNativeToolBlocks<T extends ClineAssistantToolUseBlock>(blocks: T[]): T[] {
	return orderTurnEndingBlocksLast(blocks, (block) => isTurnEndingToolName(block.name))
}

function orderTurnEndingBlocksLast<T>(blocks: T[], isTurnEnding: (block: T) => boolean): T[] {
	let sawTurnEnding = false
	let needsReorder = false
	const regularBlocks: T[] = []
	const turnEndingBlocks: T[] = []

	for (const block of blocks) {
		if (isTurnEnding(block)) {
			sawTurnEnding = true
			turnEndingBlocks.push(block)
			continue
		}

		if (sawTurnEnding) {
			needsReorder = true
		}
		regularBlocks.push(block)
	}

	if (!needsReorder) {
		return blocks
	}

	return [...regularBlocks, ...turnEndingBlocks]
}
