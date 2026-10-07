import type { ApiStopReason } from "./stream"

/**
 * Normalize an Anthropic Messages `stop_reason`.
 *
 * @param reason Raw `message_delta.delta.stop_reason`; null while the message is still open.
 * @returns The provider-neutral stop reason, or undefined when the stream has not stopped yet.
 */
export function normalizeAnthropicStopReason(reason: string | null | undefined): ApiStopReason | undefined {
	switch (reason) {
		case null:
		case undefined:
			return undefined
		case "end_turn":
			return "end_turn"
		case "tool_use":
			return "tool_use"
		case "max_tokens":
		case "model_context_window_exceeded":
			return "output_limit"
		case "stop_sequence":
			return "stop_sequence"
		case "refusal":
			return "content_filter"
		default:
			return "other"
	}
}

/**
 * Normalize an OpenAI Chat Completions `finish_reason`.
 *
 * @param reason Raw `choices[0].finish_reason`; null on every chunk before the final one.
 * @returns The provider-neutral stop reason, or undefined when the choice has not finished yet.
 */
export function normalizeOpenAIFinishReason(reason: string | null | undefined): ApiStopReason | undefined {
	switch (reason) {
		case null:
		case undefined:
			return undefined
		case "stop":
			return "end_turn"
		case "tool_calls":
		case "function_call":
			return "tool_use"
		case "length":
			return "output_limit"
		case "content_filter":
			return "content_filter"
		default:
			return "other"
	}
}

/**
 * Normalize the terminal status of an OpenAI Responses stream.
 *
 * @param status Final `response.status`.
 * @param incompleteReason `response.incomplete_details.reason` when the status is `incomplete`.
 * @returns The provider-neutral stop reason, or undefined for a non-terminal status.
 */
export function normalizeResponsesStopReason(
	status: string | null | undefined,
	incompleteReason?: string | null,
): ApiStopReason | undefined {
	if (status === "completed") return "end_turn"
	if (status !== "incomplete") return undefined
	if (incompleteReason === "max_output_tokens") return "output_limit"
	if (incompleteReason === "content_filter") return "content_filter"
	return "other"
}
