import type { ClineContent } from "@/shared/messages"

/**
 * Ensure an API request never uses an empty conversation context.
 * @param managedMessages Messages returned by context management.
 * @param fallbackMessages Full API history used as a safe fallback.
 * @returns Non-empty messages for provider requests.
 * @throws Error when both managed and fallback contexts are empty.
 */
export function ensureApiMessages<T>(managedMessages: T[], fallbackMessages: T[]): T[] {
	if (managedMessages.length > 0) {
		return managedMessages
	}

	if (fallbackMessages.length > 0) {
		return fallbackMessages
	}

	throw new Error("Refusing to send an empty API conversation")
}

/**
 * Ensure a user turn contains content before it is persisted or sent.
 *
 * @param userContent Content blocks for the pending user turn.
 * @param reason Diagnostic reason included in the thrown error.
 * @returns The original user content when it contains meaningful content.
 * @throws Error when the content is empty or whitespace-only.
 */
export function ensureUserContent(userContent: ClineContent[], reason: string): ClineContent[] {
	if (userContent.some((block) => getContentText(block).trim().length > 0)) {
		return userContent
	}

	throw new Error(`Refusing to send empty user content for ${reason}`)
}

/**
 * Extract text from a supported content block for emptiness checks.
 *
 * @param block Cline content block to inspect.
 * @returns Textual content used for non-empty validation.
 */
function getContentText(block: ClineContent): string {
	if (block.type === "text") {
		return block.text
	}

	if (block.type === "agents_instructions") {
		return block.content
	}

	if (block.type === "attached_document") {
		return block.fallback_text
	}

	if (block.type === "tool_result") {
		if (typeof block.content === "string") {
			return block.content
		}

		if (Array.isArray(block.content)) {
			return block.content.map((contentBlock) => (contentBlock.type === "text" ? contentBlock.text : "")).join("\n")
		}
	}

	return ""
}
