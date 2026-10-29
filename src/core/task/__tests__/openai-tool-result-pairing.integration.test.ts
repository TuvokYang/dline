import { createIdentityFactory } from "@core/api/transform/block-identity"
import { createStreamNormalizer } from "@core/api/transform/stream-identity-normalizer"
import { ToolCallProcessor } from "@core/api/transform/tool-call-processor"
import type { ToolUse } from "@core/assistant-message"
import { ContextManager } from "@core/context/context-management/ContextManager"
import type { ClineStorageMessage, ClineUserContent } from "@shared/messages/content"
import type { ChatCompletionChunk } from "openai/resources/chat/completions"
import { describe, expect, it } from "vitest"
import { StreamResponseHandler } from "../StreamResponseHandler"
import { ToolResultUtils } from "../tools/utils/ToolResultUtils"

/**
 * Create a deterministic identity source for the integration flow.
 *
 * @param values Ordered identity suffixes.
 * @returns Function returning the next identity suffix.
 */
function createSource(values: string[]): () => string {
    let index = 0
    return () => {
        const value = values[index]
        index += 1
        if (value === undefined) {
            throw new Error("Identity source exhausted")
        }
        return value
    }
}

/**
 * Describe the runtime tool block for the stored result payload.
 *
 * @param block Runtime tool-use block.
 * @returns Stable human-readable tool description.
 */
function describeTool(block: ToolUse): string {
    return `[${block.name}]`
}

describe("OpenAI native tool result pairing", () => {
    it("preserves provider function_id and keeps result plus approval feedback in one block", () => {
        const providerFunctionId = "call_oEsVXxB48WIVPH4AufcI7tpp"
        const processor = new ToolCallProcessor()
        const setupDeltas: ChatCompletionChunk.Choice.Delta.ToolCall[] = [
            {
                index: 0,
                id: providerFunctionId,
                type: "function",
                function: { name: "write_to_file" },
            },
        ]
        const argumentDeltas: ChatCompletionChunk.Choice.Delta.ToolCall[] = [
            {
                index: 0,
                type: "function",
                function: { arguments: '{"path":"test.txt","content":"next"}' },
            },
        ]

        expect([...processor.processToolCallDeltas(setupDeltas)]).toHaveLength(0)
        const rawChunks = [...processor.processToolCallDeltas(argumentDeltas)]
        expect(rawChunks).toHaveLength(1)
        expect(rawChunks[0].function_id).toBe(providerFunctionId)

        const factory = createIdentityFactory(createSource(["TRACE"]))
        const canonical = createStreamNormalizer(factory).normalize(rawChunks[0])
        expect(canonical.type).toBe("tool_calls")
        if (canonical.type !== "tool_calls") {
            throw new Error("Expected canonical tool chunk")
        }
        expect(canonical.function_id).toBe(providerFunctionId)

        const streamHandler = new StreamResponseHandler(() => 100)
        const toolUseHandler = streamHandler.getHandlers().toolUseHandler
        toolUseHandler.processToolUseDelta(
            {
                type: "tool_use",
                name: canonical.tool_call.function?.name,
                input: canonical.tool_call.function?.arguments,
            },
            {
                function_id: canonical.function_id,
                dline_tid: canonical.dline_tid,
                provider_metadata: canonical.provider_metadata,
            },
        )

        const storedToolUse = toolUseHandler.getAllFinalizedToolUses()[0]
        const runtimeToolUse = toolUseHandler.getPartialToolUsesAsContent()[0]
        expect(storedToolUse.function_id).toBe(providerFunctionId)
        expect(runtimeToolUse.function_id).toBe(providerFunctionId)

        const userContent: ClineUserContent[] = []
        ToolResultUtils.pushAdditionalToolFeedback(userContent, "请继续，但注意边界")
        ToolResultUtils.pushToolResult(
            "File written.",
            { ...runtimeToolUse, partial: false },
            userContent,
            describeTool,
            undefined,
        )

        expect(userContent).toHaveLength(1)
        const storedResult = userContent[0]
        expect(storedResult.type).toBe("tool_result")
        if (storedResult.type !== "tool_result") {
            throw new Error("Expected canonical tool result")
        }
        expect(storedResult.function_id).toBe(providerFunctionId)
        expect(storedResult).not.toHaveProperty("tool_use_id")
        expect(storedResult.content).toHaveLength(2)
        expect(userContent.some((block) => block.type === "text")).toBe(false)

        const history: ClineStorageMessage[] = [
            { role: "user", content: "Initial task" },
            { role: "assistant", content: "Preparing tool call" },
            { role: "assistant", content: [storedToolUse] },
            { role: "user", content: userContent },
        ]
        const repaired = new ContextManager().getTruncatedMessages(history, undefined) as ClineStorageMessage[]
        const repairedUserContent = repaired[3].content
        expect(Array.isArray(repairedUserContent)).toBe(true)
        if (!Array.isArray(repairedUserContent)) {
            throw new Error("Expected repaired user content blocks")
        }
        expect(repairedUserContent).toHaveLength(1)
        expect(JSON.stringify(repairedUserContent)).not.toContain("The result was not recorded")
        expect(repairedUserContent.some((block) => block.type === "text")).toBe(false)
    })
})
