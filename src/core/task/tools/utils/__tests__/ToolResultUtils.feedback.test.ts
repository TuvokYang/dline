import { strict as assert } from "node:assert"
import type { ToolUse } from "@core/assistant-message"
import { MAX_TOOL_RESULT_TEXT_BYTES } from "@shared/content-limits"
import { describe, expect, it, vi } from "vitest"
import { ToolResultUtils } from "../ToolResultUtils"

/**
 * Create a minimal tool block for tool result tests.
 *
 * @returns Tool use block with canonical native identities.
 */
function createBlock(functionId = "call-1"): ToolUse {
	return {
		type: "tool_use",
		name: "write_to_file",
		params: {},
		partial: false,
		function_id: functionId,
		dline_tid: `dline_tid_${functionId}`,
		isNativeToolCall: true,
		ts: 1,
	} as ToolUse
}

/**
 * Describe a tool block for tool result tests.
 *
 * @param block Tool use block.
 * @returns Human-readable tool description.
 */
function describeTool(block: ToolUse): string {
	return `[${block.name}]`
}

describe("ToolResultUtils approval feedback", () => {
	it("merges approval feedback into the following native tool_result", () => {
		const userMessageContent: any[] = []
		ToolResultUtils.pushAdditionalToolFeedback(userMessageContent, "请继续，但注意边界", undefined, undefined)

		ToolResultUtils.pushToolResult("File written.", createBlock(), userMessageContent, describeTool, undefined)

		assert.equal(userMessageContent.length, 1)
		const toolResult = userMessageContent[0]
		assert.equal(toolResult.type, "tool_result")
		assert.equal(toolResult.function_id, "call-1")
		assert.equal(toolResult.dline_tid, "dline_tid_call-1")
		assert.equal("tool_use_id" in toolResult, false)
		assert.equal("item_id" in toolResult, false)
		assert.match(toolResult.content[0].text, /\[write_to_file\] Result:\nFile written\./)
		assert.match(toolResult.content[1].text, /<feedback>\n请继续，但注意边界\n<\/feedback>/)
	})

	it("does not leak approval feedback as a standalone text block", () => {
		const userMessageContent: any[] = []
		ToolResultUtils.pushAdditionalToolFeedback(userMessageContent, "不要单独写入 text", undefined, undefined)

		assert.equal(userMessageContent.length, 1)
		assert.equal(userMessageContent[0].type, "tool_feedback")

		ToolResultUtils.pushToolResult("Rejected.", createBlock(), userMessageContent, describeTool, undefined)

		assert.equal(
			userMessageContent.some((block) => block.type === "tool_feedback"),
			false,
		)
		assert.equal(
			userMessageContent.some((block) => block.type === "text"),
			false,
		)
	})

	it("bounds every canonical result independently across parallel tool calls", () => {
		const userMessageContent: any[] = []

		ToolResultUtils.pushToolResult(
			"😀".repeat(100_000),
			createBlock("call-large-a"),
			userMessageContent,
			describeTool,
			undefined,
		)
		ToolResultUtils.pushToolResult(
			"x".repeat(100_000),
			createBlock("call-large-b"),
			userMessageContent,
			describeTool,
			undefined,
		)

		expect(userMessageContent).toHaveLength(2)
		for (const result of userMessageContent) {
			const text = result.content[0].text as string
			expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_TOOL_RESULT_TEXT_BYTES)
			expect(text).toContain("[FILE TRUNCATED:")
		}
		expect(userMessageContent[1]).toMatchObject({ function_id: "call-large-b", dline_tid: "dline_tid_call-large-b" })
	})
})
