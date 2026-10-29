import { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"
import { ApiProfile } from "@shared/proto/dline/profile"
import { describe, expect, it } from "vitest"
import { OpenAiHandler } from "../openai"

/**
 * A profile running a free-form model id has no registry entry, so its own
 * `modelInfo` is the only place a hosted declaration can come from. These tests
 * pin that path, because losing it silently drops hosted routing back to local.
 */
describe("OpenAI handler server tool metadata", () => {
    function createHandler(modelInfoCapabilities: Record<string, unknown> | undefined) {
        return new OpenAiHandler({
            profile: ApiProfile.create({
                provider: "openai",
                modelId: "dline-e2e-model",
                baseUrl: "https://example.test/v1",
                ...(modelInfoCapabilities ? { modelInfo: { id: "dline-e2e-model", capabilities: modelInfoCapabilities } } : {}),
                openai: {
                    apiFormat: ApiFormat.OPENAI_RESPONSES,
                    customModelEnabled: true,
                    capabilities: { maxTokens: 8_192, contextWindow: 131_072, supportsTools: true },
                },
            } as unknown as Parameters<typeof ApiProfile.create>[0]),
            mode: "act",
        })
    }

    it("keeps a hosted declaration carried by the profile's own model metadata", () => {
        const handler = createHandler({ tools: [ServerTool.WEB_SEARCH] })

        expect(handler.getModel().info.capabilities?.tools).toEqual([ServerTool.WEB_SEARCH])
    })

    it("reports the selected Responses protocol instead of leaving routing to guess", () => {
        const handler = createHandler(undefined)

        expect(handler.getSelectedApiFormat()).toBe(ApiFormat.OPENAI_RESPONSES)
        expect(handler.supportsServerTool(ServerTool.WEB_SEARCH)).toBe(true)
    })
})
