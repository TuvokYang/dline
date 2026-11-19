import type { ModelInfo } from "@shared/proto/dline/models"
import { type ModelCapabilities, ServerTool } from "@shared/proto/dline/models/metadata"
import { ApiProfile } from "@shared/proto/dline/profile"
import { describe, expect, it } from "vitest"
import { resolveProfileModelInfo } from "../profile-model-info"

const cases = [
    { provider: "openai-codex", ancestor: "gpt-6-astra", target: "gpt-6.2-astra", nearest: "gpt-6.1-astra" },
    { provider: "anthropic", ancestor: "claude-fable-5-1", target: "claude-fable-5-3", nearest: "claude-fable-5-2" },
    { provider: "claude-code", ancestor: "claude-fable-5-1", target: "claude-fable-5-3", nearest: "claude-fable-5-2" },
]

function declaration(id: string): ModelInfo {
    return {
        id,
        name: "Ancestor only",
        capabilities: {
            supportsPromptCache: false,
            supportsReasoning: true,
            thinking: { supported: true, mode: "effort", effortLevels: ["low", "high"], defaultEnabled: true, canDisable: false },
            contextWindow: 1_000_000,
            maxTokens: 128_000,
            supportsImages: true,
            tools: [ServerTool.WEB_SEARCH],
        },
        pricing: { currency: "USD", strategy: { flat: { prices: { inputPrice: 10 } } } },
    }
}

function resolveModel(
    provider: string,
    id: string,
    models: Record<string, ModelInfo>,
    modelInfo?: ModelInfo,
    capabilities?: ModelCapabilities,
) {
    const config =
        provider === "openai-codex"
            ? { openaiCodex: { capabilities } }
            : provider === "anthropic"
              ? { anthropic: { capabilities } }
              : { claudeCode: { capabilities } }
    return resolveProfileModelInfo(ApiProfile.create({ provider, modelId: id, modelInfo, ...config }), {
        defaultModelId: Object.keys(models)[0] ?? "",
        models,
    })
}

describe.each(cases)("$provider inherited model capabilities", ({ provider, ancestor, target, nearest }) => {
    it("fills only cache and reasoning while preserving the target identity", () => {
        const result = resolveModel(provider, target, { [ancestor]: declaration(ancestor) })
        expect(result.id).toBe(target)
        expect(result.capabilities?.supportsPromptCache).toBe(false)
        expect(result.capabilities?.thinking?.effortLevels).toEqual(["low", "high"])
        expect(result.capabilities?.thinking?.canDisable).toBe(false)
        expect(result.capabilities?.contextWindow).toBeUndefined()
        expect(result.capabilities?.maxTokens).toBeUndefined()
        expect(result.capabilities?.supportsImages).toBeUndefined()
        expect(result.capabilities?.tools).toBeUndefined()
        expect(result.apiFormats).toBeUndefined()
        expect(result.pricing).toBeUndefined()
        expect(result.name).toBeUndefined()
    })

    it("chooses the nearest older declaration and skips identity-only placeholders", () => {
        const models: Record<string, ModelInfo> = {
            [target.replace(provider === "openai-codex" ? "6.2" : "5-3", provider === "openai-codex" ? "6.9" : "5-9")]:
                declaration("future"),
            [nearest]: { id: nearest, capabilities: { thinking: { mode: "effort", effortLevels: ["max"] } } },
            [ancestor]: declaration(ancestor),
        }
        expect(resolveModel(provider, target, models).capabilities?.thinking?.effortLevels).toEqual(["max"])
        models[nearest] = { id: nearest }
        expect(resolveModel(provider, target, models).capabilities?.thinking?.effortLevels).toEqual(["low", "high"])
    })

    it("preserves selected false and empty declarations over the ancestor", () => {
        const result = resolveModel(
            provider,
            target,
            { [ancestor]: declaration(ancestor) },
            {
                id: target,
                capabilities: {
                    supportsPromptCache: true,
                    thinking: { supported: true, mode: "effort", effortLevels: [], defaultEnabled: false, canDisable: true },
                },
            },
        )
        expect(result.capabilities?.supportsPromptCache).toBe(true)
        expect(result.capabilities?.thinking?.effortLevels).toEqual([])
        expect(result.capabilities?.thinking?.defaultEnabled).toBe(false)
        expect(result.capabilities?.thinking?.canDisable).toBe(true)
    })

    it("applies user capability opt-outs after inheritance", () => {
        const result = resolveModel(provider, target, { [ancestor]: declaration(ancestor) }, undefined, {
            supportsPromptCache: true,
            supportsReasoning: false,
            thinking: { supported: false },
        })
        expect(result.capabilities?.supportsPromptCache).toBe(true)
        expect(result.capabilities?.supportsReasoning).toBe(false)
        expect(result.capabilities?.thinking?.supported).toBe(false)
    })

    it("does not mutate source declarations or let a stale selection supply capabilities", () => {
        const models = { [ancestor]: declaration(ancestor) }
        const before = structuredClone(models)
        const result = resolveModel(provider, target, models, { id: "stale", capabilities: { supportsPromptCache: true } })
        expect(result.capabilities?.supportsPromptCache).toBe(false)
        expect(models).toEqual(before)
    })
})

describe("provider and family boundaries", () => {
    it("enables Codex compatibility without inventing a default effort", () => {
        const result = resolveModel("openai-codex", "opaque-subscription-model", {})
        expect(result.capabilities?.thinking?.effortLevels).toEqual(["none", "low", "medium", "high"])
        expect(result.capabilities?.thinking?.defaultEnabled).toBe(true)
        expect(result.capabilities?.thinking?.defaultEffort).toBeUndefined()
    })

    it.each(["anthropic", "claude-code"])("preserves Claude budget semantics for %s", (provider) => {
        const result = resolveModel(provider, "claude-sonnet-4-9", {
            "claude-sonnet-4-8": {
                id: "claude-sonnet-4-8",
                capabilities: {
                    thinking: { supported: true, mode: "budget", minBudget: 1024, maxBudget: 8192, defaultEnabled: true },
                },
            },
        })
        expect(result.capabilities?.thinking).toMatchObject({ mode: "budget", minBudget: 1024, maxBudget: 8192 })
        expect(result.capabilities?.thinking?.effortLevels).toBeUndefined()
    })

    it.each([
        "claude-sonnet-5-2",
        "claude-fable-6-2",
        "claude-fable-5-2:fast",
        "claude-fable-5-2-20261119",
        "private-claude-fable-5-2",
        "claude-unknown-5-2",
    ])("does not infer a Claude mode across identity boundaries for %s", (target) => {
        const result = resolveModel("anthropic", target, { "claude-fable-5-1": declaration("claude-fable-5-1") })
        expect(result.capabilities?.thinking).toBeUndefined()
        expect(result.capabilities?.supportsPromptCache).toBe(true)
    })

    describe.each(["anthropic", "claude-code"])("%s snapshot boundaries", (provider) => {
        it.each([
            ["claude-sonnet-4-20250514", "claude-sonnet-4-6"],
            ["claude-opus-4-20250514", "claude-opus-4-8"],
        ])("does not read the date in %s as a minor version", (target, ancestor) => {
            const result = resolveModel(provider, target, { [ancestor]: declaration(ancestor) })
            expect(result.id).toBe(target)
            expect(result.capabilities?.thinking).toBeUndefined()
            expect(result.capabilities?.supportsReasoning).toBeUndefined()
            expect(result.capabilities?.supportsPromptCache).toBe(true)
        })
    })

    it("does not activate Claude inheritance for another provider", () => {
        const result = resolveModel("together", "claude-fable-5-3", { "claude-fable-5-1": declaration("claude-fable-5-1") })
        expect(result.capabilities?.thinking).toBeUndefined()
        expect(result.capabilities?.supportsPromptCache).toBe(true)
    })
})
