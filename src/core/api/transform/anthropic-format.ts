import { Anthropic } from "@anthropic-ai/sdk"
import { ClineStorageMessage, convertClineStorageToAnthropicMessage } from "@/shared/messages/content"

/**
 * Converts Cline storage messages to Anthropic API format with optional cache control.
 *
 * Reasoning that Anthropic cannot verify is removed during conversion; an assistant turn that
 * held nothing else is then dropped, because Anthropic rejects an empty content array.
 * Ephemeral cache control is applied to the last two user messages of the final list.
 *
 * @param clineMessages - Array of Cline storage messages to convert
 * @param supportCache - Whether to add ephemeral cache control breakpoints
 * @returns Array of Anthropic-compatible messages with cache control applied
 */
export function sanitizeAnthropicMessages(
	clineMessages: ClineStorageMessage[],
	supportCache: boolean,
): Array<Anthropic.MessageParam> {
	const anthropicMessages = clineMessages
		.map((msg) => convertClineStorageToAnthropicMessage(msg))
		.filter((msg) => !isEmptyAssistantMessage(msg))
	if (!supportCache) {
		return anthropicMessages
	}

	// The latest user message is cached for the next request, and the second to last one tells the
	// server which prefix to read from the cache for the current request.
	const cachedUserIndices = new Set(lastUserMessageIndices(anthropicMessages, 2))
	return anthropicMessages.map((msg, index) => (cachedUserIndices.has(index) ? addCacheControl(msg) : msg))
}

function isEmptyAssistantMessage(message: Anthropic.MessageParam): boolean {
	return message.role === "assistant" && Array.isArray(message.content) && message.content.length === 0
}

function lastUserMessageIndices(messages: Anthropic.MessageParam[], count: number): number[] {
	const indices: number[] = []
	for (let index = messages.length - 1; index >= 0 && indices.length < count; index--) {
		if (messages[index].role === "user") {
			indices.push(index)
		}
	}
	return indices
}

const isThinkingBlock = (
	block: Anthropic.ContentBlockParam,
): block is Anthropic.Messages.ThinkingBlockParam | Anthropic.Messages.RedactedThinkingBlockParam => {
	return block.type === "thinking" || block.type === "redacted_thinking"
}

/**
 * Adds ephemeral cache control to the last content block of a message.
 * Returns a new message object without mutating the original.
 *
 * @param message - The Anthropic message to add cache control to
 * @returns A new message with cache control added to the last content block
 */
function addCacheControl(message: Anthropic.MessageParam): Anthropic.MessageParam {
	// Convert string content to array format
	if (typeof message.content === "string") {
		return {
			...message,
			content: [
				{
					type: "text",
					text: message.content,
					cache_control: { type: "ephemeral" },
				} satisfies Anthropic.TextBlockParam,
			],
		}
	}

	// Handle array content - add cache control to the last block
	const content = [...message.content]
	const lastIndex = content.length - 1

	if (lastIndex >= 0) {
		const lastBlock = content[lastIndex]

		// Only add cache_control to block types that support it (not ThinkingBlockParam)
		if (!isThinkingBlock(lastBlock)) {
			content[lastIndex] = {
				...lastBlock,
				cache_control: { type: "ephemeral" },
			} satisfies Anthropic.ContentBlockParam
		}
	}

	return { ...message, content }
}
