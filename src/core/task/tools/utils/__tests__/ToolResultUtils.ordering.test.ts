import { strict as assert } from "node:assert"
import type { ToolUse } from "@core/assistant-message"
import { describe, it } from "vitest"
import { ToolResultUtils } from "../ToolResultUtils"

/**
 * Create a minimal native tool block for ordering tests.
 *
 * @param functionId Canonical pairing identity.
 * @param name Tool name reported to the model.
 * @returns Tool use block with canonical native identities.
 */
function createBlock(functionId: string, name = "read_file"): ToolUse {
    return {
        type: "tool_use",
        name,
        params: {},
        partial: false,
        function_id: functionId,
        dline_tid: `dline_tid_${functionId}`,
        isNativeToolCall: true,
        ts: 1,
    } as ToolUse
}

/**
 * Describe a tool block for ordering tests.
 *
 * @param block Tool use block.
 * @returns Human-readable tool description.
 */
function describeTool(block: ToolUse): string {
    return `[${block.name}]`
}

describe("ToolResultUtils tool_result ordering", () => {
    it("places the tool_result before a block pushed while the same call ran", () => {
        // A block pushed into userMessageContent before the handler returns
        // would otherwise put the result behind it.
        const userMessageContent: any[] = [{ type: "image", source: { type: "url", url: "file://a.png" } }]

        ToolResultUtils.pushToolResult("result", createBlock("call-image"), userMessageContent, describeTool, undefined)

        assert.equal(userMessageContent[0].type, "tool_result")
        assert.equal(userMessageContent[0].function_id, "call-image")
        assert.equal(userMessageContent[1].type, "image")
    })

    it("keeps every tool_result of a parallel batch ahead of non-result blocks", () => {
        const userMessageContent: any[] = [{ type: "image", source: { type: "url", url: "file://a.png" } }]

        ToolResultUtils.pushToolResult("first", createBlock("call-1"), userMessageContent, describeTool, undefined)
        userMessageContent.push({ type: "text", text: "hook context" })
        ToolResultUtils.pushToolResult("second", createBlock("call-2"), userMessageContent, describeTool, undefined)

        const types = userMessageContent.map((block) => block.type)
        assert.deepEqual(types, ["tool_result", "tool_result", "image", "text"])
        assert.equal(userMessageContent[0].function_id, "call-1")
        assert.equal(userMessageContent[1].function_id, "call-2")
    })

    it("replaces a re-executed tool_result in place without reordering the batch", () => {
        const userMessageContent: any[] = []

        ToolResultUtils.pushToolResult("first", createBlock("call-1"), userMessageContent, describeTool, undefined)
        ToolResultUtils.pushToolResult("second", createBlock("call-2"), userMessageContent, describeTool, undefined)
        ToolResultUtils.pushToolResult("first retried", createBlock("call-1"), userMessageContent, describeTool, undefined)

        assert.equal(userMessageContent.length, 2)
        assert.equal(userMessageContent[0].function_id, "call-1")
        assert.equal(userMessageContent[1].function_id, "call-2")
        assert.match(userMessageContent[0].content[0].text, /first retried/)
    })
})
