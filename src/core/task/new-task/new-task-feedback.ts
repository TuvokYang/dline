import { formatResponse } from "@core/prompts/responses"
import { processFilesIntoContent } from "@integrations/misc/extract-text"
import type { ClineMessage } from "@shared/ExtensionMessage"
import {
	type ClineContent,
	type ClineStorageMessage,
	type ClineUserContent,
	type ClineUserToolResultContentBlock,
	imageSourceToUrl,
} from "@shared/messages/content"
import { ClineDefaultTool } from "@shared/tools"
import { NEW_TASK_FEEDBACK_CONTINUATION_MARKER } from "./new-task-continuation"
import type { NewTaskConsumedState, NewTaskFeedback } from "./new-task-handoff"

/** Persisted histories used to recover the latest causally submitted New Task feedback. */
export interface NewTaskFeedbackHistory {
	readonly apiHistory: readonly ClineStorageMessage[]
	readonly uiHistory: readonly ClineMessage[]
	readonly approvedSource: NewTaskConsumedState
}

/** Create an owned empty feedback value for a successor handoff. */
export function emptyNewTaskFeedback(): NewTaskFeedback {
	return { text: "", images: [], files: [] }
}

/** Return whether one canonical tool result was emitted by the New Task feedback handler. */
function isNewTaskFeedbackResult(block: ClineContent): block is ClineUserToolResultContentBlock {
	if (block.type !== "tool_result" || block.is_error === true) return false
	if (typeof block.content === "string") {
		return block.content.includes(NEW_TASK_FEEDBACK_CONTINUATION_MARKER)
	}
	return block.content.some(
		(content) => content.type === "text" && content.text.includes(NEW_TASK_FEEDBACK_CONTINUATION_MARKER),
	)
}

/** Extract only the submitted feedback body from a canonical handler result. */
function feedbackTextFromResult(result: ClineUserToolResultContentBlock): string {
	const text =
		typeof result.content === "string"
			? result.content
			: result.content
					.filter((content) => content.type === "text")
					.map((content) => content.text)
					.join("\n")
	const match = text.match(/<feedback>\s*([\s\S]*?)\s*<\/feedback>/)
	return match?.[1]?.trim() ?? ""
}

/** Recover image payloads from the canonical result when the causal UI row is unavailable. */
function feedbackImagesFromResult(result: ClineUserToolResultContentBlock): string[] {
	if (typeof result.content === "string") return []
	return result.content.filter((content) => content.type === "image").map((content) => imageSourceToUrl(content.source))
}

/** Count assistant New Task declarations paired to one canonical feedback result. */
function matchingNewTaskToolCount(
	apiHistory: readonly ClineStorageMessage[],
	beforeIndex: number,
	result: ClineUserToolResultContentBlock,
): number {
	let count = 0
	for (let index = 0; index < beforeIndex; index++) {
		const message = apiHistory[index]
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue
		for (const block of message.content) {
			if (
				block.type === "tool_use" &&
				block.name === ClineDefaultTool.NEW_TASK &&
				block.function_id === result.function_id &&
				block.dline_tid === result.dline_tid
			) {
				count++
			}
		}
	}
	return count
}

/**
 * Recover the most recent submitted New Task feedback from canonical histories.
 *
 * Ordinary text and the current unsent draft are intentionally ignored. The API
 * result establishes trusted tool identity; the causal UI row preserves original
 * attachment paths without parsing rendered file content.
 */
export function findLatestNewTaskFeedback(history: NewTaskFeedbackHistory): NewTaskFeedback {
	const approvedMessageIndexes = history.apiHistory.flatMap((message, index) => {
		if (message.role !== "assistant" || !Array.isArray(message.content)) return []
		const matches = message.content.filter(
			(block) =>
				block.type === "tool_use" &&
				block.name === ClineDefaultTool.NEW_TASK &&
				block.function_id === history.approvedSource.functionId &&
				block.dline_tid === history.approvedSource.dlineTid,
		)
		return matches.length === 1 ? [index] : []
	})
	if (approvedMessageIndexes.length !== 1) return emptyNewTaskFeedback()

	let feedbackMessageIndex = approvedMessageIndexes[0] - 1
	while (feedbackMessageIndex >= 0 && history.apiHistory[feedbackMessageIndex].role !== "user") {
		feedbackMessageIndex--
	}
	if (feedbackMessageIndex < 0) return emptyNewTaskFeedback()
	const feedbackMessage = history.apiHistory[feedbackMessageIndex]
	if (!Array.isArray(feedbackMessage.content)) return emptyNewTaskFeedback()
	const candidates = feedbackMessage.content.filter(isNewTaskFeedbackResult)
	if (candidates.length !== 1) return emptyNewTaskFeedback()

	const block = candidates[0]
	if (matchingNewTaskToolCount(history.apiHistory, feedbackMessageIndex, block) !== 1) {
		return emptyNewTaskFeedback()
	}
	const causalRows = history.uiHistory.filter(
		(row) =>
			row.type === "say" && row.say === "user_feedback" && row.partial !== true && row.interactionId === block.dline_tid,
	)
	if (causalRows.length > 1) {
		throw new Error(`Duplicate New Task feedback rows for dlineTid=${block.dline_tid}`)
	}
	const causalRow = causalRows[0]
	return {
		text: causalRow?.text ?? feedbackTextFromResult(block),
		images: [...(causalRow?.images ?? feedbackImagesFromResult(block))],
		files: [...(causalRow?.files ?? [])],
	}
}

/** Build successor-provider content while preserving feedback semantics and attachments. */
export async function buildNewTaskFeedbackContent(feedback: NewTaskFeedback): Promise<ClineUserContent[]> {
	const content: ClineUserContent[] = []
	if (feedback.text.trim()) {
		content.push({ type: "text", text: `<feedback>\n${feedback.text}\n</feedback>` })
	}
	if (feedback.images.length > 0) {
		content.push(...formatResponse.imageBlocks([...feedback.images]))
	}
	if (feedback.files.length > 0) {
		content.push(...(await processFilesIntoContent([...feedback.files])))
	}
	return content
}
