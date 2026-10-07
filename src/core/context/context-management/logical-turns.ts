import { USER_CONTENT_TAGS } from "@shared/messages/constants"
import type { ClineAssistantToolUseBlock, ClineStorageMessage, ClineUserToolResultContentBlock } from "@shared/messages/content"
import { ClineDefaultTool, CONVERSATIONAL_TOOL_NAMES } from "@shared/tools"

export type LogicalTurnIssueKind = "orphan_tool_result" | "unpaired_tool_use"

export interface LogicalTurnIssue {
	kind: LogicalTurnIssueKind
	messageIndex: number
	functionId: string
}

export interface LogicalTurnSpan {
	readonly id: string
	readonly startMessageIndex: number
	readonly endMessageIndex: number
	readonly functionIds: readonly string[]
}

export interface LogicalTurnIndex {
	readonly turns: readonly LogicalTurnSpan[]
	readonly protectedStartMessageIndex: number
	readonly issues: readonly LogicalTurnIssue[]
}

/** Index canonical messages into pairing-safe complete turns and an uncommittable protected tail. */
export function indexLogicalTurns(history: readonly ClineStorageMessage[]): LogicalTurnIndex {
	const turns: LogicalTurnSpan[] = []
	const issues: LogicalTurnIssue[] = []
	let turnStart: number | undefined
	let protectedStartIndex = history.length
	let boundaryBeforeNext = false
	let hasAssistantResponse = false
	let hasCompletedToolResult = false
	const openToolUses = new Map<string, { messageIndex: number; toolName: string }>()
	const turnFunctionIds: string[] = []

	const resetTurn = (start: number | undefined): void => {
		turnStart = start
		boundaryBeforeNext = false
		hasAssistantResponse = false
		hasCompletedToolResult = false
		openToolUses.clear()
		turnFunctionIds.length = 0
	}

	const finalizeTurn = (endIndex: number): void => {
		if (turnStart === undefined || endIndex < turnStart) return
		turns.push({
			id: createLogicalTurnId(turnStart, endIndex, turnFunctionIds),
			startMessageIndex: turnStart,
			endMessageIndex: endIndex,
			functionIds: [...turnFunctionIds],
		})
		resetTurn(undefined)
	}

	for (let messageIndex = 0; messageIndex < history.length; messageIndex++) {
		const message = history[messageIndex]
		if (boundaryBeforeNext && turnStart !== undefined) {
			finalizeTurn(messageIndex - 1)
		}

		const userAuthored = message.role === "user" && hasUserAuthoredContent(message)
		const results = getToolResults(message)
		const uses = getToolUses(message)

		if (turnStart === undefined) {
			if (!userAuthored && message.role !== "assistant") {
				protectedStartIndex = messageIndex
				break
			}
			turnStart = messageIndex
		}

		if (userAuthored && results.length === 0 && messageIndex > turnStart) {
			if (openToolUses.size > 0) {
				protectedStartIndex = turnStart
				break
			}
			finalizeTurn(messageIndex - 1)
			turnStart = messageIndex
		}

		if (message.role === "assistant") {
			if (uses.length > 0 && hasCompletedToolResult && turnStart !== undefined && messageIndex > turnStart) {
				finalizeTurn(messageIndex - 1)
				turnStart = messageIndex
			}
			hasAssistantResponse = true
		}
		for (const use of uses) {
			openToolUses.set(use.function_id, { messageIndex, toolName: use.name })
			if (!turnFunctionIds.includes(use.function_id)) turnFunctionIds.push(use.function_id)
		}

		const taggedResult = results.find((result) => {
			const matchingUse = openToolUses.get(result.function_id)
			return (
				matchingUse !== undefined &&
				CONVERSATIONAL_TOOL_NAMES.has(matchingUse.toolName as ClineDefaultTool) &&
				hasTaggedUserFeedback(result)
			)
		})
		if (taggedResult) {
			// A tagged tool result is the user's reply to a conversational tool
			// (qna_respond, make_plan, followup, generate_report, attempt_completion
			// feedback). It closes the current round and starts a new user-authored
			// round: folding it into the previous round would let the first
			// compaction Pass swallow the user's latest reply, which the target
			// contract explicitly forbids. The previous round may therefore end
			// with an unpaired conversational tool_use; that pairing resumes when
			// the user's reply round is eventually committed.
			if (turnStart !== undefined && hasAssistantResponse && messageIndex > turnStart) {
				finalizeTurn(messageIndex - 1)
			}
			resetTurn(messageIndex)
			turnStart = messageIndex
			turnFunctionIds.push(taggedResult.function_id)
			openToolUses.delete(taggedResult.function_id)
			boundaryBeforeNext = false
			hasAssistantResponse = false
			continue
		}

		for (const result of results) {
			if (!openToolUses.has(result.function_id)) {
				if (turnStart !== undefined && hasAssistantResponse && openToolUses.size === 0 && messageIndex > turnStart) {
					finalizeTurn(messageIndex - 1)
				}
				issues.push({ kind: "orphan_tool_result", messageIndex, functionId: result.function_id })
				protectedStartIndex = turnStart ?? messageIndex
				return buildIndex(turns, protectedStartIndex, issues)
			}
			openToolUses.delete(result.function_id)
			hasCompletedToolResult = true
		}

		if (openToolUses.size === 0) {
			boundaryBeforeNext = false
		}
	}

	if (protectedStartIndex === history.length && turnStart !== undefined) {
		if (openToolUses.size > 0) {
			for (const [functionId, openUse] of openToolUses) {
				issues.push({ kind: "unpaired_tool_use", messageIndex: openUse.messageIndex, functionId })
			}
			protectedStartIndex = turnStart
		} else if (hasAssistantResponse) {
			// A turn with an assistant response is complete once every tool use is
			// paired, even when its final message is a plain tool result rather than
			// assistant text or tagged feedback. The old trailing condition only
			// closed turns ending in an assistant message or feedback tags, so a
			// turn like [user, tool_use, tool_result] was misclassified as a
			// protected tail and left the compaction source without any complete
			// logical turn.
			finalizeTurn(history.length - 1)
		} else {
			protectedStartIndex = turnStart
		}
	}

	return buildIndex(turns, protectedStartIndex, issues)
}

function buildIndex(turns: LogicalTurnSpan[], protectedStartIndex: number, issues: LogicalTurnIssue[]): LogicalTurnIndex {
	return {
		turns,
		protectedStartMessageIndex: protectedStartIndex,
		issues,
	}
}

function createLogicalTurnId(startMessageIndex: number, endMessageIndex: number, functionIds: readonly string[]): string {
	return `logical-turn:${startMessageIndex}:${endMessageIndex}:${functionIds.join(",")}`
}

function getToolUses(message: ClineStorageMessage): ClineAssistantToolUseBlock[] {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return []
	return message.content.filter((block): block is ClineAssistantToolUseBlock => block.type === "tool_use")
}

function getToolResults(message: ClineStorageMessage): ClineUserToolResultContentBlock[] {
	if (message.role !== "user" || !Array.isArray(message.content)) return []
	return message.content.filter((block): block is ClineUserToolResultContentBlock => block.type === "tool_result")
}

function hasUserAuthoredContent(message: ClineStorageMessage): boolean {
	if (message.role !== "user") return false
	if (typeof message.content === "string") return hasUserText(message.content)
	return message.content.some((block) => {
		if (block.type === "text") return hasUserText(block.text)
		if (block.type === "tool_result") return hasTaggedUserFeedback(block)
		return false
	})
}

/** Whether a tool result carries user-authored feedback that starts a new protected round. */
export function hasTaggedUserFeedback(block: ClineUserToolResultContentBlock): boolean {
	return toolResultTexts(block).some((text) => USER_CONTENT_TAGS.some((tag) => text.toLowerCase().includes(tag.toLowerCase())))
}

function toolResultTexts(block: ClineUserToolResultContentBlock): string[] {
	if (typeof block.content === "string") return [block.content]
	return block.content.flatMap((content): string[] => (content.type === "text" ? [content.text] : []))
}

function hasUserText(text: string): boolean {
	return text.trim().length > 0
}
