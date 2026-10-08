import { formatResponse } from "@core/prompts/responses"
import { processFilesForToolResult, processFilesIntoContent } from "@integrations/misc/extract-text"
import type { ClineImageContentBlock, ClineTextContentBlock, ClineUserAttachedDocumentBlock } from "@shared/messages/content"

/**
 * Builds an array of ClineContent blocks from user feedback inputs.
 * This ensures consistent formatting across all user feedback scenarios:
 * - Task resumption with feedback
 * - Post-completion feedback
 *
 * @param text Optional feedback text from user
 * @param images Optional array of base64 image data
 * @param files Optional array of file paths to include; PDFs are kept whole for native document input
 * @returns Array of user content blocks ready for hook processing (may be empty if no content provided)
 */
export async function buildUserFeedbackContent(
	text?: string,
	images?: string[],
	files?: string[],
): Promise<Array<ClineTextContentBlock | ClineImageContentBlock | ClineUserAttachedDocumentBlock>> {
	const content: Array<ClineTextContentBlock | ClineImageContentBlock | ClineUserAttachedDocumentBlock> = []

	if (text) {
		content.push({
			type: "text",
			text: `<user_message>\n${text}\n</user_message>`,
		})
	}

	if (images && images.length > 0) {
		content.push(...formatResponse.imageBlocks(images))
	}

	if (files && files.length > 0) {
		content.push(...(await processFilesIntoContent(files)))
	}

	return content
}

/** How approval feedback reads inside the result of the tool call it answered. */
export function toolApprovalFeedbackText(text: string | undefined): string {
	return text?.trim()
		? `The user provided the following feedback:\n<feedback>\n${text}\n</feedback>`
		: "The user provided additional content:"
}

/** Approval feedback split by where each part can travel in the next request. */
export interface ToolApprovalFeedbackContent {
	/** Text and images that join the result of the call the feedback answered. */
	readonly blocks: Array<ClineTextContentBlock | ClineImageContentBlock>
	/** Attached PDFs, which a tool result cannot hold; they follow the results natively. */
	readonly documents: ClineUserAttachedDocumentBlock[]
}

/**
 * Builds what approval feedback adds to the result of the tool call it
 * answered, so the model reads the user's words beside that call's outcome.
 *
 * @returns No blocks and no documents when the feedback carried no text, image, or file content.
 */
export async function buildToolApprovalFeedbackContent(
	text?: string,
	images?: string[],
	files?: string[],
): Promise<ToolApprovalFeedbackContent> {
	const attachments = await processFilesForToolResult(files)
	const hasText = Boolean(text?.trim())
	const hasImages = Boolean(images && images.length > 0)
	const hasFileContent = Boolean(attachments.text.trim())
	if (!hasText && !hasImages && !hasFileContent) return { blocks: [], documents: [] }

	const blocks: Array<ClineTextContentBlock | ClineImageContentBlock> = [{ type: "text", text: toolApprovalFeedbackText(text) }]
	if (hasImages) blocks.push(...formatResponse.imageBlocks(images))
	if (hasFileContent) blocks.push({ type: "text", text: attachments.text })
	return { blocks, documents: attachments.documents }
}

/**
 * Builds the content of the submission that opens a task.
 *
 * Mirrors the legacy task start: the text is the `<task>`, images follow it,
 * submission context (a TaskStart hook or a spawn handoff) is its own
 * `<context>` block rather than part of what the user typed, and file
 * contents come last, with attached PDFs kept whole for native document input.
 */
export async function buildTaskOpeningContent(
	text?: string,
	context?: string,
	images?: string[],
	files?: string[],
): Promise<Array<ClineTextContentBlock | ClineImageContentBlock | ClineUserAttachedDocumentBlock>> {
	const content: Array<ClineTextContentBlock | ClineImageContentBlock | ClineUserAttachedDocumentBlock> = []
	if (text) content.push({ type: "text", text: `<task>\n${text}\n</task>` })
	if (images && images.length > 0) content.push(...formatResponse.imageBlocks(images))
	const trimmedContext = context?.trim()
	if (trimmedContext) content.push({ type: "text", text: `<context>\n${trimmedContext}\n</context>` })
	if (files && files.length > 0) content.push(...(await processFilesIntoContent(files)))
	return content
}
