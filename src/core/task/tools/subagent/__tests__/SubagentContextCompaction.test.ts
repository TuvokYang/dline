import type { ApiHandler } from "@core/api"
import { DISABLED_WEB_SEARCH_ROUTING_PLAN } from "@core/prompts/__tests__/web-search-routing-fixtures"
import { PromptProfile } from "@core/prompts/profiles/types"
import type { TaskConfig } from "@core/task/tools/types/TaskConfig"
import type { ClineStorageMessage } from "@shared/messages"
import { describe, expect, it, vi } from "vitest"
import { compactSubagentConversation, type SubagentCompactionInput } from "../SubagentContextCompaction"

function inputFor(messages: ClineStorageMessage[]): SubagentCompactionInput {
    const api = {
        getProviderId: () => "anthropic",
        getModel: () => ({ id: "ordinary-model", info: { capabilities: { contextWindow: 200_000, maxTokens: 8_000 } } }),
        createMessage: vi.fn(async function* () {
            yield { type: "text", text: "<summarize_task><context>Accepted summary.</context></summarize_task>" }
            yield { type: "usage", inputTokens: 100, outputTokens: 10 }
        }),
    } as unknown as ApiHandler
    return {
        api,
        config: {
            cwd: "/tmp",
            taskId: "memory-only-compaction",
            services: { stateManager: { getGlobalSettingsKey: () => undefined } },
        } as unknown as TaskConfig,
        messages,
        systemPrompt: "ordinary system prompt",
        tools: undefined,
        profile: PromptProfile.Lite,
        webSearchRoutingPlan: DISABLED_WEB_SEARCH_ROUTING_PLAN,
        signal: new AbortController().signal,
    }
}

describe("subagent memory-only compaction", () => {
    it("keeps an uncovered native-tool turn and pending input verbatim when only the oldest prefix was summarized", async () => {
        const messages: ClineStorageMessage[] = [
            { role: "user", content: [{ type: "text", text: "old task" }] },
            { role: "assistant", content: [{ type: "text", text: "a".repeat(400_000) }] },
            { role: "user", content: [{ type: "text", text: "recent task" }] },
            {
                role: "assistant",
                content: [
                    {
                        type: "tool_use",
                        function_id: "recent-call",
                        dline_tid: "recent-trace",
                        name: "read_file",
                        input: { path: "a.ts" },
                    },
                ],
            },
            {
                role: "user",
                content: [
                    { type: "tool_result", function_id: "recent-call", dline_tid: "recent-trace", content: "b".repeat(400_000) },
                ],
            },
            { role: "user", content: [{ type: "text", text: "pending input" }] },
        ]
        const original = structuredClone(messages)
        const input = inputFor(messages)
        const result = await compactSubagentConversation(input)

        expect(messages).toEqual(original)
        expect(result.slice(1)).toEqual(original.slice(2))
        expect(result[0].content).toEqual([{ type: "text", text: expect.stringContaining("Accepted summary.") }])
        const calls = vi.mocked(input.api.createMessage).mock.calls
        expect(calls).toHaveLength(1)
        expect(JSON.stringify(calls[0][1])).not.toContain("recent-call")
    })

    it("preserves workspace metadata in the new opening message", async () => {
        const input = inputFor([
            { role: "user", content: [{ type: "text", text: "delegation" }] },
            { role: "assistant", content: [{ type: "text", text: "findings" }] },
        ])
        const environment = '<environment_details>{"workspaces":{"/tmp":{}}}</environment_details>'
        const result = await compactSubagentConversation({ ...input, environment })
        expect(result).toHaveLength(1)
        expect(result[0].role).toBe("user")
        expect(result[0].content.at(-1)).toEqual({ type: "text", text: environment })
    })

    it("does not send an incomplete native-tool pair for summarization", async () => {
        const input = inputFor([
            { role: "user", content: [{ type: "text", text: "delegation" }] },
            {
                role: "assistant",
                content: [
                    {
                        type: "tool_use",
                        function_id: "open-call",
                        dline_tid: "open-trace",
                        name: "read_file",
                        input: { path: "a.ts" },
                    },
                ],
            },
        ])
        const original = structuredClone(input.messages)
        await expect(compactSubagentConversation(input)).rejects.toThrow()
        expect(input.api.createMessage).not.toHaveBeenCalled()
        expect(input.messages).toEqual(original)
    })
})
