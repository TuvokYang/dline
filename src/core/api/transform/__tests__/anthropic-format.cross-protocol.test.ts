/**
 * Anthropic replay boundary for reasoning produced by other protocols (BUGFIX-088).
 *
 * A task can switch profiles mid-conversation. Reasoning payloads are only valid for the
 * protocol that issued them: OpenAI Responses encrypted reasoning replayed as
 * `redacted_thinking.data` is rejected with `Invalid data in redacted_thinking block`, and a
 * Gemini thought signature replayed as a Claude `thinking.signature` fails verification.
 */

import type Anthropic from "@anthropic-ai/sdk"
import { describe, expect, it } from "vitest"
import type {
	ClineAssistantRedactedThinkingBlock,
	ClineAssistantThinkingBlock,
	ClineAssistantToolUseBlock,
	ClineStorageMessage,
	ClineUserToolResultContentBlock,
} from "@/shared/messages/content"
import { normalizeLegacyConversation } from "@/shared/messages/legacy-identity-migration"
import { sanitizeAnthropicMessages } from "../anthropic-format"

const EPHEMERAL = { type: "ephemeral" } as const

function toolUse(functionId: string): ClineAssistantToolUseBlock {
	return {
		type: "tool_use",
		function_id: functionId,
		dline_tid: `tid-${functionId}`,
		name: "read_file",
		input: { path: "a.ts" },
	}
}

function toolResult(functionId: string): ClineUserToolResultContentBlock {
	return { type: "tool_result", function_id: functionId, dline_tid: `tid-${functionId}`, content: "file contents" }
}

/** Encrypted reasoning item recorded from an OpenAI Responses stream. */
function openAiEncryptedReasoning(itemId: string): ClineAssistantRedactedThinkingBlock {
	return { type: "redacted_thinking", data: `openai-ciphertext-${itemId}`, provider_metadata: { response_id: itemId } }
}

/** Reasoning summary recorded from an OpenAI Responses stream; it never carries a signature. */
function openAiReasoningSummary(itemId: string): ClineAssistantThinkingBlock {
	return {
		type: "thinking",
		thinking: "",
		signature: "",
		summary: [{ type: "summary_text", text: "Plan the read" }],
		provider_metadata: { response_id: itemId },
	}
}

function contentTypes(message: Anthropic.MessageParam): string[] {
	return typeof message.content === "string" ? ["string"] : message.content.map((block) => block.type)
}

describe("sanitizeAnthropicMessages cross-protocol reasoning", () => {
	it("drops OpenAI Responses encrypted reasoning while keeping the tool round trip", () => {
		const messages: ClineStorageMessage[] = [
			{ role: "user", content: "Inspect a.ts" },
			{
				role: "assistant",
				content: [
					openAiEncryptedReasoning("rs_1"),
					openAiReasoningSummary("rs_1"),
					{ type: "text", text: "Reading the file." },
					toolUse("call_1"),
				],
			},
			{ role: "user", content: [toolResult("call_1")] },
		]

		const result = sanitizeAnthropicMessages(messages, false)

		expect(result).toHaveLength(3)
		expect(contentTypes(result[1])).toEqual(["text", "tool_use"])
		expect(result[1].content).toContainEqual({ type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.ts" } })
		expect(result[2].content).toEqual([{ type: "tool_result", tool_use_id: "call_1", content: "file contents" }])
	})

	it("drops a Gemini-signed thinking block identified by its response id", () => {
		const geminiThinking: ClineAssistantThinkingBlock = {
			type: "thinking",
			thinking: "Gemini thought",
			signature: "gemini-thought-signature",
			provider_metadata: { response_id: "gemini-response-1" },
		}
		const messages: ClineStorageMessage[] = [
			{ role: "user", content: "Hi" },
			{ role: "assistant", content: [geminiThinking, { type: "text", text: "Hello" }] },
			{ role: "user", content: "Continue" },
		]

		const result = sanitizeAnthropicMessages(messages, false)

		expect(contentTypes(result[1])).toEqual(["text"])
	})

	it("drops a Gemini-signed thinking block whose response id was absent before persistence", () => {
		// Gemini attaches `{ response_id: chunk.responseId }` even when the id is missing; JSON persists `{}`.
		const persisted = JSON.parse(
			JSON.stringify({
				type: "thinking",
				thinking: "Gemini thought",
				signature: "gemini-thought-signature",
				provider_metadata: { response_id: undefined },
			}),
		) as ClineAssistantThinkingBlock
		expect(persisted.provider_metadata).toEqual({})

		const messages: ClineStorageMessage[] = [
			{ role: "user", content: "Hi" },
			{ role: "assistant", content: [persisted, { type: "text", text: "Hello" }] },
			{ role: "user", content: "Continue" },
		]

		const result = sanitizeAnthropicMessages(messages, false)

		expect(contentTypes(result[1])).toEqual(["text"])
	})

	it("prunes an assistant turn that only held foreign reasoning and re-anchors cache control", () => {
		const messages: ClineStorageMessage[] = [
			{ role: "user", content: "A" },
			{ role: "assistant", content: "ok" },
			{ role: "user", content: "B" },
			{ role: "assistant", content: [openAiEncryptedReasoning("rs_2"), openAiReasoningSummary("rs_2")] },
			{ role: "user", content: "C" },
		]

		const result = sanitizeAnthropicMessages(messages, true)

		expect(result).toEqual([
			{ role: "user", content: "A" },
			{ role: "assistant", content: "ok" },
			{ role: "user", content: [{ type: "text", text: "B", cache_control: EPHEMERAL }] },
			{ role: "user", content: [{ type: "text", text: "C", cache_control: EPHEMERAL }] },
		])
	})

	it("keeps interruption text while dropping the interrupted foreign reasoning", () => {
		const messages: ClineStorageMessage[] = [
			{ role: "user", content: "Start" },
			{
				role: "assistant",
				content: [
					openAiEncryptedReasoning("rs_3"),
					{ type: "text", text: "Partial answer\n\n[Response interrupted by user]" },
				],
			},
			{ role: "user", content: "Resume" },
		]

		const result = sanitizeAnthropicMessages(messages, false)

		expect(result[1].content).toEqual([{ type: "text", text: "Partial answer\n\n[Response interrupted by user]" }])
	})
})

describe("sanitizeAnthropicMessages native reasoning preservation", () => {
	it("replays Anthropic thinking and redacted thinking complete, unmodified, and in order", () => {
		const messages: ClineStorageMessage[] = [
			{ role: "user", content: "Inspect a.ts" },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "", signature: "claude-signature" },
					{ type: "redacted_thinking", data: "claude-ciphertext" },
					toolUse("toolu_1"),
				],
			},
			{ role: "user", content: [toolResult("toolu_1")] },
		]

		const result = sanitizeAnthropicMessages(messages, false)

		expect(result[1].content).toStrictEqual([
			{ type: "thinking", thinking: "", signature: "claude-signature" },
			{ type: "redacted_thinking", data: "claude-ciphertext" },
			{ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.ts" } },
		])
	})

	it("treats an in-memory reasoning block with undefined provider metadata as native", () => {
		// ReasoningHandler assigns `provider_metadata: undefined` for Anthropic-family streams.
		const messages: ClineStorageMessage[] = [
			{ role: "user", content: "Hi" },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "t", signature: "claude-signature", summary: [], provider_metadata: undefined },
					{ type: "redacted_thinking", data: "claude-ciphertext", provider_metadata: undefined },
					{ type: "text", text: "Hello" },
				],
			},
			{ role: "user", content: "Continue" },
		]

		const result = sanitizeAnthropicMessages(messages, false)

		expect(result[1].content).toStrictEqual([
			{ type: "thinking", thinking: "t", signature: "claude-signature" },
			{ type: "redacted_thinking", data: "claude-ciphertext" },
			{ type: "text", text: "Hello" },
		])
	})

	it("still drops unsigned thinking and leaves string conversations untouched", () => {
		const messages: ClineStorageMessage[] = [
			{ role: "user", content: "a" },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "no signature", signature: "" },
					{ type: "text", text: "b" },
				],
			},
			{ role: "user", content: "c" },
		]

		const result = sanitizeAnthropicMessages(messages, true)

		expect(result).toEqual([
			{ role: "user", content: [{ type: "text", text: "a", cache_control: EPHEMERAL }] },
			{ role: "assistant", content: [{ type: "text", text: "b" }] },
			{ role: "user", content: [{ type: "text", text: "c", cache_control: EPHEMERAL }] },
		])
	})

	it("treats legacy reasoning whose call_id was migrated into a response id as foreign", () => {
		// Residual risk documented in BUGFIX-088: legacy migration maps a block `call_id` to
		// `provider_metadata.response_id`, which marks the block as another protocol's reasoning.
		const [user, assistant] = normalizeLegacyConversation([
			{ role: "user", content: "Hi" },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "legacy", signature: "legacy-signature", call_id: "legacy-1" },
					{ type: "text", text: "Hello" },
				],
			},
		])

		const result = sanitizeAnthropicMessages([user, assistant, { role: "user", content: "Continue" }], false)

		expect(contentTypes(result[1])).toEqual(["text"])
	})
})
