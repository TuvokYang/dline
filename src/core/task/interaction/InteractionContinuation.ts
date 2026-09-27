import type { ImageBlockParam } from "@anthropic-ai/sdk/resources/messages/messages"
import { getPrompt, renderPrompt } from "@core/prompts/i18n"
import { formatResponse } from "@core/prompts/responses"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import type { ChatContent } from "@shared/ChatContent"
import type { ClineTextContentBlock, ClineToolResponseContent, ClineUserToolResultContentBlock } from "@shared/messages/content"
import { ClineDefaultTool } from "@shared/tools"
import type { InteractionKind } from "./Interaction"

export interface InteractionContinuationInput {
	kind: InteractionKind
	functionId: string
	dlineTid: string
	chatContent?: ChatContent
	switchesPlanToAct?: boolean
	/** The action the user answered with; a status acknowledgment reads Stop differently. */
	actionId?: string
}

/** Map a conversational tool name to the interaction contract that formats its continuation. */
export function interactionKindForToolName(name: string): InteractionKind | undefined {
	switch (name) {
		case ClineDefaultTool.ASK:
			return "followup"
		case ClineDefaultTool.MAKE_PLAN:
			return "make_plan"
		case ClineDefaultTool.QNA_RESPOND:
			return "qna_response"
		case ClineDefaultTool.GENERATE_REPORT:
			return "generate_report"
		case ClineDefaultTool.STATUS_UPDATE:
			return "status_acknowledgment"
		case ClineDefaultTool.ATTEMPT:
			return "completion"
		default:
			return undefined
	}
}

/** Project the canonical tool result produced by one conversational interaction response. */
export async function projectInteractionContinuation(
	input: InteractionContinuationInput,
): Promise<ClineUserToolResultContentBlock> {
	return {
		type: "tool_result",
		function_id: input.functionId,
		dline_tid: input.dlineTid,
		content: await projectResponseContent(input),
	}
}

async function projectResponseContent(input: InteractionContinuationInput): Promise<ClineToolResponseContent> {
	const text = input.chatContent?.message
	const images = input.chatContent?.images
	const files = input.chatContent?.files
	const fileContent = files?.length ? await processFilesIntoText(files) : ""

	switch (input.kind) {
		case "make_plan":
		case "qna_response":
		case "generate_report": {
			const message = input.switchesPlanToAct
				? text
					? renderPrompt("toolHandlers", "planSwitchToActWithMessage", { TEXT: text })
					: getPrompt("toolHandlers", "planSwitchToAct")
				: text
					? `<feedback>\n${text}\n</feedback>`
					: "User continued the conversation."
			return formatResponse.toolResult(message, images, fileContent)
		}
		case "status_acknowledgment": {
			const feedback = formatStatusFeedback(text, images, files)
			// Worded exactly as StatusUpdateHandler answers a live dialog, so a
			// restored answer reads the same to the model.
			if (input.actionId === "stop") {
				return formatResponse.toolResult(`[STATUS_UPDATE] User chose to stop.${feedback} Wait for further instructions.`)
			}
			return formatResponse.toolResult(`[STATUS_UPDATE] User acknowledged.${feedback} Continue with your next tool call.`)
		}
		case "completion": {
			const content: Array<ClineTextContentBlock | ImageBlockParam> = [
				{ type: "text", text: "[attempt_completion] Result: Done" },
			]
			if (text) {
				content.push({
					type: "text",
					text: "The user has provided feedback on the results. Consider their input to continue the task, and then attempt completion again.",
				})
				content.push({ type: "text", text: `<feedback>\n${text}\n</feedback>` })
			}
			if (fileContent) content.push({ type: "text", text: fileContent })
			if (images?.length) content.push(...formatResponse.imageBlocks(images))
			return content
		}
		case "followup":
		default:
			return formatResponse.toolResult(`<feedback>\n${text ?? ""}\n</feedback>`, images, fileContent)
	}
}

function formatStatusFeedback(text?: string, images?: string[], files?: string[]): string {
	const parts: string[] = []
	const trimmedText = text?.trim()
	if (trimmedText) parts.push(`<feedback>\n${trimmedText}\n</feedback>`)
	if (images?.length) parts.push(`Images: ${images.join(", ")}`)
	if (files?.length) parts.push(`Files: ${files.join(", ")}`)
	return parts.length > 0 ? `\n${parts.join("\n")}` : ""
}
