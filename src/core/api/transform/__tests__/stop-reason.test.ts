import { describe, expect, it } from "vitest"
import { normalizeAnthropicStopReason, normalizeOpenAIFinishReason, normalizeResponsesStopReason } from "../stop-reason"

describe("Provider stop reason normalization", () => {
	it.each([
		[null, undefined],
		[undefined, undefined],
		["end_turn", "end_turn"],
		["tool_use", "tool_use"],
		["max_tokens", "output_limit"],
		["model_context_window_exceeded", "output_limit"],
		["stop_sequence", "stop_sequence"],
		["refusal", "content_filter"],
		["pause_turn", "other"],
	])("maps Anthropic stop_reason %s to %s", (reason, expected) => {
		expect(normalizeAnthropicStopReason(reason)).toBe(expected)
	})

	it.each([
		[null, undefined],
		[undefined, undefined],
		["stop", "end_turn"],
		["tool_calls", "tool_use"],
		["function_call", "tool_use"],
		["length", "output_limit"],
		["content_filter", "content_filter"],
		["network_error", "other"],
	])("maps OpenAI finish_reason %s to %s", (reason, expected) => {
		expect(normalizeOpenAIFinishReason(reason)).toBe(expected)
	})

	it.each([
		["completed", undefined, "end_turn"],
		["incomplete", "max_output_tokens", "output_limit"],
		["incomplete", "content_filter", "content_filter"],
		["incomplete", null, "other"],
		["in_progress", undefined, undefined],
		["failed", undefined, undefined],
		[undefined, undefined, undefined],
	])("maps Responses status %s with reason %s to %s", (status, incompleteReason, expected) => {
		expect(normalizeResponsesStopReason(status, incompleteReason)).toBe(expected)
	})
})
