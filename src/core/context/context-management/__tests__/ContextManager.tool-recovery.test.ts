import { convertToOpenAIResponsesInput } from "@core/api/transform/openai-response-format"
import type { ClineStorageMessage, ClineUserToolResultContentBlock } from "@shared/messages/content"
import { normalizeLegacyConversation } from "@shared/messages/legacy-identity-migration"
import { describe, expect, it } from "vitest"
import { ContextManager } from "../ContextManager"

function toolUseHistory(userContent: ClineStorageMessage["content"]): ClineStorageMessage[] {
	return [
		{ role: "user", content: "Initial task" },
		{ role: "assistant", content: "Starting work" },
		{
			role: "assistant",
			content: [
				{
					type: "tool_use",
					function_id: "call_status_update",
					dline_tid: "dline_status_update",
					provider_metadata: { item_id: "fc_status_item" },
					name: "status_update",
					input: { response: "Working" },
				},
			],
		},
		{ role: "user", content: userContent },
	]
}

function repairedResult(history: ClineStorageMessage[]): ClineUserToolResultContentBlock {
	const repaired = new ContextManager().getTruncatedMessages(history, undefined) as ClineStorageMessage[]
	const content = repaired[3].content
	if (!Array.isArray(content) || content[0]?.type !== "tool_result") {
		throw new Error("Expected a repaired canonical tool result")
	}
	return content[0]
}

describe("ContextManager canonical tool-result recovery", () => {
	it("synthesizes a provider-projectable result when execution history lost the result", () => {
		const history = toolUseHistory([{ type: "text", text: "<environment_details />" }])

		const result = repairedResult(history)

		expect(result).toMatchObject({
			function_id: "call_status_update",
			dline_tid: "dline_status_update",
		})
		expect(result).not.toHaveProperty("tool_use_id")
		expect(result).not.toHaveProperty("call_id")
		expect(() =>
			convertToOpenAIResponsesInput(new ContextManager().getTruncatedMessages(history, undefined) as ClineStorageMessage[]),
		).not.toThrow()
	})

	it("normalizes a legacy result before strict provider projection", () => {
		const history = toolUseHistory([
			{
				type: "tool_result",
				tool_use_id: "call_status_update",
				content: [{ type: "text", text: "Legacy result" }],
			} as any,
		])

		const result = repairedResult(normalizeLegacyConversation(history))

		expect(result.function_id).toBe("call_status_update")
		expect(result.dline_tid).toBe("dline_status_update")
		expect(result).not.toHaveProperty("tool_use_id")
		expect(result).not.toHaveProperty("call_id")
	})

	it("demotes a Dline-owned orphaned result to user text", () => {
		const history: ClineStorageMessage[] = [
			{ role: "user", content: [{ type: "text", text: "Initial task" }] },
			{ role: "assistant", content: [{ type: "text", text: "Attempted an internal XML tool call" }] },
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						function_id: "dline_function_internal_rejection",
						dline_tid: "dline_tid_internal_rejection",
						content: [
							{
								type: "text",
								text: "Explicit-only tool was rejected: explicit_instruction_missing.",
							},
						],
						is_error: true,
					},
					{ type: "text", text: "<environment_details />" },
				],
			},
		]

		const repaired = new ContextManager().getTruncatedMessages(history, undefined) as ClineStorageMessage[]
		const repairedContent = repaired[2].content
		const projected = convertToOpenAIResponsesInput(repaired)

		expect(Array.isArray(repairedContent)).toBe(true)
		expect(JSON.stringify(repairedContent)).toContain("explicit_instruction_missing")
		expect(JSON.stringify(repairedContent)).not.toContain("dline_function_internal_rejection")
		expect(JSON.stringify(projected.input)).toContain("explicit_instruction_missing")
		expect(JSON.stringify(projected.input)).not.toContain("function_call_output")
	})

	it("keeps the images of a demoted Dline-owned result as native image blocks", () => {
		const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
		const history: ClineStorageMessage[] = [
			{ role: "user", content: [{ type: "text", text: "Initial task" }] },
			{ role: "assistant", content: [{ type: "text", text: "Attempted an internal XML tool call" }] },
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						function_id: "dline_function_screenshot",
						dline_tid: "dline_tid_screenshot",
						content: [
							{ type: "text", text: "Screenshot attached." },
							{ type: "image", source: { type: "base64", media_type: "image/png", data: imageData } },
						],
					},
				],
			},
		]

		const repaired = new ContextManager().getTruncatedMessages(history, undefined) as ClineStorageMessage[]

		expect(repaired[2].content).toEqual([
			{ type: "text", text: "Screenshot attached." },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: imageData } },
		])
	})

	it("removes an orphaned result after a compacted summary while preserving explicit user feedback", () => {
		const history: ClineStorageMessage[] = [
			{ role: "user", content: [{ type: "text", text: "Compacted summary" }] },
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						function_id: "call_removed_turn",
						dline_tid: "dline_removed_turn",
						content: [
							{
								type: "text",
								text: "[qna_respond] Result:\n<feedback>\nPreserve the unresolved requirement\n</feedback>",
							},
						],
					},
				],
			},
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						function_id: "call_current_turn",
						dline_tid: "dline_current_turn",
						name: "qna_respond",
						input: { response: "Continue" },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						function_id: "call_current_turn",
						dline_tid: "dline_current_turn",
						content: [{ type: "text", text: "Current result" }],
					},
				],
			},
		]

		const repaired = new ContextManager().getTruncatedMessages(history, undefined) as ClineStorageMessage[]
		const orphanBoundaryContent = repaired[1].content
		const currentResultContent = repaired[3].content

		expect(Array.isArray(orphanBoundaryContent)).toBe(true)
		expect(JSON.stringify(orphanBoundaryContent)).not.toContain("call_removed_turn")
		expect(JSON.stringify(orphanBoundaryContent)).toContain("Preserve the unresolved requirement")
		expect(JSON.stringify(currentResultContent)).toContain("call_current_turn")
	})
})
