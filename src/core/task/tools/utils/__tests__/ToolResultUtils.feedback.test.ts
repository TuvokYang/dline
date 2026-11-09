import { strict as assert } from "node:assert"
import type { ToolUse } from "@core/assistant-message"
import { MAX_TOOL_RESULT_TEXT_BYTES } from "@shared/content-limits"
import { describe, expect, it } from "vitest"
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
    it("keeps keyed approval feedback with its own parallel tool result", () => {
        const userMessageContent: Parameters<typeof ToolResultUtils.pushToolResult>[2] = []
        ToolResultUtils.pushAdditionalToolFeedback(
            userMessageContent,
            "note for second tool",
            undefined,
            undefined,
            "dline_tid_call-2",
        )

        ToolResultUtils.pushToolResult("First result.", createBlock("call-1"), userMessageContent, describeTool, undefined)

        assert.equal(userMessageContent.length, 2)
        assert.equal(userMessageContent[0].type, "tool_result")
        assert.equal(userMessageContent[1].type, "tool_feedback")
        if (userMessageContent[0].type !== "tool_result") assert.fail("expected first tool result")
        expect(JSON.stringify(userMessageContent[0].content)).not.toContain("note for second tool")

        ToolResultUtils.pushToolResult("Second result.", createBlock("call-2"), userMessageContent, describeTool, undefined)

        assert.equal(userMessageContent.length, 2)
        const secondResult = userMessageContent.find((block) => block.type === "tool_result" && block.function_id === "call-2")
        if (!secondResult || secondResult.type !== "tool_result") assert.fail("expected second tool result")
        expect(JSON.stringify(secondResult.content)).toContain("note for second tool")
    })

    it("bounds every canonical result independently across parallel tool calls", () => {
        const userMessageContent: Parameters<typeof ToolResultUtils.pushToolResult>[2] = []

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
            assert.equal(result.type, "tool_result")
            if (result.type !== "tool_result") throw new Error("Expected canonical tool result")
            assert.ok(Array.isArray(result.content))
            const firstBlock = result.content[0]
            assert.equal(firstBlock?.type, "text")
            const text = firstBlock?.type === "text" ? firstBlock.text : ""
            expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_TOOL_RESULT_TEXT_BYTES)
            expect(text.includes("[OUTPUT TRUNCATED:")).toBe(true)
        }
        expect(userMessageContent[1]).toMatchObject({ function_id: "call-large-b", dline_tid: "dline_tid_call-large-b" })
    })
})
