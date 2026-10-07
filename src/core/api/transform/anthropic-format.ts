import { Anthropic } from "@anthropic-ai/sdk"
import {
	type AnthropicMessageConversionOptions,
	ClineStorageMessage,
	convertClineStorageToAnthropicMessage,
	hostedSegmentCallId,
	isHostedToolBlock,
} from "@/shared/messages/content"
import { resolveDeferredHostedCalls } from "@/shared/messages/hosted-tool-deferral"

/**
 * Converts Cline storage messages to Anthropic API format with optional cache control.
 *
 * Reasoning that Anthropic cannot verify is removed during conversion; an assistant turn that
 * held nothing else is then dropped, because Anthropic rejects an empty content array.
 * Ephemeral cache control is applied to the last two user messages of the final list.
 *
 * @param clineMessages - Array of Cline storage messages to convert
 * @param supportCache - Whether to add ephemeral cache control breakpoints
 * A hosted call Anthropic deferred behind client tool calls is carried only while the provider can still run
 * it, and the user message answering that turn is reduced to its tool results, as the provider requires.
 *
 * @param options - Conversion options; hosted tool blocks are replayed only when the endpoint runs them
 * @returns Array of Anthropic-compatible messages with cache control applied
 */
export function sanitizeAnthropicMessages(
	clineMessages: ClineStorageMessage[],
	supportCache: boolean,
	options: AnthropicMessageConversionOptions = {},
): Array<Anthropic.MessageParam> {
	const deferral = planDeferredHostedTurns(clineMessages, options)
	const conversionOptions =
		deferral.omitHostedCallIds.size > 0 ? { ...options, omitHostedCallIds: deferral.omitHostedCallIds } : options
	const anthropicMessages = clineMessages
		.map((msg, index) => {
			const converted = convertClineStorageToAnthropicMessage(msg, undefined, conversionOptions)
			return deferral.toolResultOnlyFollowUps.has(index) ? foldIntoToolResults(converted) : converted
		})
		.filter((msg) => !isEmptyAssistantMessage(msg))
	if (!supportCache) {
		return anthropicMessages
	}

	// The latest user message is cached for the next request, and the second to last one tells the
	// server which prefix to read from the cache for the current request.
	const cachedUserIndices = new Set(lastUserMessageIndices(anthropicMessages, 2))
	return anthropicMessages.map((msg, index) => (cachedUserIndices.has(index) ? addCacheControl(msg) : msg))
}

interface DeferredHostedTurnPlan {
	/** Deferred call and result segments the request must not carry. */
	omitHostedCallIds: ReadonlySet<string>
	/** Indices of user messages that answer a turn with a deferred call the request carries. */
	toolResultOnlyFollowUps: ReadonlySet<number>
}

/**
 * Decide which deferred hosted segments a request carries and which follow-ups must hold only tool results.
 *
 * A result segment is kept only while its call is, so a truncated or compacted history never sends a result
 * the provider cannot pair.
 */
function planDeferredHostedTurns(
	messages: readonly ClineStorageMessage[],
	options: AnthropicMessageConversionOptions,
): DeferredHostedTurnPlan {
	const calls = resolveDeferredHostedCalls(messages, {
		protocol: "anthropic_messages",
		replayHostedTools: options.replayHostedTools,
	})
	const carried = new Set(calls.filter((call) => call.state !== "dropped").map((call) => call.callId))
	const omitHostedCallIds = new Set(calls.filter((call) => call.state === "dropped").map((call) => call.callId))
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue
		for (const block of message.content) {
			if (!isHostedToolBlock(block) || block.segment !== "result") continue
			const callId = hostedSegmentCallId(block)
			if (callId !== undefined && !carried.has(callId)) omitHostedCallIds.add(callId)
		}
	}
	return {
		omitHostedCallIds,
		toolResultOnlyFollowUps: new Set(calls.filter((call) => call.state !== "dropped").map((call) => call.messageIndex + 1)),
	}
}

/**
 * Reduce a follow-up user message to its tool results.
 *
 * Anthropic treats any block after the tool results as the end of the assistant turn, which strands a
 * deferred hosted call. The other blocks (environment details, feedback, images) keep their order and move
 * into the last tool result, so the model still receives them.
 */
function foldIntoToolResults(message: Anthropic.MessageParam): Anthropic.MessageParam {
	if (typeof message.content === "string") return message
	const results = message.content.filter((block): block is Anthropic.ToolResultBlockParam => block.type === "tool_result")
	const carried = message.content.filter((block) => block.type !== "tool_result")
	const last = results.at(-1)
	if (!last || carried.length === 0) return message
	const lastContent =
		typeof last.content === "string"
			? last.content
				? [{ type: "text" as const, text: last.content }]
				: []
			: (last.content ?? [])
	const folded: Anthropic.ToolResultBlockParam = {
		...last,
		content: [...lastContent, ...carried] as Anthropic.ToolResultBlockParam["content"],
	}
	return { ...message, content: [...results.slice(0, -1), folded] }
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
