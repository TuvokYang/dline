import { formatResponse } from "@core/prompts/responses"
import { processFilesIntoContent } from "@integrations/misc/extract-text"
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
