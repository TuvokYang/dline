import type { ApiHandler } from "@core/api"
import type { ApiProviderStreamChunk } from "@core/api/transform/stream"
import { describe, expect, it } from "vitest"
import type { ProviderDraftEnvelope } from "../../../../stores/payload/TaskPayloadEnvelopes"
import type { ProductionProviderChunk } from "../../ProductionProviderAdapter"
import { DefaultProductionProviderService } from "../DefaultProductionProviderService"
import type { PreparedProviderRequest } from "../ProviderRequest"

/** A provider that streams the given chunks and reports the given model id. */
function streamingApi(chunks: readonly ApiProviderStreamChunk[], modelId: string): ApiHandler {
    return {
        createMessage: async function* () {
            for (const chunk of chunks) yield chunk
        },
        getModel: () => ({ id: modelId, info: {} }),
    } as unknown as ApiHandler
}

function service(chunks: readonly ApiProviderStreamChunk[], modelId: string, nativeTools: boolean) {
    const request = {
        api: streamingApi(chunks, modelId),
        systemPrompt: "",
        nativeTools,
        mode: "serial",
        profile: "standard",
        messages: [],
        turnId: "turn-1",
        planTool: () => ({ attempt: "attempt-1", lanes: [], turnEnding: false, approval: { kind: "none" } }),
    } as unknown as PreparedProviderRequest
    let id = 0
    return new DefaultProductionProviderService({ requests: { prepare: async () => request }, nextPresentationId: () => ++id })
}

async function run(
    chunks: readonly ApiProviderStreamChunk[],
    modelId: string,
    nativeTools = true,
): Promise<ProductionProviderChunk[]> {
    const out: ProductionProviderChunk[] = []
    const iterable = service(chunks, modelId, nativeTools).start({
        draftRef: "draft-1",
        draft: {} as ProviderDraftEnvelope,
        signal: new AbortController().signal,
    })
    for await (const chunk of iterable) out.push(chunk)
    return out
}

function text(value: string): ApiProviderStreamChunk {
    return { type: "text", text: value }
}

/** The GLM call as a gateway can leave it: text in the reply, not a native call. */
const GLM_CALL = "<tool_call>read_file<arg_key>path</arg_key><arg_value>a.ts</arg_value></tool_call>"

function finalOf(chunks: readonly ProductionProviderChunk[]) {
    const final = chunks.find((chunk) => chunk.kind === "final")
    if (final?.kind !== "final") throw new Error("missing final chunk")
    return final
}

function shownText(chunks: readonly ProductionProviderChunk[]): string[] {
    return chunks.flatMap((chunk) => (chunk.kind === "partial" && typeof chunk.text === "string" ? [chunk.text] : []))
}

describe("ZAI tool markup recovery", () => {
    it("turns a GLM call written as text into an executable call and keeps it out of the prose", async () => {
        // Split across chunks so the call closes only in the second one.
        const chunks = await run(
            [text("Reading. <tool_call>read_file<arg_key>path</arg_key><arg"), text("_value>a.ts</arg_value></tool_call>")],
            "glm-5.3-flash",
        )

        const final = finalOf(chunks)
        expect(final.blocks.map((block) => block.invocation.toolName)).toEqual(["read_file"])
        expect(final.blocks[0]?.invocation.input).toEqual({ path: "a.ts" })
        expect(final.text).not.toContain("tool_call")
        for (const shown of shownText(chunks)) expect(shown).not.toContain("tool_call")
    })

    it("leaves a non-GLM model's text exactly as it arrived", async () => {
        const chunks = await run([text(GLM_CALL)], "gpt-5.6")

        const final = finalOf(chunks)
        expect(final.blocks).toEqual([])
        expect(final.text).toContain("tool_call")
    })

    it("does not run a text copy of a call the provider already returned natively", async () => {
        const nativeCall: ApiProviderStreamChunk = {
            type: "tool_calls",
            function_id: "call-1",
            phase: "completed",
            tool_index: 0,
            tool_call: { function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
        }
        const chunks = await run([nativeCall, text(GLM_CALL)], "glm-5.3")

        const final = finalOf(chunks)
        expect(final.blocks.map((block) => block.invocation.toolName)).toEqual(["read_file"])
        expect(final.blocks).toHaveLength(1)
    })

    it("matches a native call whose argument is structured JSON against its text copy", async () => {
        const nativeCall: ApiProviderStreamChunk = {
            type: "tool_calls",
            function_id: "call-1",
            phase: "completed",
            tool_index: 0,
            tool_call: {
                function: { name: "use_subagents", arguments: '{"subagents":[{"task":"a","context":"b"}]}' },
            },
        }
        const copy = text(
            '<tool_call>use_subagents<arg_key>subagents</arg_key><arg_value>[{"task": "a", "context": "b"}]</arg_value></tool_call>',
        )
        const chunks = await run([nativeCall, copy], "glm-5.3")

        const final = finalOf(chunks)
        expect(final.blocks.map((block) => block.invocation.toolName)).toEqual(["use_subagents"])
    })

    it("keeps the reply's call order when a native call replaces its text copy", async () => {
        const nativeCall: ApiProviderStreamChunk = {
            type: "tool_calls",
            function_id: "call-1",
            phase: "completed",
            tool_index: 0,
            tool_call: { function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
        }
        const written = text(
            `${GLM_CALL}<tool_call>write_to_file<arg_key>path</arg_key><arg_value>b.ts</arg_value><arg_key>content</arg_key><arg_value>x</arg_value></tool_call>`,
        )
        const chunks = await run([nativeCall, written], "glm-5.3")

        const final = finalOf(chunks)
        expect(final.blocks.map((block) => block.invocation.toolName)).toEqual(["read_file", "write_to_file"])
    })
})
