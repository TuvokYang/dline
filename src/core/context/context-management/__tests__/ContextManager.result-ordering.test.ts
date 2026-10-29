import type { ClineContent, ClineStorageMessage } from "@shared/messages/content"
import { describe, expect, it } from "vitest"
import { ContextManager } from "../ContextManager"

/**
 * Build a history whose user turn answers one read_file tool use.
 *
 * @param userContent Blocks persisted for the answering user message.
 * @returns Minimal canonical history ending with the answering user turn.
 */
function readImageHistory(userContent: ClineContent[]): ClineStorageMessage[] {
    return [
        { role: "user", content: "Initial task" },
        { role: "assistant", content: "Starting work" },
        {
            role: "assistant",
            content: [
                {
                    type: "tool_use",
                    function_id: "call_read_image",
                    dline_tid: "dline_read_image",
                    name: "read_file",
                    input: { path: "diagram.png" },
                },
            ],
        },
        { role: "user", content: userContent },
    ]
}

const imageBlock: ClineContent = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "AAAA" },
} as ClineContent

const toolResultBlock: ClineContent = {
    type: "tool_result",
    function_id: "call_read_image",
    dline_tid: "dline_read_image",
    content: [{ type: "text", text: "[read_file] Result:\nSuccessfully read image" }],
} as ClineContent

describe("ContextManager tool_result ordering repair", () => {
    it("moves a tool_result ahead of an image block persisted before it", () => {
        // Anthropic rejects a user message whose tool_result does not lead the
        // answering turn: "`tool_use` ids were found without `tool_result` blocks
        // immediately after". Legacy histories persisted image-first.
        const history = readImageHistory([imageBlock, toolResultBlock, { type: "text", text: "<environment_details />" }])

        const repaired = new ContextManager().getTruncatedMessages(history, undefined)
        const content = repaired[3].content

        expect(Array.isArray(content)).toBe(true)
        expect((content as ClineContent[]).map((block) => block.type)).toEqual(["tool_result", "image", "text"])
    })

    it("leaves an already ordered answering turn untouched", () => {
        const history = readImageHistory([toolResultBlock, imageBlock, { type: "text", text: "<environment_details />" }])

        const repaired = new ContextManager().getTruncatedMessages(history, undefined)

        expect(repaired[3]).toBe(history[3])
    })
})
