import { anthropicModels } from "@core/api/providers/models/anthropic"
import type { ModelInfo } from "@shared/proto/dline/models"
import { type ModelCapabilities, ServerTool } from "@shared/proto/dline/models/metadata"
import { ApiProfile } from "@shared/proto/dline/profile"
import { describe, expect, it } from "vitest"
import { buildEffectiveModelInfo } from "../effective-model-info"
import { resolveProfileDisabledServerTools, resolveProfileModelInfo } from "../profile-model-info"

/**
 * A profile owns the user's switches; the registry owns what a model can do.
 * These tests pin that boundary, because collapsing it is what previously made a
 * hosted-capable model report no server tools at all.
 */
describe("profile server tool boundaries", () => {
    const providerModels = { models: anthropicModels, defaultModelId: "claude-opus-5" }

    it("keeps the model's hosted declaration when the profile overrides other capabilities", () => {
        const profile = ApiProfile.create({
            id: "opus-with-window-override",
            provider: "anthropic",
            modelId: "claude-opus-5",
            anthropic: { capabilities: { contextWindow: 123_456 } },
        })

        const modelInfo = resolveProfileModelInfo(profile, providerModels)

        expect(modelInfo.capabilities?.contextWindow).toBe(123_456)
        expect(modelInfo.capabilities?.tools).toContain(ServerTool.WEB_SEARCH)
    })

    it("ignores a stale tools override instead of letting it erase the declaration", () => {
        const profile = ApiProfile.create({
            id: "opus-with-legacy-tools",
            provider: "anthropic",
            modelId: "claude-opus-5",
            anthropic: { capabilities: { contextWindow: 200_000, tools: [] } },
        })

        expect(resolveProfileModelInfo(profile, providerModels).capabilities?.tools).toContain(ServerTool.WEB_SEARCH)
    })

    it("keeps the declaration when a provider handler merges its own stored overrides", () => {
        // Provider handlers build model metadata straight from their stored config,
        // so the boundary has to hold here too and not only in profile resolution.
        const registryModel = {
            id: "claude-opus-5",
            capabilities: { contextWindow: 200_000, tools: [ServerTool.WEB_SEARCH] } as ModelCapabilities,
        } as ModelInfo

        const effective = buildEffectiveModelInfo("claude-opus-5", registryModel, {
            capabilities: { contextWindow: 150_000, tools: [] } as ModelCapabilities,
        })

        expect(effective.capabilities?.contextWindow).toBe(150_000)
        expect(effective.capabilities?.tools).toEqual([ServerTool.WEB_SEARCH])
    })

    it("reads the switch from the profile's own disable list", () => {
        const following = ApiProfile.create({ id: "a", provider: "anthropic", anthropic: {} })
        const switched = ApiProfile.create({
            id: "b",
            provider: "anthropic",
            anthropic: { disabledServerTools: [ServerTool.WEB_SEARCH] },
        })

        expect(resolveProfileDisabledServerTools(following)).toEqual([])
        expect(resolveProfileDisabledServerTools(switched)).toEqual([ServerTool.WEB_SEARCH])
    })
})
