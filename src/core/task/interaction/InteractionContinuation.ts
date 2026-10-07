import type { ImageBlockParam } from "@anthropic-ai/sdk/resources/messages/messages"
import { getPrompt, renderPrompt } from "@core/prompts/i18n"
import { formatResponse } from "@core/prompts/responses"
import { processFilesForToolResult } from "@integrations/misc/extract-text"
import type { ChatContent } from "@shared/ChatContent"
import type {
	ClineTextContentBlock,
	ClineToolResponseContent,
	ClineUserAttachedDocumentBlock,
	ClineUserToolResultContentBlock,
} from "@shared/messages/content"
import { ClineDefaultTool } from "@shared/tools"
import type { InteractionKind } from "./Interaction"

export interface InteractionContinuationInput {
	kind: InteractionKind
	functionId: string
	dlineTid: string
	chatContent?: ChatContent
	switchesPlanToAct?: boolean
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

/** User-message content produced by one conversational interaction response. */
export interface InteractionContinuation {
	toolResult: ClineUserToolResultContentBlock
	/** PDFs attached to the response, which follow the tool results of the same user message natively. */
	documents: ClineUserAttachedDocumentBlock[]
}

/** Project the canonical tool result, and any attached PDFs, produced by one conversational interaction response. */
export async function projectInteractionContinuation(input: InteractionContinuationInput): Promise<InteractionContinuation> {
	const attachments = await processFilesForToolResult(input.chatContent?.files)
	return {
		toolResult: {
			type: "tool_result",
			function_id: input.functionId,
			dline_tid: input.dlineTid,
			content: projectResponseContent(input, attachments.text),
		},
		documents: attachments.documents,
	}
}

/** `<feedback>` suffix of a status acknowledgment; images and files travel as their own blocks. */
export function statusFeedbackText(text?: string): string {
	const trimmedText = text?.trim()
	return trimmedText ? `\n<feedback>\n${trimmedText}\n</feedback>` : ""
}

function projectResponseContent(input: InteractionContinuationInput, fileContent: string): ClineToolResponseContent {
	const text = input.chatContent?.message
	const images = input.chatContent?.images

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
		case "status_acknowledgment":
			return formatResponse.toolResult(
				`[STATUS_UPDATE] User acknowledged.${statusFeedbackText(text)} Continue with your next tool call.`,
				images,
				fileContent,
			)
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
