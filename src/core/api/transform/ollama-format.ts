import { Message } from "ollama"
import {
	ClineAssistantToolUseBlock,
	ClineImageContentBlock,
	ClineStorageMessage,
	ClineTextContentBlock,
	ClineUserToolResultContentBlock,
} from "@/shared/messages/content"
import { splitToolResultContent } from "./tool-result-content"

/**
 * Ollama `images` for image blocks: the raw base64 payloads, which is the form Ollama decodes.
 * URL-sourced images have no inline data and are left out, because Ollama cannot fetch them.
 */
function ollamaImages(images: ClineImageContentBlock[]): string[] | undefined {
	const data = images.flatMap((image) => (image.source.type === "base64" ? [image.source.data] : []))
	return data.length > 0 ? data : undefined
}

export function convertToOllamaMessages(anthropicMessages: Omit<ClineStorageMessage, "modelInfo">[]): Message[] {
	const ollamaMessages: Message[] = []

	for (const anthropicMessage of anthropicMessages) {
		if (typeof anthropicMessage.content === "string") {
			ollamaMessages.push({
				role: anthropicMessage.role,
				content: anthropicMessage.content,
			})
		} else {
			if (anthropicMessage.role === "user") {
				const { nonToolMessages, toolMessages } = anthropicMessage.content.reduce<{
					nonToolMessages: (ClineTextContentBlock | ClineImageContentBlock)[]
					toolMessages: ClineUserToolResultContentBlock[]
				}>(
					(acc, part) => {
						if (part.type === "tool_result") {
							acc.toolMessages.push(part)
						} else if (part.type === "text" || part.type === "image") {
							acc.nonToolMessages.push(part)
						}
						return acc
					},
					{ nonToolMessages: [], toolMessages: [] },
				)

				// Process tool result messages FIRST since they must follow the tool use messages.
				// Ollama messages carry one text string, so each result's text goes there and its own
				// images go in that message's `images` field rather than into the text as base64.
				toolMessages.forEach((toolMessage) => {
					const { text, images } = splitToolResultContent(toolMessage.content ?? "")
					ollamaMessages.push({ role: "user", images: ollamaImages(images), content: text })
				})

				// Process non-tool messages
				if (nonToolMessages.length > 0) {
					const images = nonToolMessages.filter((part): part is ClineImageContentBlock => part.type === "image")
					ollamaMessages.push({
						role: "user",
						images: ollamaImages(images),
						content: nonToolMessages.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
					})
				}
			} else if (anthropicMessage.role === "assistant") {
				const { nonToolMessages, toolMessages } = anthropicMessage.content.reduce<{
					nonToolMessages: (ClineTextContentBlock | ClineImageContentBlock)[]
					toolMessages: ClineAssistantToolUseBlock[]
				}>(
					(acc, part) => {
						if (part.type === "tool_use") {
							acc.toolMessages.push(part)
						} else if (part.type === "text" || part.type === "image") {
							acc.nonToolMessages.push(part)
						} // assistant cannot send tool_result messages
						return acc
					},
					{ nonToolMessages: [], toolMessages: [] },
				)

				// Process non-tool messages
				let content = ""
				if (nonToolMessages.length > 0) {
					content = nonToolMessages
						.map((part) => {
							if (part.type === "image") {
								return "" // impossible as the assistant cannot send images
							}
							return part.text
						})
						.join("\n")
				}

				ollamaMessages.push({
					role: "assistant",
					content,
				})
			}
		}
	}

	return ollamaMessages
}
