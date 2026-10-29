import { describe, expect, it } from "vitest"
import type { ClineAssistantToolUseBlock, ClineStorageMessage, ClineUserToolResultContentBlock } from "@/shared/messages/content"
import { convertToOpenAIResponsesInput } from "../openai-response-format"

describe("OpenAI Responses identity projection", () => {
    it("projects only the canonical function identity without requiring persisted provider item metadata", () => {
        const toolUse: ClineAssistantToolUseBlock = {
            type: "tool_use",
            function_id: "call_123",
            dline_tid: "dline_tid_test",
            name: "read_file",
            input: { path: "README.md" },
        }
        const toolResult: ClineUserToolResultContentBlock = {
            type: "tool_result",
            function_id: "call_123",
            dline_tid: "dline_tid_test",
            content: "file contents",
        }
        const messages: ClineStorageMessage[] = [
            { role: "assistant", content: [toolUse] },
            { role: "user", content: [toolResult] },
        ]

        const { input } = convertToOpenAIResponsesInput(messages)

        expect(input).toEqual([
            {
                type: "function_call",
                call_id: "call_123",
                name: "read_file",
                arguments: '{"path":"README.md"}',
            },
            {
                type: "function_call_output",
                call_id: "call_123",
                output: "file contents",
            },
        ])
        expect(JSON.stringify(input)).not.toContain("dline_tid")
        expect(JSON.stringify(input)).not.toContain("item_id")
    })

    it("demotes the condense tool result appended after keep=none truncation deleted its tool_use", () => {
        // Reproduction of the manual /compact + confirm_utility flow:
        // 1. History ends with assistant(condense tool_use, dline_function_X) + user(tool_result).
        // 2. CondenseHandler truncates with keep="none", deleting the assistant turn that
        //    carries the condense tool_use (the handler does NOT set currentlySummarizing,
        //    so no projectCompletedCompactionResult projection runs for it).
        // 3. The handler returns a new tool_result which is appended as the latest user
        //    message with a fresh dline_function_* identity - now orphaned.
        // The projection must demote that orphan instead of emitting function_call_output,
        // which upstream rejects with "No tool call found for tool output".
        const truncatedHistory: ClineStorageMessage[] = [
            { role: "user", content: [{ type: "text", text: "Initial task" }] },
            { role: "assistant", content: [{ type: "text", text: "Response 1" }] },
            {
                role: "user",
                content: [
                    {
                        type: "tool_result",
                        function_id: `dline_function_${"0".repeat(26)}`,
                        dline_tid: "dline_tid_condense",
                        content: "Condensed conversation summary content",
                    },
                ],
            },
        ]

        const { input } = convertToOpenAIResponsesInput(truncatedHistory)

        expect(input).toEqual([
            { role: "user", content: [{ type: "input_text", text: "Initial task" }] },
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "Response 1" }] },
            {
                role: "user",
                content: [{ type: "input_text", text: "Condensed conversation summary content" }],
            },
        ])
        expect(JSON.stringify(input)).not.toContain("function_call_output")
        expect(JSON.stringify(input)).not.toContain("call_dline_")
    })

    it("demotes orphaned tool outputs to user text instead of emitting function_call_output", () => {
        // The pairing function_call was truncated away; only the tool output remains.
        const toolResult: ClineUserToolResultContentBlock = {
            type: "tool_result",
            function_id: `dline_function_${"0".repeat(26)}`,
            dline_tid: "dline_tid_orphan",
            content: "orphan output content",
        }
        const messages: ClineStorageMessage[] = [{ role: "user", content: [toolResult] }]

        const { input } = convertToOpenAIResponsesInput(messages)

        expect(input).toEqual([
            {
                role: "user",
                content: [{ type: "input_text", text: "orphan output content" }],
            },
        ])
        expect(JSON.stringify(input)).not.toContain("function_call_output")
        expect(JSON.stringify(input)).not.toContain("call_dline_")
    })

    it("projects Dline-owned function ids into Responses call_id fields", () => {
        const dlineFunctionId = `dline_function_${"0".repeat(26)}`
        const toolUse: ClineAssistantToolUseBlock = {
            type: "tool_use",
            function_id: dlineFunctionId,
            dline_tid: "dline_tid_test",
            name: "read_file",
            input: { path: "README.md" },
        }
        const toolResult: ClineUserToolResultContentBlock = {
            type: "tool_result",
            function_id: dlineFunctionId,
            dline_tid: "dline_tid_test",
            content: "file contents",
        }
        const messages: ClineStorageMessage[] = [
            { role: "assistant", content: [toolUse] },
            { role: "user", content: [toolResult] },
        ]

        const { input } = convertToOpenAIResponsesInput(messages)

        const call = input.find((item) => item.type === "function_call")
        const output = input.find((item) => item.type === "function_call_output")
        expect(call?.type).toBe("function_call")
        expect(output?.type).toBe("function_call_output")
        expect(String(call?.call_id)).toMatch(/^call_/)
        expect(String(call?.call_id).length).toBeLessThanOrEqual(40)
        expect(String(output?.call_id)).toBe(String(call?.call_id))
        expect(JSON.stringify(input)).not.toContain("dline_function_")
        expect(JSON.stringify(input)).not.toContain("dline_tid")
    })
})
