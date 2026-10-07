import type { ClineContent, ClineStorageMessage, ClineUserToolResultContentBlock } from "@shared/messages"
import cloneDeep from "clone-deep"
import { interactionKindForToolName, projectInteractionContinuation } from "../interaction/InteractionContinuation"
import type { InteractionDraft } from "../interaction/InteractionResponse"

export interface ResumeOrdinaryInputProjection {
	content: ClineContent[]
	draftEmbedded: boolean
}

/** Rebuild checkpoint-restored ordinary input without replaying stale user-authored feedback. */
export async function projectResumeOrdinaryInput(input: {
	apiHistory: readonly ClineStorageMessage[]
	ordinaryInput: readonly ClineContent[]
	draft?: InteractionDraft
}): Promise<ResumeOrdinaryInputProjection> {
	if (!hasVisibleDraft(input.draft)) {
		return { content: cloneDeep([...input.ordinaryInput]), draftEmbedded: false }
	}

	const toolResults = cloneDeep(input.ordinaryInput.filter(isToolResult))
	for (let index = toolResults.length - 1; index >= 0; index--) {
		const result = toolResults[index]
		const toolUse = findToolUse(input.apiHistory, result)
		const kind = toolUse ? interactionKindForToolName(toolUse.name) : undefined
		if (!kind) continue
		const continuation = await projectInteractionContinuation({
			kind,
			functionId: result.function_id,
			dlineTid: result.dline_tid,
			chatContent: {
				message: input.draft.text,
				images: input.draft.images,
				files: input.draft.files,
			},
		})
		toolResults[index] = continuation.toolResult
		return { content: [...toolResults, ...continuation.documents], draftEmbedded: true }
	}

	return { content: toolResults, draftEmbedded: false }
}

function hasVisibleDraft(draft?: InteractionDraft): draft is InteractionDraft {
	return Boolean(draft && (draft.text.trim() || draft.images.length > 0 || draft.files.length > 0))
}

function isToolResult(content: ClineContent): content is ClineUserToolResultContentBlock {
	return content.type === "tool_result"
}

function findToolUse(
	history: readonly ClineStorageMessage[],
	result: ClineUserToolResultContentBlock,
): { name: string } | undefined {
	for (let messageIndex = history.length - 1; messageIndex >= 0; messageIndex--) {
		const message = history[messageIndex]
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue
		for (let contentIndex = message.content.length - 1; contentIndex >= 0; contentIndex--) {
			const content = message.content[contentIndex]
			if (
				content.type === "tool_use" &&
				content.function_id === result.function_id &&
				content.dline_tid === result.dline_tid
			) {
				return { name: content.name }
			}
		}
	}
	return undefined
}
