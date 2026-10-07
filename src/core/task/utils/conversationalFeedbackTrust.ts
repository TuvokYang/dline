import { type ClineDefaultTool, CONVERSATIONAL_TOOL_NAMES } from "@shared/tools"
import type { ClineStorageMessage, ClineUserToolResultContentBlock } from "@/shared/messages"

interface ToolUseIdentity {
	type: string
	name?: string
	function_id?: string
	dline_tid?: string
}

function answersConversationalToolUse(block: ClineUserToolResultContentBlock, candidate: ToolUseIdentity): boolean {
	return (
		candidate.type === "tool_use" &&
		candidate.function_id === block.function_id &&
		candidate.dline_tid === block.dline_tid &&
		CONVERSATIONAL_TOOL_NAMES.has(candidate.name as ClineDefaultTool)
	)
}

function latestAssistantContent(history: readonly ClineStorageMessage[]): readonly ToolUseIdentity[] {
	for (let index = history.length - 1; index >= 0; index--) {
		const message = history[index]
		if (message.role !== "assistant") continue
		return Array.isArray(message.content) ? (message.content as ToolUseIdentity[]) : []
	}
	return []
}

/**
 * Whether a tool result carries the user's own reply to a conversational tool (completion, follow-up,
 * plan, Q&A, report, status update), and may therefore be parsed for slash commands and mentions.
 *
 * The live assistant content only exists while the producing stream is in memory, so the persisted
 * assistant message that the result answers is consulted as well. Pairing still requires the canonical
 * `function_id` and `dline_tid`, so a result can never borrow trust from an unrelated tool call.
 */
export function isConversationalFeedbackResult(
	block: ClineUserToolResultContentBlock,
	liveAssistantContent: readonly ToolUseIdentity[],
	apiHistory: readonly ClineStorageMessage[],
): boolean {
	return (
		liveAssistantContent.some((candidate) => answersConversationalToolUse(block, candidate)) ||
		latestAssistantContent(apiHistory).some((candidate) => answersConversationalToolUse(block, candidate))
	)
}
