import { appendApiConversationEvent } from "@core/storage/disk"
import { ServerTool } from "@shared/proto/dline/models/metadata"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiStream } from "../../transform/stream"
import { recordProviderAdapterInput, recordProviderAdapterOutput } from "../api-conversation-log"

vi.mock("@core/storage/disk", () => ({
    appendApiConversationEvent: vi.fn().mockResolvedValue(undefined),
}))

const round = {
    taskId: "task-1",
    requestIndex: 3,
    provider: "gemini",
    model: "gemini-test",
    source: "task" as const,
}

describe("api_conversation_all round logging", () => {
    beforeEach(() => {
        vi.mocked(appendApiConversationEvent).mockClear()
    })

    it("records the canonical request without storage-only metrics", async () => {
        await recordProviderAdapterInput(round, {
            systemPrompt: "system",
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_use",
                            function_id: "function-1",
                            dline_tid: "tid-1",
                            name: "read_file",
                            input: { path: "README.md" },
                        },
                    ],
                    metrics: { tokens: { prompt: 1, completion: 2, cached: 0 } },
                },
            ],
        })

        const event = vi.mocked(appendApiConversationEvent).mock.calls[0][1] as any
        expect(event).toMatchObject({
            requestIndex: 3,
            direction: "request",
            stage: "provider_adapter_input",
            source: "task",
        })
        expect(event.payload.messages[0].content[0]).toMatchObject({
            function_id: "function-1",
            dline_tid: "tid-1",
        })
        expect(event.payload.messages[0]).not.toHaveProperty("metrics")
        expect(JSON.stringify(event.payload)).not.toContain("call_id")
        expect(JSON.stringify(event.payload)).not.toContain("tool_use_id")
    })

    it("redacts hosted preview and final image bytes from provider debug output without changing the live stream", async () => {
        const secretPreview = "very-secret-partial-base64-image"
        const secretFinal = "very-secret-final-base64-image"
        async function* source(): ApiStream {
            yield {
                type: "server_tool",
                function_id: "ig_1",
                tool: ServerTool.IMAGE_GENERATION,
                phase: "preview",
                result: { partialImageB64: secretPreview, sequence: 0 },
            }
            yield {
                type: "server_tool",
                function_id: "ig_1",
                tool: ServerTool.IMAGE_GENERATION,
                phase: "completed",
                result: { b64Json: secretFinal },
            }
        }

        const received = []
        for await (const chunk of recordProviderAdapterOutput(round, source())) received.push(chunk)

        expect(JSON.stringify(received)).toContain(secretPreview)
        expect(JSON.stringify(received)).toContain(secretFinal)
        const event = vi.mocked(appendApiConversationEvent).mock.calls[0][1] as any
        expect(JSON.stringify(event)).not.toContain(secretPreview)
        expect(JSON.stringify(event)).not.toContain(secretFinal)
        expect(event.payload.chunks.map((chunk: any) => chunk.result)).toEqual([
            { redacted: "hosted_image_bytes" },
            { redacted: "hosted_image_bytes" },
        ])
    })

    it("records one assembled response instead of one event per stream chunk", async () => {
        async function* source(): ApiStream {
            yield { type: "text", text: "hel", provider_metadata: { response_id: "response-1" } }
            yield { type: "text", text: "lo", provider_metadata: { response_id: "response-1" } }
            yield {
                type: "tool_calls",
                function_id: "function-1",
                tool_index: 0,
                tool_call: { function: { name: "read_file", arguments: '{"path":"' } },
            }
            yield {
                type: "tool_calls",
                function_id: "function-1",
                tool_index: 0,
                tool_call: { function: { arguments: 'README.md"}' } },
            }
        }

        const received = []
        for await (const chunk of recordProviderAdapterOutput(round, source())) {
            received.push(chunk)
        }

        expect(received).toHaveLength(4)
        const events = vi.mocked(appendApiConversationEvent).mock.calls.map((call) => call[1] as any)
        expect(events.map((event) => event.direction)).toEqual(["response", "response_end"])
        expect(events[0]).toMatchObject({
            stage: "provider_adapter_output",
            payload: {
                chunks: [
                    { type: "text", text: "hello", provider_metadata: { response_id: "response-1" } },
                    {
                        type: "tool_calls",
                        function_id: "function-1",
                        tool_index: 0,
                        tool_call: { function: { name: "read_file", arguments: '{"path":"README.md"}' } },
                    },
                ],
            },
        })
        expect(events[1].status).toBe("completed")
    })
})
