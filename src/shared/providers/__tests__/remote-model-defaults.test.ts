import type { ModelInfo } from "@shared/proto/dline/models"
import { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"
import { ApiProfile } from "@shared/proto/dline/profile"
import { OpenAiProviderConfig } from "@shared/proto/dline/provider/openai"
import { describe, expect, it } from "vitest"
import { PROFILE_PROVIDER_KEYS, resolveProfileModelInfo } from "../profile-model-info"

const families: Record<string, ModelInfo> = {
    "gpt-6-astra": {
        id: "gpt-6-astra",
        name: "Astra ancestor",
        apiFormats: [ApiFormat.OPENAI_RESPONSES],
        capabilities: {
            contextWindow: 1_050_000,
            maxTokens: 128_000,
            supportsImages: true,
            tools: [ServerTool.WEB_SEARCH],
            supportsPromptCache: false,
            supportsReasoning: true,
            thinking: {
                supported: true,
                mode: "effort",
                effortLevels: ["low", "medium", "high", "xhigh", "max"],
                defaultEnabled: true,
                canDisable: false,
            },
        },
        pricing: { currency: "USD", strategy: { flat: { prices: { inputPrice: 10, outputPrice: 50 } } } },
    },
}

function resolveOpenAI(id: string, modelInfo?: ModelInfo, openai = OpenAiProviderConfig.create(), models = families) {
    return resolveProfileModelInfo(ApiProfile.create({ provider: "openai", modelId: id, modelInfo, openai }), {
        models,
        defaultModelId: "gpt-6-astra",
    })
}

describe("remote model defaults", () => {
    describe.each(Object.keys(PROFILE_PROVIDER_KEYS))("%s cache capability", (provider) => {
        it.each([undefined, true, false])("resolves a missing or declared cache value %s without losing false", (declared) => {
            const result = resolveProfileModelInfo(
                ApiProfile.create({
                    provider,
                    modelId: "remote-unknown",
                    modelInfo: { id: "remote-unknown", capabilities: { supportsPromptCache: declared } },
                }),
                { models: {}, defaultModelId: "" },
            )
            expect(result.capabilities?.supportsPromptCache).toBe(declared ?? true)
        })
    })

    it("offers enabled compatible thinking without inventing an effort preference for an unknown OpenAI model", () => {
        const result = resolveOpenAI("remote-unknown")
        expect(result.capabilities?.supportsPromptCache).toBe(true)
        expect(result.capabilities?.thinking).toEqual({
            supported: true,
            mode: "effort",
            effortLevels: ["none", "low", "medium", "high"],
            defaultEnabled: true,
            canDisable: true,
        })
        expect(result.capabilities?.thinking?.defaultEffort).toBeUndefined()
        expect(result.pricing).toBeUndefined()
    })

    it("inherits only cache and reasoning from the same GPT major and variant", () => {
        const result = resolveOpenAI("gpt-6.2-astra")
        expect(result.id).toBe("gpt-6.2-astra")
        expect(result.capabilities?.supportsPromptCache).toBe(false)
        expect(result.capabilities?.supportsReasoning).toBe(true)
        expect(result.capabilities?.thinking?.effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"])
        expect(result.capabilities?.thinking?.canDisable).toBe(false)
        expect(result.capabilities?.contextWindow).toBeUndefined()
        expect(result.capabilities?.maxTokens).toBeUndefined()
        expect(result.capabilities?.supportsImages).toBeUndefined()
        expect(result.capabilities?.tools).toBeUndefined()
        expect(result.apiFormats).toBeUndefined()
        expect(result.pricing).toBeUndefined()
        expect(result.name).toBeUndefined()
    })

    it("does not mutate the catalog or selected metadata while filling inherited capabilities", () => {
        const models = structuredClone(families)
        const selected: ModelInfo = { id: "gpt-6.2-astra", capabilities: { supportsPromptCache: true } }
        const before = structuredClone({ models, selected })
        const result = resolveOpenAI(selected.id!, selected, undefined, models)
        expect(result.capabilities?.thinking?.effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"])
        expect(result.capabilities?.supportsPromptCache).toBe(true)
        expect({ models, selected }).toEqual(before)
    })

    it("selects the nearest older minor regardless of catalog order, never a future minor", () => {
        const models: Record<string, ModelInfo> = {
            "gpt-6.4-astra": { id: "gpt-6.4-astra", capabilities: { thinking: { mode: "effort", effortLevels: ["future"] } } },
            ...families,
            "gpt-6.1-astra": { id: "gpt-6.1-astra", capabilities: { thinking: { mode: "effort", effortLevels: ["high"] } } },
        }
        const result = resolveOpenAI("gpt-6.2-astra", undefined, undefined, models)
        expect(result.capabilities?.thinking?.effortLevels).toEqual(["high"])
    })

    it.each([
        "gpt-7.2-astra",
        "gpt-6.2-sol",
        "gpt-6.2-astra-plus",
        "private-gpt-6.2-astra",
    ])("does not cross a major, variant or identity boundary for %s", (id) => {
        const result = resolveOpenAI(id)
        expect(result.capabilities?.supportsPromptCache).toBe(true)
        expect(result.capabilities?.thinking?.effortLevels).toEqual(["none", "low", "medium", "high"])
    })

    it("preserves the selected model's declarations and its own empty effort list", () => {
        const result = resolveOpenAI("gpt-6.2-astra", {
            id: "gpt-6.2-astra",
            capabilities: {
                contextWindow: 65_536,
                supportsPromptCache: true,
                thinking: { supported: true, mode: "effort", effortLevels: [], defaultEnabled: false, canDisable: true },
            },
        })
        expect(result.capabilities?.supportsPromptCache).toBe(true)
        expect(result.capabilities?.contextWindow).toBe(65_536)
        expect(result.capabilities?.thinking?.effortLevels).toEqual([])
        expect(result.capabilities?.thinking?.defaultEnabled).toBe(false)
        expect(result.capabilities?.thinking?.canDisable).toBe(true)
    })

    it("keeps user capability overrides above family inheritance", () => {
        const result = resolveOpenAI(
            "gpt-6.2-astra",
            undefined,
            OpenAiProviderConfig.create({ capabilities: { supportsPromptCache: true, supportsReasoning: false } }),
        )
        expect(result.capabilities?.supportsPromptCache).toBe(true)
        expect(result.capabilities?.supportsReasoning).toBe(false)
    })

    it.each([
        { supportsReasoning: false },
        { thinking: { supported: false } },
    ])("does not activate a model that explicitly refuses thinking: %j", (capabilities) => {
        const result = resolveOpenAI("remote-unknown", { id: "remote-unknown", capabilities })
        expect(result.capabilities?.thinking?.supported === true && result.capabilities?.supportsReasoning !== false).toBe(false)
    })

    it("does not infer OpenAI reasoning for another provider", () => {
        const result = resolveProfileModelInfo(ApiProfile.create({ provider: "together", modelId: "gpt-6.2-astra" }), {
            models: families,
            defaultModelId: "gpt-6-astra",
        })
        expect(result.capabilities?.supportsPromptCache).toBe(true)
        expect(result.capabilities?.thinking).toBeUndefined()
    })
})
