import { formatResponse } from "@core/prompts/responses"
import { processFilesIntoContent } from "@integrations/misc/extract-text"
import type { ClineMessage } from "@shared/ExtensionMessage"
import type { ClineContent, ClineStorageMessage } from "@shared/messages"
import type { BlockLifecycle } from "../BlockPhaseMachine"
import { assembleToolTurnContent } from "./ToolTurnContentAssembler"

export interface MistakeLimitContinuationInput {
	turn?: {
		assistantApiIndex: number
		blocks: readonly BlockLifecycle[]
	}
	apiHistory: readonly ClineStorageMessage[]
	uiHistory: readonly ClineMessage[]
	pendingContent: readonly ClineContent[]
	feedback: {
		text?: string
		images?: string[]
		files?: string[]
	}
}

async function buildMistakeFeedbackContent(input: MistakeLimitContinuationInput["feedback"]): Promise<ClineContent[]> {
	const content: ClineContent[] = [{ type: "text", text: formatResponse.tooManyMistakes(input.text) }]
	if (input.images?.length) content.push(...formatResponse.imageBlocks(input.images))
	if (input.files?.length) content.push(...(await processFilesIntoContent(input.files)))
	return content
}

/** Preserve the interrupted tool turn before appending Process Anyway guidance. */
export async function buildMistakeLimitContinuationContent(input: MistakeLimitContinuationInput): Promise<ClineContent[]> {
	const turnContent = input.turn
		? assembleToolTurnContent({
				blocks: input.turn.blocks,
				assistantApiIndex: input.turn.assistantApiIndex,
				apiHistory: input.apiHistory,
				uiHistory: input.uiHistory,
				pendingContent: input.pendingContent,
				synthesizeMissing: "all",
			})
		: [...input.pendingContent]
	const feedbackContent = await buildMistakeFeedbackContent(input.feedback)
	return [...turnContent, ...feedbackContent]
}
