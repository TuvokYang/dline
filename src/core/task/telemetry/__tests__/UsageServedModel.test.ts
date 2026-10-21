import { ApiProfile } from "@shared/proto/dline/profile"
import { describe, expect, it } from "vitest"
import { isCustomModel } from "@/core/api/model-origin"
import type { UsageBodyWire } from "@/services/telemetry/remote/contracts/usageBody"
import { buildUsageBody } from "@/services/telemetry/remote/usage/usageBatch"
import { projectUsageSettlement } from "@/services/telemetry/remote/usage/usageTally"
import { servedModelOf } from "../UsageServedModel"
import type { UsageSettlement } from "../UsageSettlement"

/** A handler as the factory builds it: the custom-model answer comes from the Profile it was built for. */
function handlerFor(profile: ApiProfile) {
    return {
        getModel: () => ({ id: profile.modelId ?? "", info: {} as never }),
        getProviderId: () => profile.provider,
        isCustomModel: () => isCustomModel(profile),
    }
}

/** The body the service would receive for one request served by this Profile. */
function sentBody(profile: ApiProfile): UsageBodyWire {
    const settlement: UsageSettlement = {
        observationId: "o",
        purpose: "task",
        outcome: "completed",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 3,
        cacheWriteTokens: 0,
        durationMs: 700,
        streamTiming: { ttftMs: 200, generationMs: 500 },
        servedBy: servedModelOf(handlerFor(profile)),
    }
    const minute = { startedAt: 1_900_000_020_000, tally: projectUsageSettlement(settlement) }
    const body = buildUsageBody([minute], { version: "0.11.1" }, 0)
    if (!body) throw new Error("expected a usage body")
    return body
}

function reportedModels(body: UsageBodyWire) {
    return body.models.map(({ provider, model, custom }) => ({ provider, model, ...(custom === undefined ? {} : { custom }) }))
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
            "my-namespace_my-custom-model",
        ],
    ])("reports %s under its own name, marked custom", (_case, profile, reported) => {
        expect(reportedModels(sentBody(profile))).toEqual([{ provider: profile.provider, model: reported, custom: true }])
    })

    it.each<[string, ApiProfile, string]>([
        ["a local Ollama model", ApiProfile.create({ provider: "ollama", modelId: "qwen3:8b" }), "qwen3_8b"],
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
        expect(reportedModels(sentBody(profile))).toEqual([{ provider: profile.provider, model: reported }])
    })

    it("counts a handler that cannot say under its model ID", () => {
        const servedBy = servedModelOf({ getModel: () => ({ id: "something", info: {} as never }), getProviderId: () => "x" })

        expect(servedBy).toEqual({ provider: "x", model: "something" })
    })
})
