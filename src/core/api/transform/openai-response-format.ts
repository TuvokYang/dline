import { ResponseInput, ResponseInputMessageContentList, ResponseReasoningItem } from "openai/resources/responses/responses"
import { ClineStorageMessage, imageSourceMediaType, imageSourceToUrl, isHostedToolBlock } from "@/shared/messages/content"
import { getResultFunctionId, getUseFunctionId, projectChatFunctionId } from "./tool-identity-projector"

/**
 * Converts an array of ClineStorageMessage objects (extension of Anthropic format) to a ResponseInput array to use with OpenAI's Responses API.
 *
 * ## Key Differences from Chat Completions API
 *
 * The Responses API has stricter requirements than the Chat Completions API:
 *
 * ### Chat Completions API:
 * - Messages are simple role/content pairs
 * - System prompts are separate messages with role="system"
 * - No explicit reasoning item structure
 * - More forgiving about message ordering
 *
 * ### Responses API:
 * - Uses an "input" array of heterogeneous items (messages, reasoning, function_calls, etc.)
 * - System prompts go in an "instructions" field, not as messages
 * - Reasoning items MUST be immediately followed by a message or function_call
 * - Strict ordering requirements match training data distribution
 *
 * ## The Reasoning Item Constraint
 *
 * **THE CRITICAL ERROR:** "Item 'rs_...' of type 'reasoning' was provided without its required following item"
 *
 * This error occurs when reasoning items are orphaned or separated from their corresponding output.
 *
 * ### What Causes This Error:
 * ```
 * ❌ WRONG - Reasoning orphaned between turns:
 * [
 *   { role: "user", content: [...] },
 *   { type: "reasoning", id: "rs_abc", summary: [...] },  // ← ORPHANED!
 *   { type: "message", role: "assistant", content: [...] },
 *   { role: "user", content: [...] }
 * ]
 * ```
 *
 * ### The Fix - Keep Complete Assistant Turns Together:
 * ```
 * ✅ CORRECT - Reasoning paired with its message:
 * [
 *   { role: "user", content: [...] },
 *   { type: "reasoning", id: "rs_abc", summary: [...] },
 *   { type: "message", role: "assistant", content: [...] },  // ← Immediately follows reasoning
 *   { role: "user", content: [...] }
 * ]
 * ```
 *
 * **Per OpenAI Engineering Guidance:**
 * - ❌ WRONG: `content += filter(lambda x: x.type == "reasoning", resp.output)`
 * - ✅ CORRECT: `content += resp.output`
 *
 * Never extract only reasoning items - always include the complete output sequence
 * (reasoning + message/function_call) as provided by the API.
 *
 * ## Implementation Strategy
 *
 * 1. **Separate processing for assistant vs user messages** - Assistant turns need special
 *    handling to maintain reasoning-message pairing
 * 2. **Collect all assistant items together** - Gather reasoning, messages, and function_calls
 *    for the entire assistant turn before validating
 * 3. **Validate pairing within each turn** - Ensure each reasoning item is immediately followed
 *    by a message or function_call, inserting placeholders if needed
 * 4. **Flush complete turns atomically** - Add all items from an assistant turn together to
 *    maintain proper sequencing
 *
 * @link https://community.openai.com/t/openai-api-error-function-call-was-provided-without-its-required-reasoning-item-the-real-issue/1355347
 *
 * @param messages - Array of ClineStorageMessage objects to be converted
 * @returns ResponseInput array containing the transformed messages with proper reasoning pairing
 */
export function convertToOpenAIResponsesInput(
	_messages: ClineStorageMessage[],
	options?: { usePreviousResponseId?: boolean },
): {
	input: ResponseInput
	previousResponseId?: string
} {
	// Chain from the latest stored Responses API assistant message when available.
	// When chaining, only send new items after that assistant turn.
	let previousResponseId: string | undefined
	let messages = _messages
	if (options?.usePreviousResponseId) {
		for (let i = _messages.length - 1; i >= 0; i--) {
			const msg = _messages[i]
			// Must be less than 24 hours old to be considered for chaining as the previous Id is only valid for 24 hours.
			// Set to 23 hours to account for any potential delays in processing.
			const isLessThan23HoursOld = msg.ts ? Date.now() - msg.ts < 23 * 60 * 60 * 1000 : false
			const responseId = msg.provider_metadata?.response_id
			if (msg.role === "assistant" && responseId && isLessThan23HoursOld) {
				previousResponseId = responseId
				messages = _messages.slice(i + 1)
				break
			}
		}
	}

	const allItems: any[] = []
	// Track projected call ids that are actually emitted as function_call items.
	// Tool outputs whose pairing function_call was truncated away are demoted to
	// plain user text instead of emitting an orphaned function_call_output item,
	// which the Responses API rejects with "No tool call found for tool output".
	const sentCallIds = new Set<string>()
	// Demoted orphan outputs accumulated across messages, flushed as user text.
	const demotedOutputs: string[] = []

	for (const m of messages) {
		if (typeof m.content === "string") {
			allItems.push({ role: m.role, content: [{ type: "input_text", text: m.content }] })
			continue
		}

		if (m.role === "assistant") {
			// For assistant messages, we must ensure reasoning items are IMMEDIATELY followed
			// by their corresponding message or function_call. Process the entire assistant
			// turn and ensure proper pairing.
			const assistantItems: any[] = []

			for (const part of m.content) {
				// Hosted replay blocks are native to another protocol; Responses input has no equivalent item.
				if (isHostedToolBlock(part)) {
					continue
				}
				const responseId = part.provider_metadata?.response_id
				switch (part.type) {
					case "thinking":
						// Only include reasoning item if it has actual content (thinking text or summary)
						// Empty reasoning items cause API errors: "Item 'rs_...' of type 'reasoning' was provided without its required following item"
						const hasThinkingContent = part.thinking && part.thinking.trim().length > 0
						const hasSummaryContent = part.summary && Array.isArray(part.summary) && part.summary.length > 0

						if (responseId && (hasThinkingContent || hasSummaryContent)) {
							// Use summary if available, otherwise use thinking text
							let summary: any[] = []
							if (hasSummaryContent) {
								// part.summary is already in the correct format from OpenAI Responses API
								summary = part.summary as any[]
							} else if (hasThinkingContent) {
								// Convert thinking text to summary format
								summary = [
									{
										type: "summary_text",
										text: part.thinking,
									},
								]
							}

							assistantItems.push({
								id: responseId,
								type: "reasoning",
								summary,
							} as ResponseReasoningItem)
						}
						break
					case "redacted_thinking":
						// Include reasoning item with encrypted content if it has a call_id
						// Even if data is missing, we need to maintain the reasoning-function_call pairing
						if (responseId) {
							const reasoningItem: any = {
								id: responseId,
								type: "reasoning",
								summary: [],
							}
							// Only include encrypted_content if data exists
							if (part.data) {
								reasoningItem.encrypted_content = part.data
							}
							assistantItems.push(reasoningItem as ResponseReasoningItem)
						}
						break
					case "text":
						// Message ID goes at the message level, not in the content
						// The reasoning item and message can have different IDs - they just need to be adjacent
						const messageItem: any = {
							type: "message",
							role: "assistant",
							content: [{ type: "output_text", text: part.text }],
						}
						// Set message-level id if available
						if (responseId) {
							messageItem.id = responseId
						}
						assistantItems.push(messageItem)
						break
					case "image":
						// Message ID goes at the message level, not in the content
						const imageItem: any = {
							type: "message",
							role: "assistant",
							content: [{ type: "output_text", text: `[image:${imageSourceMediaType(part.source)}]` }],
						}
						// Set message-level id if available (though images typically don't have call_id)
						if (responseId) {
							imageItem.id = responseId
						}
						assistantItems.push(imageItem)
						break
					case "tool_use": {
						const functionId = getUseFunctionId(part)
						const projectedCallId = projectChatFunctionId(functionId)
						sentCallIds.add(projectedCallId)
						assistantItems.push({
							type: "function_call",
							call_id: projectedCallId,
							name: part.name,
							arguments: JSON.stringify(part.input ?? {}),
						})
						break
					}
				}
			}

			allItems.push(...assistantItems)
		} else {
			// User messages - collect all content
			const messageContent: ResponseInputMessageContentList = []

			for (const part of m.content) {
				switch (part.type) {
					case "text":
						messageContent.push({ type: "input_text", text: part.text })
						break
					case "image":
						messageContent.push({
							type: "input_image",
							detail: "auto",
							image_url: imageSourceToUrl(part.source),
						})
						break
					case "tool_result": {
						// Flush any pending message content before adding tool result
						if (messageContent.length > 0) {
							allItems.push({ role: m.role, content: [...messageContent] })
							messageContent.length = 0
						}
						const functionId = getResultFunctionId(part)
						const projectedCallId = projectChatFunctionId(functionId)
						const output = typeof part.content === "string" ? part.content : JSON.stringify(part.content)
						if (!sentCallIds.has(projectedCallId)) {
							// The pairing function_call is not in the sent history (truncated or
							// never recorded). Emitting an orphaned function_call_output would
							// fail the request, so keep the output as plain user text.
							if (output) {
								demotedOutputs.push(output)
							}
							break
						}
						allItems.push({
							type: "function_call_output",
							call_id: projectedCallId,
							output,
						})
						break
					}
				}
			}

			// Flush any remaining user message content
			if (messageContent.length > 0) {
				allItems.push({ role: m.role, content: [...messageContent] })
			}
			// Flush demoted orphan outputs as plain user text.
			if (demotedOutputs.length > 0) {
				allItems.push({
					role: m.role,
					content: demotedOutputs.map((output) => ({ type: "input_text", text: output })),
				})
				demotedOutputs.length = 0
			}
		}
	}

	return { input: allItems, previousResponseId }
}
