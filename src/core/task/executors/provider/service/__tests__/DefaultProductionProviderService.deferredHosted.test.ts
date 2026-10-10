import type { ApiHandler } from "@core/api"
import type { ApiStreamChunk } from "@core/api/transform/stream"
import type { ClineAssistantHostedToolBlock, ClineStorageMessage } from "@shared/messages/content"
import { ServerTool } from "@shared/proto/dline/models/metadata"
import { describe, expect, it } from "vitest"
import type { ProviderDraftEnvelope } from "../../../../stores/payload/TaskPayloadEnvelopes"
import type { ProductionProviderChunk } from "../../ProductionProviderAdapter"
import { DefaultProductionProviderService, type DeferredHostedResumeRequest } from "../DefaultProductionProviderService"
import type { PreparedProviderRequest } from "../ProviderRequest"

const HISTORY: ClineStorageMessage[] = [{ role: "user", content: [{ type: "text", text: "search and read" }] }]

function hostedSegment(segment: "call" | "result", id: string): ClineAssistantHostedToolBlock {
    return {
        type: "hosted_tool",
        protocol: "anthropic_messages",
        segment,
        blocks:
            segment === "call"
                ? [{ type: "server_tool_use", id, name: "web_search", input: { query: "q" } }]
                : [{ type: "web_search_tool_result", tool_use_id: id, content: [] }],
    }
}

function serverTool(id: string, phase: "completed" | "deferred", replay: ClineAssistantHostedToolBlock): ApiStreamChunk {
    return {
        type: "server_tool",
        function_id: id,
        tool: ServerTool.WEB_SEARCH,
        phase,
        input: { query: "q" },
        replay,
    } as unknown as ApiStreamChunk
}

function text(value: string): ApiStreamChunk {
    return { type: "text", text: value } as ApiStreamChunk
}

/**
 * Run one turn against an Anthropic-protocol provider with a hosted-tool presenter that resumes `carried`
 * (provider call id → original trace id) and records what it was asked and what it consumed.
 */
async function runWithServerTools(chunks: readonly ApiStreamChunk[], carried: ReadonlyMap<string, string>) {
    const requests: DeferredHostedResumeRequest[] = []
    const consumed: Array<{ function_id: string; dline_tid: string }> = []
    const api = {
        createMessage: async function* () {
            for (const chunk of chunks) yield chunk
        },
        getModel: () => ({ id: "test-model", info: {} }),
        getHostedToolReplayProtocol: () => "anthropic_messages",
    } as unknown as ApiHandler
    const request = {
        api,
        systemPrompt: "",
        nativeTools: true,
        mode: "serial",
        profile: "standard",
        messages: HISTORY,
        turnId: "turn-1",
        planTool: () => ({ attempt: "attempt-1", lanes: [], turnEnding: false, approval: { kind: "none" } }),
    } as unknown as PreparedProviderRequest
    let id = 0
    const service = new DefaultProductionProviderService({
        requests: { prepare: async () => request },
        nextPresentationId: () => ++id,
        serverTools: {
            begin: () => ({
                consume: async (chunk) => {
                    consumed.push({ function_id: chunk.function_id, dline_tid: chunk.dline_tid })
                    return true
                },
                finalizeOpen: async () => {},
                resumeDeferred: async (resume) => {
                    requests.push(resume)
                    return carried
                },
            }),
        },
    })
    const out: ProductionProviderChunk[] = []
    const signal = new AbortController().signal
    for await (const chunk of service.start({ draftRef: "draft-1", draft: {} as ProviderDraftEnvelope, signal })) out.push(chunk)
    return { chunks: out, requests, consumed }
}

// An Anthropic hosted call deferred behind a client tool runs at the start of the next response, which must
// complete the original row and keep its result first in the stored turn.
describe("DefaultProductionProviderService deferred hosted calls", () => {
    it("gives the result that resumes a deferred call the trace identity of its original row", async () => {
        const run = await runWithServerTools(
            [serverTool("srvtoolu_deferred", "completed", hostedSegment("result", "srvtoolu_deferred")), text("answer")],
            new Map([["srvtoolu_deferred", "dline_tid_ORIGINAL"]]),
        )

        expect(run.requests).toHaveLength(1)
        expect(run.requests[0].protocol).toBe("anthropic_messages")
        expect(run.requests[0].history).toEqual(HISTORY)
        expect(run.consumed).toEqual([{ function_id: "srvtoolu_deferred", dline_tid: "dline_tid_ORIGINAL" }])
    })

    it("stores a resumed result first and a newly deferred call before the visible answer", async () => {
        const run = await runWithServerTools(
            [
                serverTool("srvtoolu_deferred", "completed", hostedSegment("result", "srvtoolu_deferred")),
                text("answer"),
                serverTool("srvtoolu_next", "deferred", hostedSegment("call", "srvtoolu_next")),
            ],
            new Map(),
        )

        const final = run.chunks.find((chunk) => chunk.kind === "final")
        if (final?.kind !== "final") throw new Error("missing final chunk")
        expect(final.content).toEqual([
            hostedSegment("result", "srvtoolu_deferred"),
            hostedSegment("call", "srvtoolu_next"),
            expect.objectContaining({ type: "text", text: "answer" }),
        ])
        expect(run.consumed.map((chunk) => chunk.function_id)).toEqual(["srvtoolu_deferred", "srvtoolu_next"])
        expect(run.consumed[0].dline_tid).not.toBe(run.consumed[1].dline_tid)
    })
})
