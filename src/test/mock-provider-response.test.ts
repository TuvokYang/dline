import { EventEmitter } from "node:events"
import type { ServerResponse } from "node:http"
import { describe, expect, it, vi } from "vitest"
import type { MockApiProtocol, OpenAiMockResponse } from "./e2e/fixtures/server"
import { writeProviderResponse } from "./e2e/fixtures/server/provider-response"

type Script = Exclude<OpenAiMockResponse, { type: "error" }>

class MemoryResponse extends EventEmitter {
    destroyed = false
    writableEnded = false
    readonly chunks: string[] = []
    headers?: Record<string, string>

    writeHead(_status: number, headers: Record<string, string>): void {
        this.headers = headers
    }

    write(data: string): void {
        if (this.destroyed || this.writableEnded) throw new Error("Write after terminal response")
        this.chunks.push(data)
    }

    end(data?: string): void {
        if (data) this.write(data)
        this.writableEnded = true
    }

    destroy(): void {
        this.destroyed = true
        this.emit("close")
    }

    get body(): string {
        return this.chunks.join("")
    }
}

function encode(response: MemoryResponse, protocol: MockApiProtocol, scriptedResponse: Script, stream = true) {
    return writeProviderResponse({
        res: response as unknown as ServerResponse,
        sendJson(data) {
            response.writeHead(200, { "Content-Type": "application/json" })
            response.end(JSON.stringify(data))
        },
        protocol,
        scriptedResponse,
        stream,
        generationId: "generation-fixed",
        model: "model-fixed",
        usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 2, reasoningTokens: 5 },
    })
}

interface StreamEvent {
    type?: string
    output_index?: number
    item?: { type: string; id?: string; encrypted_content?: string }
    delta?: string | { type: string; text?: string; partial_json?: string; stop_reason?: string }
    content_block?: { type: string; id?: string; tool_use_id?: string }
    choices?: { delta?: { content?: string; tool_calls?: unknown[] } }[]
}

function parseEvents(response: MemoryResponse): StreamEvent[] {
    return response.body
        .split("\n\n")
        .map((block) =>
            block
                .split("\n")
                .find((line) => line.startsWith("data: "))
                ?.slice(6),
        )
        .filter((data): data is string => Boolean(data && data !== "[DONE]"))
        .map((data) => JSON.parse(data))
}

const protocols: MockApiProtocol[] = ["openai-chat", "deepseek-chat", "openai-responses", "anthropic-messages"]
const tool = { id: "call-kept", name: "read_file", arguments: { path: "README.md" } }

describe("mock provider response wire", () => {
    it.each(protocols)("streams explicit instructions as assistant text, not native tools, on %s", async (protocol) => {
        const response = new MemoryResponse()
        await encode(response, protocol, {
            type: "tool",
            name: "report_bug",
            arguments: { title: "Bug title", steps: ["a", "b"] },
            toolArgumentChunkSize: 3,
        })
        const events = parseEvents(response)
        const text = events
            .map((event) => {
                if (event.choices) return event.choices.map((choice) => choice.delta?.content ?? "").join("")
                if (event.type === "response.output_text.delta" && typeof event.delta === "string") return event.delta
                if (typeof event.delta === "object" && event.delta.type === "text_delta") return event.delta.text
                return ""
            })
            .join("")
        expect(text).toBe('<report_bug>\n<title>\nBug title\n</title>\n<steps>\n["a","b"]\n</steps>\n</report_bug>')
        expect(events.some((event) => event.item?.type === "function_call" || event.content_block?.type === "tool_use")).toBe(
            false,
        )
        expect(events.flatMap((event) => event.choices ?? []).some((choice) => choice.delta?.tool_calls)).toBe(false)
        expect(response.writableEnded).toBe(true)
    })

    it.each(protocols)("keeps uncached and cached input distinct in %s usage", async (protocol) => {
        const response = new MemoryResponse()
        await encode(response, protocol, { type: "message", text: "body" }, false)
        const { usage } = JSON.parse(response.body)
        expect(response.headers?.["Content-Type"]).toBe("application/json")
        if (protocol === "anthropic-messages") {
            expect(usage).toMatchObject({
                input_tokens: 11,
                output_tokens: 7,
                cache_creation_input_tokens: 2,
                cache_read_input_tokens: 3,
            })
        } else if (protocol === "openai-responses") {
            expect(usage).toMatchObject({
                input_tokens: 16,
                output_tokens: 7,
                total_tokens: 23,
                input_tokens_details: { cached_tokens: 3, cache_miss_tokens: 2 },
            })
        } else {
            expect(usage).toMatchObject({
                prompt_tokens: 16,
                completion_tokens: 7,
                total_tokens: 23,
                prompt_tokens_details: { cached_tokens: 3, cache_miss_tokens: 2 },
            })
        }
    })

    it.each([
        "anthropic-deferred-web-search",
        "anthropic-orphan-web-search-result",
    ] as const)("keeps hosted result blocks and client call identities separate for %s", async (type) => {
        const response = new MemoryResponse()
        const script: Script =
            type === "anthropic-deferred-web-search"
                ? { type, id: "search-kept", query: "query", followupTools: [tool] }
                : {
                      type,
                      id: "search-kept",
                      results: [{ title: "Evidence", url: "https://example.test/result" }],
                      followupTools: [tool],
                  }
        await encode(response, "anthropic-messages", script)
        const events = parseEvents(response)
        const blocks = events.filter((event) => event.type === "content_block_start").map((event) => event.content_block)
        expect(blocks.filter((block) => block?.type === "tool_use")).toEqual([expect.objectContaining({ id: "call-kept" })])
        if (type === "anthropic-deferred-web-search") {
            expect(blocks[0]).toMatchObject({ type: "server_tool_use", id: "search-kept" })
            expect(blocks.some((block) => block?.type === "web_search_tool_result")).toBe(false)
        } else {
            expect(blocks[0]).toMatchObject({ type: "web_search_tool_result", tool_use_id: "search-kept" })
            expect(blocks.some((block) => block?.type === "server_tool_use")).toBe(false)
        }
        const inputs = events.filter((event) => typeof event.delta === "object" && event.delta.type === "input_json_delta")
        expect(JSON.parse((inputs.at(-1)?.delta as { partial_json: string }).partial_json)).toEqual({ path: "README.md" })
    })

    it("retains encrypted reasoning item identities and authoritative completed payloads", async () => {
        const response = new MemoryResponse()
        await encode(response, "openai-responses", {
            type: "tool-with-completion-snapshots",
            ...tool,
            encryptedReasoningItemCount: 3,
            encryptedReasoningChunkSize: 18,
            encryptedReasoningSnapshotsPerItem: 3,
        })
        const events = parseEvents(response)
        const snapshots = events.filter(
            (event) => event.type === "response.output_item.added" && event.item?.type === "reasoning",
        )
        const completed = events.filter((event) => event.type === "response.output_item.done" && event.item?.type === "reasoning")
        expect(snapshots).toHaveLength(9)
        expect(new Set(completed.map((event) => event.item?.id)).size).toBe(3)
        expect(completed.map((event) => event.item?.encrypted_content?.length)).toEqual([18, 18, 18])
        for (const event of completed) {
            expect(
                snapshots
                    .filter((snapshot) => snapshot.item?.id === event.item?.id)
                    .map((snapshot) => snapshot.item?.encrypted_content?.length),
            ).toEqual([6, 12, 18])
        }
        expect(events.at(-1)?.type).toBe("response.completed")
    })

    it.each([
        { protocol: "openai-chat", script: { type: "message", text: "body", afterChatContentDelayMs: 10_000 } },
        {
            protocol: "deepseek-chat",
            script: { type: "message", text: "body", reasoning: "reason", afterReasoningDelayMs: 10_000 },
        },
        { protocol: "openai-responses", script: { type: "message", text: "body", beforeUsageDelayMs: 10_000 } },
        { protocol: "anthropic-messages", script: { type: "message", text: "body", beforeUsageDelayMs: 10_000 } },
    ] satisfies {
        protocol: MockApiProtocol
        script: Script
    }[])("stops a closed %s stream and releases its pending wait", async ({ protocol, script }) => {
        vi.useFakeTimers()
        try {
            const response = new MemoryResponse()
            const running = encode(response, protocol, script)
            await vi.advanceTimersByTimeAsync(0)
            expect(vi.getTimerCount()).toBe(1)
            const beforeClose = response.body
            response.destroy()
            await running
            expect(response.body).toBe(beforeClose)
            expect(response.writableEnded).toBe(false)
            expect(response.listenerCount("close")).toBe(0)
            expect(vi.getTimerCount()).toBe(0)
        } finally {
            vi.useRealTimers()
        }
    })
})
