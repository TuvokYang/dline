/**
 * Contract tests for tool call parsing and transformation.
 *
 * These tests verify that tool calls are correctly parsed and transformed
 * between different API formats (Anthropic, OpenAI, etc.). This is critical
 * because incorrect tool parsing can cause:
 * - Tool calls not being executed
 * - Mismatched tool_call_id causing API errors
 * - Lost tool results breaking conversation flow
 */

import { describe, it } from "vitest"
import "should"
import OpenAI from "openai"
import {
    ClineAssistantToolUseBlock,
    ClineStorageMessage,
    ClineTextContentBlock,
    ClineUserToolResultContentBlock,
} from "@/shared/messages/content"
import { sanitizeAnthropicMessages } from "../anthropic-format"
import { convertToAnthropicMessage, convertToOpenAiMessages } from "../openai-format"

describe("Tool Call Parsing", () => {
    describe("convertToOpenAiMessages - Tool Calls", () => {
        it("should convert Anthropic tool_use to OpenAI tool_calls format", () => {
            const messages: ClineStorageMessage[] = [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_use",
                            function_id: "toolu_abc123",
                            dline_tid: "tid_abc123",
                            name: "read_file",
                            input: { path: "/test/file.ts" },
                        } as unknown as ClineAssistantToolUseBlock,
                    ],
                },
            ]

            const result = convertToOpenAiMessages(messages, "openai")

            result.should.have.length(1)
            const msg = result[0] as any
            msg.role.should.equal("assistant")
            msg.tool_calls.should.have.length(1)
            msg.tool_calls[0].type.should.equal("function")
            msg.tool_calls[0].function.name.should.equal("read_file")
            JSON.parse(msg.tool_calls[0].function.arguments).should.deepEqual({ path: "/test/file.ts" })
        })

        it("should transform OpenAI Responses API tool IDs (fc_ prefix)", () => {
            // OpenAI Responses API uses fc_ prefix with 53 char length
            const responsesApiId = `fc_${"x".repeat(50)}`
            const messages: ClineStorageMessage[] = [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_use",
                            function_id: responsesApiId,
                            dline_tid: "tid_responses",
                            name: "test_tool",
                            input: {},
                        } as unknown as ClineAssistantToolUseBlock,
                    ],
                },
            ]

            const result = convertToOpenAiMessages(messages)

            const msg = result[0] as any
            // Should be transformed to call_ prefix format
            msg.tool_calls[0].id.should.startWith("call_")
            msg.tool_calls[0].id.length.should.be.belowOrEqual(40)
        })

        it("should reject non-canonical Chat tool blocks", () => {
            const messages: ClineStorageMessage[] = [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_use",
                            id: "legacy_only",
                            name: "read_file",
                            input: { path: "/test.ts" },
                        } as unknown as ClineAssistantToolUseBlock,
                    ],
                },
            ]

            ;(() => convertToOpenAiMessages(messages, "openai")).should.throw(/missing function_id/)
        })

        it("should project canonical function_id to both Chat pairing fields", () => {
            const functionId = `call_${"p".repeat(50)}`
            const messages: ClineStorageMessage[] = [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_use",
                            function_id: functionId,
                            dline_tid: "dline_tid_pair",
                            name: "read_file",
                            input: { path: "/test.ts" },
                        } as ClineAssistantToolUseBlock,
                    ],
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "tool_result",
                            function_id: functionId,
                            dline_tid: "dline_tid_pair",
                            content: "file contents here",
                        } as ClineUserToolResultContentBlock,
                    ],
                },
            ]

            const result = convertToOpenAiMessages(messages, "openai")
            const assistantMsg = result[0] as OpenAI.Chat.ChatCompletionAssistantMessageParam
            const toolMsg = result[1] as OpenAI.Chat.ChatCompletionToolMessageParam

            assistantMsg.tool_calls?.[0].id.should.equal(toolMsg.tool_call_id)
            assistantMsg.tool_calls?.[0].id.should.equal(toolMsg.tool_call_id)
            JSON.stringify(result).should.not.match(/item_id|function_id|dline_tid/)
        })

        it("should project Dline-owned function ids into the provider call-id domain", () => {
            const dlineFunctionId = `dline_function_${"0".repeat(26)}`
            const messages: ClineStorageMessage[] = [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_use",
                            function_id: dlineFunctionId,
                            dline_tid: "dline_tid_pair",
                            name: "read_file",
                            input: { path: "/test.ts" },
                        } as ClineAssistantToolUseBlock,
                    ],
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "tool_result",
                            function_id: dlineFunctionId,
                            dline_tid: "dline_tid_pair",
                            content: "file contents here",
                        } as ClineUserToolResultContentBlock,
                    ],
                },
            ]

            const result = convertToOpenAiMessages(messages, "openai")
            const assistantMsg = result[0] as OpenAI.Chat.ChatCompletionAssistantMessageParam
            const toolMsg = result[1] as OpenAI.Chat.ChatCompletionToolMessageParam

            const projectedId = assistantMsg.tool_calls?.[0].id
            projectedId?.should.startWith("call_")
            projectedId?.length.should.be.belowOrEqual(40)
            toolMsg.tool_call_id.should.equal(projectedId)
            JSON.stringify(result).should.not.match(/dline_function_|dline_tid/)
        })

        it("should match tool_call_id with tool_calls id for tool results", () => {
            const toolId = "toolu_abc123"
            const messages: ClineStorageMessage[] = [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_use",
                            function_id: toolId,
                            dline_tid: "tid_match",
                            name: "read_file",
                            input: { path: "/test.ts" },
                        } as ClineAssistantToolUseBlock,
                    ],
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "tool_result",
                            function_id: toolId,
                            dline_tid: "tid_match",
                            content: "file contents here",
                        } as ClineUserToolResultContentBlock,
                    ],
                },
            ]

            const result = convertToOpenAiMessages(messages)

            result.should.have.length(2)

            // Get the transformed tool_call id from assistant message
            const assistantMsg = result[0] as OpenAI.Chat.ChatCompletionAssistantMessageParam
            const transformedId = assistantMsg.tool_calls?.[0].id

            // The tool result should have the same transformed id
            const toolMsg = result[1] as OpenAI.Chat.ChatCompletionToolMessageParam
            toolMsg.tool_call_id.should.equal(transformedId)
        })

        it("should handle multiple tool calls in a single message", () => {
            const messages: ClineStorageMessage[] = [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: "I'll read both files",
                        } as ClineTextContentBlock,
                        {
                            type: "tool_use",
                            function_id: "tool_1",
                            dline_tid: "tid_tool_1",
                            name: "read_file",
                            input: { path: "/file1.ts" },
                        } as ClineAssistantToolUseBlock,
                        {
                            type: "tool_use",
                            function_id: "tool_2",
                            dline_tid: "tid_tool_2",
                            name: "read_file",
                            input: { path: "/file2.ts" },
                        } as ClineAssistantToolUseBlock,
                    ],
                },
            ]

            const result = convertToOpenAiMessages(messages)

            result.should.have.length(1)
            const msg = result[0] as any
            msg.tool_calls.should.have.length(2)
            msg.tool_calls[0].function.name.should.equal("read_file")
            msg.tool_calls[1].function.name.should.equal("read_file")
        })

        it("should handle tool results with array content", () => {
            const messages: ClineStorageMessage[] = [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_use",
                            function_id: "tool_123",
                            dline_tid: "tid_tool_123",
                            name: "read_file",
                            input: { path: "test.ts" },
                        } as unknown as ClineAssistantToolUseBlock,
                    ],
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "tool_result",
                            function_id: "tool_123",
                            dline_tid: "tid_tool_123",
                            content: [
                                { type: "text", text: "Line 1" },
                                { type: "text", text: "Line 2" },
                            ],
                        } as ClineUserToolResultContentBlock,
                    ],
                },
            ]

            const result = convertToOpenAiMessages(messages)

            result.should.have.length(2)
            const msg = result[1] as OpenAI.Chat.ChatCompletionToolMessageParam
            msg.role.should.equal("tool")
            msg.content.should.equal("Line 1\nLine 2")
        })

        it("should set content to null when only tool_calls present", () => {
            const messages: ClineStorageMessage[] = [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_use",
                            function_id: "tool_1",
                            dline_tid: "tid_tool_only",
                            name: "test",
                            input: {},
                        } as unknown as ClineAssistantToolUseBlock,
                    ],
                },
            ]

            const result = convertToOpenAiMessages(messages)

            const msg = result[0] as any
            // Content should be null, not undefined or empty string
            ;(msg.content === null).should.be.true()
        })

        it("should demote orphaned tool results to user text instead of emitting orphan tool messages", () => {
            // The pairing tool_use was truncated away; only the tool_result remains.
            const messages: ClineStorageMessage[] = [
                {
                    role: "user",
                    content: [
                        {
                            type: "tool_result",
                            function_id: "dline_function_00000000000000000000000000",
                            dline_tid: "tid_orphan",
                            content: "orphan result content",
                        } as ClineUserToolResultContentBlock,
                    ],
                },
            ]

            const result = convertToOpenAiMessages(messages)

            result.should.have.length(1)
            const msg = result[0] as OpenAI.Chat.ChatCompletionUserMessageParam
            msg.role.should.equal("user")
            msg.content.should.deepEqual([{ type: "text", text: "orphan result content" }])
            JSON.stringify(result).should.not.match(/call_dline_|tool_call_id/)
        })

        it("should keep paired tool results as tool messages after their tool_use is emitted", () => {
            const messages: ClineStorageMessage[] = [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_use",
                            function_id: "tool_123",
                            dline_tid: "tid_tool_123",
                            name: "read_file",
                            input: { path: "/test.ts" },
                        } as unknown as ClineAssistantToolUseBlock,
                    ],
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "tool_result",
                            function_id: "tool_123",
                            dline_tid: "tid_tool_123",
                            content: "file contents",
                        } as ClineUserToolResultContentBlock,
                    ],
                },
            ]

            const result = convertToOpenAiMessages(messages)

            result.should.have.length(2)
            const toolMsg = result[1] as OpenAI.Chat.ChatCompletionToolMessageParam
            toolMsg.role.should.equal("tool")
            toolMsg.tool_call_id.should.equal("tool_123")
            toolMsg.content.should.equal("file contents")
        })
    })

    describe("sanitizeAnthropicMessages - Canonical Tool Identity", () => {
        it("should reject non-canonical Anthropic tool blocks", () => {
            const messages: ClineStorageMessage[] = [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_use",
                            id: "legacy_only",
                            name: "read_file",
                            input: { path: "/test.ts" },
                        } as unknown as ClineAssistantToolUseBlock,
                    ],
                },
            ]

            ;(() => sanitizeAnthropicMessages(messages, false)).should.throw(/missing function_id/)
        })

        it("should preserve OpenAI-produced canonical tool pairing when the next request uses Anthropic", () => {
            const functionId = "call_openai_compatible_1"
            const dlineTid = "dline_runtime_1"
            const messages: ClineStorageMessage[] = [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_use",
                            function_id: functionId,
                            dline_tid: dlineTid,
                            name: "read_file",
                            input: { path: "/test.ts" },
                        } satisfies ClineAssistantToolUseBlock,
                    ],
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "tool_result",
                            function_id: functionId,
                            dline_tid: dlineTid,
                            content: "file contents",
                        } satisfies ClineUserToolResultContentBlock,
                    ],
                },
            ]

            const canonicalBeforeSwitch = JSON.stringify(messages)
            const result = sanitizeAnthropicMessages(messages, false)
            const toolUse = Array.isArray(result[0].content) ? result[0].content[0] : undefined
            const toolResult = Array.isArray(result[1].content) ? result[1].content[0] : undefined

            expect(toolUse).toMatchObject({ type: "tool_use", id: functionId })
            expect(toolResult).toMatchObject({ type: "tool_result", tool_use_id: functionId })
            expect(JSON.stringify(result)).not.toMatch(/function_id|dline_tid/)
            expect(JSON.stringify(messages)).toBe(canonicalBeforeSwitch)
        })

        it("should project function_id to Anthropic pairing fields and remove Dline metadata", () => {
            const messages: ClineStorageMessage[] = [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_use",
                            function_id: "call_provider_1",
                            dline_tid: "dline_tid_1",
                            name: "read_file",
                            input: { path: "/test.ts" },
                        } as ClineAssistantToolUseBlock,
                    ],
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "tool_result",
                            function_id: "call_provider_1",
                            dline_tid: "dline_tid_1",
                            content: "file contents",
                        } as ClineUserToolResultContentBlock,
                    ],
                },
            ]

            const result = sanitizeAnthropicMessages(messages, false)
            const toolUse = (result[0].content as any[])[0]
            const toolResult = (result[1].content as any[])[0]

            toolUse.id.should.equal("call_provider_1")
            toolResult.tool_use_id.should.equal("call_provider_1")
            JSON.stringify(result).should.not.match(/item_id|function_id|dline_tid|call_id/)
        })
    })

    describe("convertToAnthropicMessage - OpenAI Response to Anthropic", () => {
        it("should convert OpenAI completion to Anthropic message format", () => {
            const completion: OpenAI.Chat.Completions.ChatCompletion = {
                id: "chatcmpl-123",
                object: "chat.completion",
                created: Date.now(),
                model: "gpt-4o",
                choices: [
                    {
                        index: 0,
                        message: {
                            role: "assistant",
                            content: "Hello!",
                            refusal: null,
                        },
                        finish_reason: "stop",
                        logprobs: null,
                    },
                ],
                usage: {
                    prompt_tokens: 10,
                    completion_tokens: 5,
                    total_tokens: 15,
                },
            }

            const result = convertToAnthropicMessage(completion)

            result.id.should.equal("chatcmpl-123")
            result.role.should.equal("assistant")
            result.model.should.equal("gpt-4o")
            result.stop_reason?.should.equal("end_turn")
            result.usage.input_tokens.should.equal(10)
            result.usage.output_tokens.should.equal(5)

            const content = result.content as any[]
            content[0].type.should.equal("text")
            content[0].text.should.equal("Hello!")
        })

        it("should convert OpenAI tool_calls to Anthropic tool_use blocks", () => {
            const completion: OpenAI.Chat.Completions.ChatCompletion = {
                id: "chatcmpl-456",
                object: "chat.completion",
                created: Date.now(),
                model: "gpt-4o",
                choices: [
                    {
                        index: 0,
                        message: {
                            role: "assistant",
                            content: null,
                            tool_calls: [
                                {
                                    id: "call_abc",
                                    type: "function",
                                    function: {
                                        name: "read_file",
                                        arguments: '{"path":"/test.ts"}',
                                    },
                                },
                            ],
                            refusal: null,
                        },
                        finish_reason: "tool_calls",
                        logprobs: null,
                    },
                ],
            }

            const result = convertToAnthropicMessage(completion)

            result.stop_reason?.should.equal("tool_use")

            const content = result.content as any[]
            content.should.have.length(2) // text block + tool_use block

            const toolUse = content.find((b) => b.type === "tool_use")
            toolUse.should.not.be.undefined
            toolUse.id.should.equal("call_abc")
            toolUse.name.should.equal("read_file")
            toolUse.input.should.deepEqual({ path: "/test.ts" })
        })

        it("should handle malformed tool arguments gracefully", () => {
            const completion: OpenAI.Chat.Completions.ChatCompletion = {
                id: "chatcmpl-789",
                object: "chat.completion",
                created: Date.now(),
                model: "gpt-4o",
                choices: [
                    {
                        index: 0,
                        message: {
                            role: "assistant",
                            content: null,
                            tool_calls: [
                                {
                                    id: "call_bad",
                                    type: "function",
                                    function: {
                                        name: "test_tool",
                                        arguments: "not valid json",
                                    },
                                },
                            ],
                            refusal: null,
                        },
                        finish_reason: "tool_calls",
                        logprobs: null,
                    },
                ],
            }

            // Should not throw, should return empty input
            const result = convertToAnthropicMessage(completion)

            const content = result.content as any[]
            const toolUse = content.find((b) => b.type === "tool_use")
            toolUse.input.should.deepEqual({})
        })

        it("should map finish_reason correctly", () => {
            const testCases: Array<{ finish_reason: any; expected: string | null }> = [
                { finish_reason: "stop", expected: "end_turn" },
                { finish_reason: "length", expected: "max_tokens" },
                { finish_reason: "tool_calls", expected: "tool_use" },
                { finish_reason: "content_filter", expected: null },
            ]

            for (const { finish_reason, expected } of testCases) {
                const completion: OpenAI.Chat.Completions.ChatCompletion = {
                    id: "test",
                    object: "chat.completion",
                    created: Date.now(),
                    model: "test",
                    choices: [
                        {
                            index: 0,
                            message: { role: "assistant", content: "test", refusal: null },
                            finish_reason,
                            logprobs: null,
                        },
                    ],
                }

                const result = convertToAnthropicMessage(completion)
                // Using equality check since should.be.true() doesn't accept message arg
                ;(result.stop_reason === expected).should.be.true()
            }
        })
    })
})
