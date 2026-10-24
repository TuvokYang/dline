import { ApiProfile } from "@shared/proto/dline/profile"
import { describe, expect, it } from "vitest"
import { isCustomModel } from "@/core/api/model-origin"
import { servedModelOf } from "../UsageServedModel"

/** A handler as the factory builds it: the custom-model answer comes from the Profile it was built for. */
function handlerFor(profile: ApiProfile) {
    return {
        getModel: () => ({ id: profile.modelId ?? "", info: {} as never }),
        getProviderId: () => profile.provider,
        isCustomModel: () => isCustomModel(profile),
    }
}

describe("servedModelOf", () => {
    it.each<[string, ApiProfile, string]>([
        [
            "OpenAI with Use custom model ID switched on",
            ApiProfile.create({
                provider: "openai",
                modelId: "acme-private-7b",
                baseUrl: "https://llm.corp.example/v1",
                openai: { customModelEnabled: true },
            }),
            "acme-private-7b",
        ],
        [
            "Anthropic with the switch on, even for an ID the catalog lists",
            ApiProfile.create({ provider: "anthropic", modelId: "claude-sonnet-4-5", anthropic: { customModelEnabled: true } }),
            "claude-sonnet-4-5",
        ],
        [
            "Bedrock's Custom model entry",
            ApiProfile.create({
                provider: "bedrock",
                modelId: "my-namespace/my-custom-model",
                bedrock: { awsBedrockCustomSelected: true },
            }),
            "my-namespace/my-custom-model",
        ],
    ])("reports %s under its own name, marked custom", (_case, profile, reported) => {
        expect(servedModelOf(handlerFor(profile))).toEqual({ provider: profile.provider, model: reported, custom: true })
    })

    it.each<[string, ApiProfile, string]>([
        ["a local Ollama model", ApiProfile.create({ provider: "ollama", modelId: "qwen3:8b" }), "qwen3:8b"],
        ["an LM Studio model", ApiProfile.create({ provider: "lmstudio", modelId: "acme-private-7b" }), "acme-private-7b"],
        [
            "a model picked from the list behind a custom base URL",
            ApiProfile.create({
                provider: "openai",
                modelId: "acme-listed-model",
                baseUrl: "https://llm.corp.example/v1",
                openai: { customModelEnabled: false },
            }),
            "acme-listed-model",
        ],
        [
            "a switch stored under another provider's config",
            ApiProfile.create({ provider: "openai", modelId: "gpt-listed", anthropic: { customModelEnabled: true } }),
            "gpt-listed",
        ],
        [
            "a Bedrock catalog model, whose only switch is the Custom entry",
            ApiProfile.create({
                provider: "bedrock",
                modelId: "anthropic.claude-sonnet-4-6",
                bedrock: { customModelEnabled: true, awsBedrockCustomSelected: false },
            }),
            "anthropic.claude-sonnet-4-6",
        ],
    ])("reports %s by its ID when the custom switch is off", (_case, profile, reported) => {
        expect(servedModelOf(handlerFor(profile))).toEqual({ provider: profile.provider, model: reported })
    })

    it("counts a handler that cannot say under its model ID", () => {
        const servedBy = servedModelOf({ getModel: () => ({ id: "something", info: {} as never }), getProviderId: () => "x" })

        expect(servedBy).toEqual({ provider: "x", model: "something" })
    })
})
