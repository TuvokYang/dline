import type { UiMessage } from "@shared/ExtensionMessage"
import type { ClineContent, ClineStorageMessage, ClineUserToolResultContentBlock } from "@shared/messages"
import { describe, expect, it } from "vitest"
import { type BlockLifecycle, BlockPhase } from "../LegacyBlockLifecycle"
import { buildMistakeLimitContinuationContent } from "../MistakeLimitContinuation"

function lifecycle(dlineTid: string, functionId: string, phase: BlockPhase = BlockPhase.COMPLETED): BlockLifecycle {
    return {
        dlineTid,
        functionId,
        toolName: "read_file",
        phase,
        ts: 1,
        requiresApproval: false,
        conversationHistoryIndex: 0,
    }
}

function toolResult(dlineTid: string, functionId: string, text: string): ClineUserToolResultContentBlock {
    return {
        type: "tool_result",
        dline_tid: dlineTid,
        function_id: functionId,
        content: [{ type: "text", text }],
    }
}

function durableResult(result: ClineUserToolResultContentBlock): UiMessage {
    return {
        ts: 10,
        type: "say",
        say: "partial_tool_result",
        text: JSON.stringify({
            version: 1,
            function_id: result.function_id,
            dline_tid: result.dline_tid,
            content: result.content,
            is_error: result.is_error ?? null,
        }),
    }
}

describe("buildMistakeLimitContinuationContent", () => {
    it("preserves canonical real results from a parallel tool turn before appending mistake feedback", async () => {
        const blocks = [
            lifecycle("tid-api", "fn-api"),
            lifecycle("tid-pending", "fn-pending"),
            lifecycle("tid-durable", "fn-durable"),
            lifecycle("tid-missing", "fn-missing", BlockPhase.CANCELLED),
        ]
        const apiHistory: ClineStorageMessage[] = [
            { role: "assistant", content: [], ts: 1 },
            { role: "user", content: [toolResult("tid-api", "fn-api", "already persisted")], ts: 2 },
        ]
        const pendingResult = toolResult("tid-pending", "fn-pending", "pending success")
        const durable = toolResult("tid-durable", "fn-durable", "durable success")
        const pendingContent: ClineContent[] = [pendingResult, { type: "text", text: "preserved pending guidance" }]

        const content = await buildMistakeLimitContinuationContent({
            turn: { assistantApiIndex: 0, blocks },
            apiHistory,
            uiHistory: [durableResult(durable)],
            pendingContent,
            feedback: { text: "mistake-limit feedback" },
        })
        const results = content.filter((item): item is ClineUserToolResultContentBlock => item.type === "tool_result")

        expect(results.map((item) => item.dline_tid)).toEqual(["tid-pending", "tid-durable", "tid-missing"])
        expect(results[0]).toEqual(pendingResult)
        expect(results[1]).toEqual(durable)
        expect(results[2]).toMatchObject({
            dline_tid: "tid-missing",
            function_id: "fn-missing",
            is_error: true,
        })
        expect(content.at(-2)).toEqual({ type: "text", text: "preserved pending guidance" })
        expect(content.at(-1)).toEqual({
            type: "text",
            text: expect.stringContaining("mistake-limit feedback"),
        })
    })

    it("preserves pending content when no runtime tool turn is available", async () => {
        const pendingContent: ClineContent[] = [{ type: "text", text: "no-tools-used reminder" }]

        await expect(
            buildMistakeLimitContinuationContent({
                apiHistory: [],
                uiHistory: [],
                pendingContent,
                feedback: { text: "mistake-limit feedback" },
            }),
        ).resolves.toEqual([
            ...pendingContent,
            {
                type: "text",
                text: expect.stringContaining("mistake-limit feedback"),
            },
        ])
    })
})
