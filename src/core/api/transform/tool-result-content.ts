import type { ClineImageContentBlock, ClineToolResponseContent } from "@/shared/messages/content"

/** Text left in a tool result whose image travels in the following user message. */
export const TOOL_RESULT_IMAGE_NOTE = "(see following user message for image)"

export interface SplitToolResult {
	/** Result text, with a note in place of each image. */
	text: string
	/** Images the caller sends as native image parts beside the result. */
	images: ClineImageContentBlock[]
}

/**
 * Split a tool result for a protocol whose tool output accepts only text.
 *
 * Images come back separately so the caller can send them as native image parts in the following user
 * message. Serializing them into the output text instead would hand the model base64 it cannot see as an
 * image, at the context cost of every character.
 */
export function splitToolResultContent(content: ClineToolResponseContent): SplitToolResult {
	if (typeof content === "string") return { text: content, images: [] }
	const images: ClineImageContentBlock[] = []
	const text = content
		.map((block) => {
			if (block.type !== "image") return block.text
			images.push(block)
			return TOOL_RESULT_IMAGE_NOTE
		})
		.join("\n")
	return { text, images }
}
