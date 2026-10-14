import { describe, expect, it, vi } from "vitest"
import type { ProviderRequestFrame } from "../../executors/provider/service/ProviderRequest"
import type { ProviderDraftEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import { TaskProviderRequestFactory, type TaskProviderRequestFactoryOptions } from "../TaskProviderRequestFactory"

function harness() {
    const api = {
        getModel: () => ({ id: "model-1" }),
        getProviderId: () => "openai",
    }
    const rebuild = vi.fn(async () => undefined)
    const current = vi.fn(() => api)
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
        conversation: { providerMessages: vi.fn(async () => []) },
        messages: { collectAuthority: vi.fn(async () => []) },
        authority: { grant: vi.fn(() => undefined) },
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
