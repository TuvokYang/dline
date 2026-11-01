import type { ApiHandler } from "@core/api"
import type { ApiStreamChunk } from "@core/api/transform/stream"
import type { IgnoreController } from "@core/ignore/IgnoreController"
import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import { replayDurableToolResult } from "../../../../DurableToolResult"
import { createInitialTaskState, hydrate, transition } from "../../../../kernel"
import {
    TaskProviderRequestFactory,
    type TaskProviderRequestFactoryOptions,
} from "../../../../session/TaskProviderRequestFactory"
import { InMemoryTaskPayloadStore } from "../../../../stores"
import { decodeTaskPayload, encodeTaskPayload } from "../../../../stores/payload/TaskPayloadCodec"
import type { ToolInvocationEnvelope } from "../../../../stores/payload/TaskPayloadEnvelopes"
import { ToolValidator } from "../../../../tools/ToolValidator"
import { DefaultProductionToolExecutionService } from "../../../tool/production/DefaultProductionToolExecutionService"
import { ProductionToolHandlerRuntime } from "../../../tool/production/ProductionToolHandlerRuntime"
import { planProductionTool } from "../../../tool/production/ProductionToolPlanner"
import type { ToolAdmissionSnapshot } from "../../../tool/ToolAdmissionRegistry"
import { createDeniedSurface } from "../../../tool/ToolDomainSurface"
import { ProductionProviderAdapter } from "../../ProductionProviderAdapter"
import { DefaultProductionProviderService } from "../DefaultProductionProviderService"
import type { ProviderRequestFrame } from "../ProviderRequest"

const feedbackTools = [
    DlineDefaultTool.ASK,
    DlineDefaultTool.MAKE_PLAN,
    DlineDefaultTool.QNA_RESPOND,
    DlineDefaultTool.GENERATE_REPORT,
    DlineDefaultTool.NEW_TASK,
]
function snapshot(awayActive: boolean): ToolAdmissionSnapshot {
    return {
        taskId: "away",
        cwd: process.cwd(),
        workspaceRoots: [process.cwd()],
        settings: DEFAULT_AUTO_APPROVAL_SETTINGS,
        blanket: {},
        awayActive,
    }
}
function runtime() {
    return new ProductionToolHandlerRuntime(new ToolValidator({ validateAccess: () => true } as unknown as IgnoreController))
}

// A missing field in any of the real planner -> provider -> payload -> recovery bridges
// would invoke the handler after Away stops. This oracle checks that effect, not spelling.
describe("Away feedback-only production pipeline", () => {
    it.each(
        feedbackTools.flatMap((tool) => [true, false].map((native) => ({ tool, native }))),
    )("keeps $tool feedback-only after recovery and Stop (native=$native)", async ({ tool, native }) => {
        const handlerRuntime = runtime()
        const admission = vi.spyOn(handlerRuntime.coordinator, "prepareAdmission")
        const payloads = new InMemoryTaskPayloadStore()
        const params = {
            question: "question",
            response: "response",
            title: "title",
            content: "content",
            task: "task",
            context: "context",
        }
        const chunks: ApiStreamChunk[] = native
            ? [
                  {
                      type: "tool_calls",
                      phase: "completed",
                      argumentsMode: "snapshot",
                      function_id: "call",
                      dline_tid: "block",
                      tool_call: { function: { name: tool, arguments: JSON.stringify(params) } },
                  } as ApiStreamChunk,
              ]
            : [
                  {
                      type: "text",
                      text: `<${tool}>${Object.entries(params)
                          .map(([name, value]) => `<${name}>${value}</${name}>`)
                          .join("")}</${tool}>`,
                  },
              ]
        const api = {
            createMessage: async function* () {
                yield* chunks
            },
            getModel: () => ({ id: "model", info: {} }),
        } as unknown as ApiHandler
        const frame = { api, systemPrompt: "", nativeTools: native, mode: "serial", profile: "standard" } as ProviderRequestFrame
        const requests = new TaskProviderRequestFactory({
            taskId: "away",
            settings: { mode: "act" },
            stateManager: { getGlobalSettingsKey: () => undefined, getCanonicalSettingsKey: () => false },
            api: { current: () => api, rebuild: async () => {} },
            prompt: { getPendingRefreshReason: () => undefined },
            conversation: { providerMessages: async () => [], entries: async () => [] },
            messages: { collectAuthority: async () => [] },
            authority: { grant: () => undefined },
            tools: handlerRuntime,
            readAdmissionSnapshot: async () => snapshot(true),
            usesNativeToolCalls: () => native,
        } as unknown as TaskProviderRequestFactoryOptions)
        vi.spyOn(requests as unknown as { buildFrame(): Promise<ProviderRequestFrame> }, "buildFrame").mockResolvedValue(frame)
        const service = new DefaultProductionProviderService({
            requests,
            nextPresentationId: () => 1,
            retry: { maxAttempts: 1, delayMs: () => 0, wait: async () => "send" },
        })
        const adapter = new ProductionProviderAdapter({ payloads, service })
        const draftRef = await payloads.put(
            encodeTaskPayload({ kind: "provider_draft", admittedEntryIds: [], inputPayloadRefs: [] }),
        )
        const output = []
        for await (const chunk of adapter.start({ draftRef, signal: new AbortController().signal })) output.push(chunk)
        const final = output.find((chunk) => chunk.kind === "final")!
        if (final.kind !== "final") throw new Error("Expected provider final")
        const recovered = await adapter.recoverFinal(final.payloadRef)
        expect(recovered.turnPlan.blocks).toHaveLength(1)
        expect(recovered.turnPlan.blocks[0]).toMatchObject({ approval: { kind: "none" }, disposition: "away_feedback_only" })
        expect(admission).not.toHaveBeenCalled()
        const ready = transition(
            {
                ...createInitialTaskState("away"),
                flow: { phase: "running", provider: { commandId: "provider", originRevision: 0, status: "running" } },
            },
            {
                type: "provider.turn_ready",
                generation: 0,
                commandId: "provider",
                originRevision: 0,
                turnId: "turn",
                turnPlan: recovered.turnPlan,
                journalWatermark: { seq: 0 },
                finalPayloadRef: final.payloadRef,
            },
        )
        if (ready.kind !== "accepted") throw new Error(ready.diagnostic.message)
        const block = recovered.turnPlan.blocks[0]
        const state = ready.state
        const restored = hydrate({ taskId: "away", snapshot: state, journalTail: { seq: 0 }, openReason: "crash_recovery" })
        expect(restored.state.turn.blocks[0].disposition).toBe("away_feedback_only")
        const invocation = decodeTaskPayload<ToolInvocationEnvelope>(await payloads.read(block.invocationRef))
        const execute = vi.spyOn(handlerRuntime, "execute").mockRejectedValue(new Error("handler must not run"))
        const create = vi.fn(() => {
            throw new Error("no interaction config needed")
        })
        const toolService = new DefaultProductionToolExecutionService({
            taskId: "away",
            runtime: handlerRuntime,
            config: { create, readAdmissionSnapshot: () => snapshot(false) },
        })
        const result = await toolService.execute({
            invocation,
            command: { commandId: "tool", turnId: "turn", dlineTid: invocation.dlineTid, invocationRef: block.invocationRef },
            surface: createDeniedSurface("detached_domain"),
        })
        expect(execute).not.toHaveBeenCalled()
        expect(create).not.toHaveBeenCalled()
        expect(result.failed).toBeUndefined()
        const [paired] = replayDurableToolResult(result.content)!
        expect(paired).toMatchObject({ type: "tool_result", function_id: invocation.functionId, dline_tid: invocation.dlineTid })
    })

    it("does not suppress completion, working responses, phase reports, peers or subagents", () => {
        const handlerRuntime = runtime()
        for (const name of [
            DlineDefaultTool.ATTEMPT,
            DlineDefaultTool.WORKING_RESPOND,
            DlineDefaultTool.PHASE_REPORT,
            DlineDefaultTool.SPAWN_TASK,
            DlineDefaultTool.USE_SUBAGENT,
        ]) {
            const block = {
                type: "tool_use" as const,
                name,
                params: { result: "done", response: "response", task: "task", mode: "act" },
                partial: false,
                dline_tid: "block",
            } as Parameters<typeof planProductionTool>[1]
            expect(planProductionTool(handlerRuntime.coordinator, block, snapshot(true)).disposition).toBeUndefined()
        }
    })
})
