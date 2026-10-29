import { describe, expect, it } from "vitest"
import { buildCustomModelInfo } from "./anthropicCustomModel"

describe("buildCustomModelInfo", () => {
    it("builds model info from Anthropic custom provider fields", () => {
        const result = buildCustomModelInfo({
            modelId: "custom-claude-compatible-model",
            defaults: {
                id: "",
                capabilities: {
                    maxTokens: 64_000,
                    contextWindow: 200_000,
                    supportsImages: true,
                    supportsPromptCache: true,
                    supportsReasoning: true,
                },
                pricing: {
                    inputPrice: 1,
                    outputPrice: 2,
                },
            },
            capabilities: {
                maxTokens: 12_345,
                contextWindow: 67_890,
                supportsImages: false,
                supportsPromptCache: false,
                supportsReasoning: false,
            },
            pricing: {
                inputPrice: 0.5,
                outputPrice: 1.5,
            },
        })

        expect(result.id).to.equal("custom-claude-compatible-model")
        expect(result.name).to.equal("custom-claude-compatible-model")
        expect(result.capabilities?.maxTokens).to.equal(12_345)
        expect(result.capabilities?.supportsPromptCache).to.equal(false)
        expect(result.pricing?.inputPrice).to.equal(0.5)
    })
})
