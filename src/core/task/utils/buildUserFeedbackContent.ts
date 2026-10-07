import { formatResponse } from "@core/prompts/responses"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import type { ClineImageContentBlock, ClineTextContentBlock } from "@shared/messages/content"

/**
 * Builds an array of ClineContent blocks from user feedback inputs.
 * This ensures consistent formatting across all user feedback scenarios:
 * - Task resumption with feedback
 * - Post-completion feedback
 *
 * @param text Optional feedback text from user
 * @param images Optional array of base64 image data
 * @param files Optional array of file paths to include
 * @returns Array of user content blocks ready for hook processing (may be empty if no content provided)
 */
export async function buildUserFeedbackContent(
	text?: string,
	images?: string[],
	files?: string[],
): Promise<Array<ClineTextContentBlock | ClineImageContentBlock>> {
	const content: Array<ClineTextContentBlock | ClineImageContentBlock> = []

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
		const fileContentString = await processFilesIntoText(files)
		if (fileContentString) {
			content.push({
				type: "text",
				text: fileContentString,
			})
		}
	}

	return content
}

/** How approval feedback reads inside the result of the tool call it answered. */
export function toolApprovalFeedbackText(text: string | undefined): string {
	return text?.trim()
		? `The user provided the following feedback:\n<feedback>\n${text}\n</feedback>`
		: "The user provided additional content:"
}

/**
 * Builds the blocks approval feedback adds to the result of the tool call it
 * answered, so the model reads the user's words beside that call's outcome.
 *
 * @returns No blocks when the feedback carried no text, image, or file content.
 */
export async function buildToolApprovalFeedbackContent(
	text?: string,
	images?: string[],
	files?: string[],
): Promise<Array<ClineTextContentBlock | ClineImageContentBlock>> {
	const fileContentString = files && files.length > 0 ? await processFilesIntoText(files) : undefined
	const hasText = Boolean(text?.trim())
	const hasImages = Boolean(images && images.length > 0)
	const hasFileContent = Boolean(fileContentString?.trim())
	if (!hasText && !hasImages && !hasFileContent) return []

	const content: Array<ClineTextContentBlock | ClineImageContentBlock> = [
		{ type: "text", text: toolApprovalFeedbackText(text) },
	]
	if (hasImages) content.push(...formatResponse.imageBlocks(images))
	if (hasFileContent && fileContentString) content.push({ type: "text", text: fileContentString })
	return content
}

/**
 * Builds the content of the submission that opens a task.
 *
 * Mirrors the legacy task start: the text is the `<task>`, images follow it,
 * submission context (a TaskStart hook or a spawn handoff) is its own
 * `<context>` block rather than part of what the user typed, and file
 * contents come last.
 */
export async function buildTaskOpeningContent(
	text?: string,
	context?: string,
	images?: string[],
	files?: string[],
): Promise<Array<ClineTextContentBlock | ClineImageContentBlock>> {
	const content: Array<ClineTextContentBlock | ClineImageContentBlock> = []
	if (text) content.push({ type: "text", text: `<task>\n${text}\n</task>` })
	if (images && images.length > 0) content.push(...formatResponse.imageBlocks(images))
	const trimmedContext = context?.trim()
	if (trimmedContext) content.push({ type: "text", text: `<context>\n${trimmedContext}\n</context>` })
	if (files && files.length > 0) {
		const fileContentString = await processFilesIntoText(files)
		if (fileContentString) content.push({ type: "text", text: fileContentString })
	}
	return content
}
