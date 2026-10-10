import type { ApiHandler } from "@core/api"
import { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"
import { ImageGenerationSource } from "@shared/proto/dline/profile"
import { WebToolsMode } from "@shared/proto/dline/provider/common"
import { describe, expect, it, vi } from "vitest"
import { createRequestApiScope } from "../RequestApiScope"

function createHandler(providerId: string, modelId: string): ApiHandler {
    return {
        createMessage: vi.fn() as ApiHandler["createMessage"],
        getModel: () => ({ id: modelId, info: { id: modelId } }),
        getProviderId: () => providerId,
        abort: vi.fn(),
        getApiStreamUsage: vi.fn(),
        parseError: vi.fn(),
    }
}

describe("createRequestApiScope", () => {
    it.each([
        ["openai", "openai-model", "anthropic", "claude-model"],
        ["openai", "openai-model-a", "openai", "openai-model-b"],
        ["anthropic", "claude-model-a", "anthropic", "claude-model-b"],
    ] as const)("keeps an in-flight %s request bound to its handler when the next profile is %s", (currentProvider, currentModel, nextProvider, nextModel) => {
        let activeHandler = createHandler(currentProvider, currentModel)
        const requestScope = createRequestApiScope(activeHandler, "act")

        activeHandler = createHandler(nextProvider, nextModel)
        const nextRequestScope = createRequestApiScope(activeHandler, "act")

        expect(requestScope.api.getProviderId?.()).toBe(currentProvider)
        expect(requestScope.providerInfo).toMatchObject({
            providerId: currentProvider,
            model: { id: currentModel },
            mode: "act",
        })
        expect(requestScope.api.createMessage).not.toBe(activeHandler.createMessage)
        expect(requestScope.api.parseError).not.toBe(activeHandler.parseError)
        expect(requestScope.api.abort).not.toBe(activeHandler.abort)
        expect(requestScope.api.getApiStreamUsage).not.toBe(activeHandler.getApiStreamUsage)
        expect(activeHandler.getProviderId?.()).toBe(nextProvider)
        expect(activeHandler.getModel().id).toBe(nextModel)
        expect(nextRequestScope.api).toBe(activeHandler)
        expect(nextRequestScope.providerInfo).toMatchObject({
            providerId: nextProvider,
            model: { id: nextModel },
            mode: "act",
        })
    })

    it("freezes the handler-selected API format instead of the model format list head", () => {
        const handler = createHandler("openai", "multi-format-model")
        handler.getModel = () => ({
            id: "multi-format-model",
            info: {
                id: "multi-format-model",
                apiFormats: [ApiFormat.OPENAI_CHAT, ApiFormat.OPENAI_RESPONSES],
            },
        })
        handler.getSelectedApiFormat = vi.fn(() => ApiFormat.OPENAI_RESPONSES)

        const scope = createRequestApiScope(handler, "act")

        expect(handler.getSelectedApiFormat).toHaveBeenCalledTimes(1)
        expect(scope.selectedApiFormat).toBe(ApiFormat.OPENAI_RESPONSES)
    })

    it("rejects handlers that cannot identify their provider", () => {
        const handler = createHandler("openai", "openai-model")
        delete handler.getProviderId

        expect(() => createRequestApiScope(handler, "act")).toThrow("API handler is missing its provider identity")
    })

    it("keeps explicit compaction instructions out of the request scope", () => {
        const handler = createHandler("openai", "openai-model")
        const scope = createRequestApiScope(handler, "act", undefined, true)

        expect(scope.webToolsEnabled).toBe(true)
        expect(scope).not.toHaveProperty("requestToolIds")
        expect(scope).not.toHaveProperty("withRequestToolIds")
        expect(scope.webSearchRoutingPlan.route).not.toBe("disabled")
    })

    it("freezes the global Web Tools switch independently from later settings changes", () => {
        const handler = createHandler("openai", "openai-model")
        let liveWebToolsEnabled = true

        const scope = createRequestApiScope(handler, "act", undefined, liveWebToolsEnabled)
        liveWebToolsEnabled = false

        expect(liveWebToolsEnabled).toBe(false)
        expect(scope.webToolsEnabled).toBe(true)
        expect(Object.isFrozen(scope)).toBe(true)
    })

    it("freezes hosted Web Search from model metadata, selected protocol, and handler support", () => {
        const handler = createHandler("metadata-provider", "hosted-model")
        handler.getModel = () => ({
            id: "hosted-model",
            info: {
                id: "hosted-model",
                apiFormats: [ApiFormat.OPENAI_RESPONSES],
                capabilities: { tools: [ServerTool.WEB_SEARCH] },
            },
        })
        handler.supportsServerTool = (tool) => tool === ServerTool.WEB_SEARCH

        const scope = createRequestApiScope(handler, "act", undefined, true)

        expect(scope.webSearchRoutingPlan).toMatchObject({
            route: "hosted",
            localToolEnabled: false,
            serverTools: [ServerTool.WEB_SEARCH],
        })
    })

    it("does not store a local auto-approval gate in the hosted request scope", () => {
        const handler = createHandler("metadata-provider", "hosted-model")
        handler.getModel = () => ({
            id: "hosted-model",
            info: {
                id: "hosted-model",
                apiFormats: [ApiFormat.OPENAI_RESPONSES],
                capabilities: { tools: [ServerTool.WEB_SEARCH] },
            },
        })
        handler.supportsServerTool = (tool) => tool === ServerTool.WEB_SEARCH

        const scope = createRequestApiScope(handler, "act", undefined, true)

        expect(scope).not.toHaveProperty("hostedWebSearchAllowed")
        expect(scope.webSearchRoutingPlan).toMatchObject({
            route: "hosted",
            localToolEnabled: false,
            serverTools: [ServerTool.WEB_SEARCH],
        })
    })

    it("uses local Web Search in Auto when the selected transport cannot host it", () => {
        const handler = createHandler("metadata-provider", "chat-model")
        handler.getModel = () => ({
            id: "chat-model",
            info: {
                id: "chat-model",
                apiFormats: [ApiFormat.OPENAI_CHAT],
                capabilities: { tools: [ServerTool.WEB_SEARCH] },
            },
        })
        handler.supportsServerTool = () => false

        expect(createRequestApiScope(handler, "act", undefined, true).webSearchRoutingPlan).toMatchObject({
            route: "local",
            localToolEnabled: true,
            serverTools: [],
        })
    })

    it("does not advertise local Web Search when the resolved Lite profile omits local web tools", () => {
        const handler = createHandler("metadata-provider", "small-chat-model")
        handler.getModel = () => ({
            id: "small-chat-model",
            info: {
                id: "small-chat-model",
                apiFormats: [ApiFormat.OPENAI_CHAT],
                capabilities: { contextWindow: 32_000 },
            },
        })
        handler.supportsServerTool = () => false

        expect(createRequestApiScope(handler, "act", undefined, true).webSearchRoutingPlan).toMatchObject({
            route: "unavailable",
            localToolEnabled: false,
            serverTools: [],
            unavailableReason: "server_tool_not_declared",
        })
    })

    it("does not fall back locally when Force Remote is unavailable", () => {
        const handler = createHandler("metadata-provider", "chat-model")
        handler.getModel = () => ({
            id: "chat-model",
            info: {
                id: "chat-model",
                apiFormats: [ApiFormat.OPENAI_CHAT],
                capabilities: { tools: [ServerTool.WEB_SEARCH] },
            },
        })
        handler.getWebToolsMode = () => WebToolsMode.WEB_TOOLS_MODE_FORCE_REMOTE
        handler.supportsServerTool = () => false

        expect(createRequestApiScope(handler, "act", undefined, true).webSearchRoutingPlan).toMatchObject({
            route: "unavailable",
            localToolEnabled: false,
            serverTools: [],
            unavailableReason: "server_tool_transport_unsupported",
        })
    })

    it("routes a hosted-capable model to hosted search when the profile disables nothing", () => {
        const handler = createHandler("anthropic", "claude-opus-5")
        handler.getModel = () => ({
            id: "claude-opus-5",
            info: {
                id: "claude-opus-5",
                apiFormats: [ApiFormat.ANTHROPIC_CHAT],
                capabilities: { tools: [ServerTool.WEB_SEARCH] },
            },
        })
        handler.supportsServerTool = (tool) => tool === ServerTool.WEB_SEARCH
        handler.getDisabledServerTools = () => undefined

        expect(createRequestApiScope(handler, "act", undefined, true).webSearchRoutingPlan).toMatchObject({
            route: "hosted",
            serverTools: [ServerTool.WEB_SEARCH],
        })
    })

    it("falls back to local search when the profile switched hosted search off", () => {
        const handler = createHandler("anthropic", "claude-opus-5")
        handler.getModel = () => ({
            id: "claude-opus-5",
            info: {
                id: "claude-opus-5",
                apiFormats: [ApiFormat.ANTHROPIC_CHAT],
                capabilities: { tools: [ServerTool.WEB_SEARCH] },
            },
        })
        handler.supportsServerTool = (tool) => tool === ServerTool.WEB_SEARCH
        handler.getDisabledServerTools = () => [ServerTool.WEB_SEARCH]

        const plan = createRequestApiScope(handler, "act", undefined, true).webSearchRoutingPlan

        // The declaration survives the switch, so re-enabling restores the hosted route.
        expect(plan).toMatchObject({ route: "local", serverTools: [] })
        expect(plan.serverToolPlan.declared).toEqual([ServerTool.WEB_SEARCH])
        expect(plan.serverToolPlan.disabled).toEqual([ServerTool.WEB_SEARCH])
    })

    it("judges hosted transport by the protocol the handler will actually use", () => {
        // A profile running a free-form model id carries no declared formats, so
        // routing has to ask the handler instead of guessing from model metadata.
        const handler = createHandler("openai", "custom-responses-model")
        handler.getModel = () => ({
            id: "custom-responses-model",
            info: {
                id: "custom-responses-model",
                capabilities: { tools: [ServerTool.WEB_SEARCH] },
            },
        })
        handler.supportsServerTool = (tool) => tool === ServerTool.WEB_SEARCH
        handler.getSelectedApiFormat = () => ApiFormat.OPENAI_RESPONSES
        handler.getDisabledServerTools = () => []

        expect(createRequestApiScope(handler, "act", undefined, true).webSearchRoutingPlan).toMatchObject({
            route: "hosted",
            serverTools: [ServerTool.WEB_SEARCH],
        })
    })

    it("keeps hosted image generation out of the main conversation request", () => {
        const handler = createHandler("openai", "hosted-image-model")
        handler.getModel = () => ({
            id: "hosted-image-model",
            info: {
                id: "hosted-image-model",
                apiFormats: [ApiFormat.OPENAI_RESPONSES],
                capabilities: { tools: [ServerTool.IMAGE_GENERATION] },
            },
        })
        handler.getImageGenerationSource = () => ImageGenerationSource.IMAGE_GENERATION_SOURCE_HOSTED
        handler.supportsServerTool = (tool) => tool === ServerTool.IMAGE_GENERATION

        const enabled = createRequestApiScope(handler, "act", undefined, false, undefined, true)
        const disabled = createRequestApiScope(handler, "act", undefined, false, undefined, false)

        // Image generation is driven by the generate_image tool, so the main
        // conversation request never projects the image server tool. The switch
        // therefore must not change this request-scoped plan either way.
        expect(enabled.hostedImageGenerationPlan).toMatchObject({ route: "disabled", serverTools: [] })
        expect(disabled.hostedImageGenerationPlan).toMatchObject({ route: "disabled", serverTools: [] })
        // The declared capability still reaches the plan so downstream consumers
        // can tell "not projected" apart from "model cannot generate images".
        expect(enabled.hostedImageGenerationPlan.serverToolPlan.declared).toContain(ServerTool.IMAGE_GENERATION)
    })

    it("lets the global Web Tools switch disable every route", () => {
        const handler = createHandler("metadata-provider", "hosted-model")
        handler.getModel = () => ({
            id: "hosted-model",
            info: {
                id: "hosted-model",
                apiFormats: [ApiFormat.OPENAI_RESPONSES],
                capabilities: { tools: [ServerTool.WEB_SEARCH] },
            },
        })
        handler.supportsServerTool = () => true

        expect(createRequestApiScope(handler, "act", undefined, false).webSearchRoutingPlan).toMatchObject({
            route: "disabled",
            localToolEnabled: false,
            serverTools: [],
        })
    })
})
