import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import type { ProviderRequestFrame } from "../../executors/provider/service/ProviderRequest"
import type { ExplicitInstructionDeclaration } from "../../explicit-instructions/types"
import type { ProviderDraftEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import { TaskProviderRequestFactory, type TaskProviderRequestFactoryOptions } from "../TaskProviderRequestFactory"

function harness() {
    const api = {
        getModel: () => ({ id: "model-1" }),
        getProviderId: () => "openai",
    }
    const rebuild = vi.fn(async () => undefined)
    const current = vi.fn(() => api)
    const collectAuthority = vi.fn(async (): Promise<readonly ExplicitInstructionDeclaration[]> => [])
    const entries = vi.fn(async () => [])
    const grant = vi.fn(() => undefined)
    let pendingRefresh: string | undefined
    const options = {
        taskId: "task-1",
        stateManager: {
            getGlobalSettingsKey: (key: string) => (key === "clineWebToolsEnabled" ? false : undefined),
            getCanonicalSettingsKey: () => false,
        },
        settings: { mode: "act" },
        api: { rebuild, current },
        promptContext: {},
        prompt: { getPendingRefreshReason: () => pendingRefresh, getLastTools: () => undefined },
        conversation: { providerMessages: vi.fn(async () => []), entries },
        messages: { collectAuthority },
        authority: { grant },
        tools: { plan: vi.fn(async () => undefined) },
        readAdmissionSnapshot: vi.fn(() => ({})),
        usesNativeToolCalls: vi.fn(() => false),
    } as unknown as TaskProviderRequestFactoryOptions
    const factory = new TaskProviderRequestFactory(options)
    const frame = {
        api,
        systemPrompt: "SYSTEM",
        tools: [],
        options: { serverTools: [] },
        nativeTools: false,
        serverToolContext: {
            webSearchRoutingPlan: { mode: "off", serverTools: [] },
            providerId: "openai",
            imageGeneration: { enabled: false, providerId: "openai", modelId: "model-1" },
        },
        mode: "serial",
        profile: "standard",
    } as unknown as ProviderRequestFrame
    const internals = factory as unknown as {
        buildFrame(signal: AbortSignal, preview: boolean): Promise<ProviderRequestFrame>
    }
    const buildFrame = vi.spyOn(internals, "buildFrame").mockResolvedValue(frame)
    const draft: ProviderDraftEnvelope = { kind: "provider_draft", admittedEntryIds: [], inputPayloadRefs: [], turnId: "turn-1" }
    return {
        factory,
        frame,
        draft,
        rebuild,
        buildFrame,
        collectAuthority,
        entries,
        grant,
        setPendingRefresh: (value: string | undefined) => {
            pendingRefresh = value
        },
    }
}

describe("TaskProviderRequestFactory frame candidate", () => {
    it("reuses one stable preview frame for the ordinary request", async () => {
        const { factory, frame, draft, rebuild, buildFrame } = harness()
        const signal = new AbortController().signal

        await expect(factory.frame(signal)).resolves.toBe(frame)
        const prepared = await factory.prepare(draft, signal)

        expect(prepared.api).toBe(frame.api)
        expect(buildFrame).toHaveBeenCalledTimes(1)
        expect(rebuild).toHaveBeenCalledWith({ validateCredentials: true })
    })

    it("grants the draft turn the report_bug authority collected from its durable inputs", async () => {
        const { factory, draft, collectAuthority, grant } = harness()
        const declaration: ExplicitInstructionDeclaration = {
            type: "report_bug",
            source: "slash_command",
            targetTool: DlineDefaultTool.REPORT_BUG,
        }
        collectAuthority.mockResolvedValueOnce([declaration])
        const inputPayloadRefs = ["payload:reportbug"]

        await factory.prepare({ ...draft, inputPayloadRefs }, new AbortController().signal)

        expect(collectAuthority).toHaveBeenCalledWith(inputPayloadRefs)
        expect(grant).toHaveBeenCalledWith("turn-1", [declaration])
    })

    it("re-authorizes report_bug on a later turn while the durable intent is still unfinished", async () => {
        const { factory, draft, entries, grant } = harness()
        entries.mockResolvedValueOnce([
            {
                entry: { payloadRef: "payload:reportbug" },
                kind: "user_input",
                messages: [],
                explicitInstructions: [
                    {
                        type: "report_bug",
                        source: "slash_command",
                        targetTool: DlineDefaultTool.REPORT_BUG,
                    },
                ],
            },
        ] as never)

        await factory.prepare({ ...draft, turnId: "turn-followup" }, new AbortController().signal)

        expect(grant).toHaveBeenCalledWith("turn-followup", [
            {
                type: "report_bug",
                source: "internal_continuation",
                targetTool: DlineDefaultTool.REPORT_BUG,
                operationId: "report-bug-continuation:payload:reportbug",
                metadata: { sourcePayloadRef: "payload:reportbug" },
            },
        ])
    })

    it("invalidates the preview when a prompt refresh becomes pending", async () => {
        const { factory, draft, buildFrame, setPendingRefresh } = harness()
        const signal = new AbortController().signal

        await factory.frame(signal)
        setPendingRefresh("rules_changed")
        await factory.prepare(draft, signal)

        expect(buildFrame).toHaveBeenCalledTimes(2)
        expect(buildFrame.mock.calls[1]?.[1]).toBe(false)
    })
})
