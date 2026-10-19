import { describe, expect, it } from "vitest"
import { isCustomModel, type ModelOriginFacts } from "@/core/api/model-origin"
import { projectUsageSettlement } from "@/services/telemetry/remote/usage/usageCatalog"
import { buildUsageAggregate } from "@/services/telemetry/remote/usage/usageWindow"
import { servedModelOf } from "../UsageServedModel"
import type { UsageSettlement } from "../UsageSettlement"

const BUILT_IN = { userDefined: false }

function handlerFor(facts: ModelOriginFacts) {
    return {
        getModel: () => ({ id: facts.modelId, info: {} as never }),
        getProviderId: () => facts.providerId,
        isCustomModel: () => isCustomModel(facts),
    }
}

/** The body the service would receive for one request served by this handler. */
function sentBody(facts: ModelOriginFacts): string {
    const servedBy = servedModelOf(handlerFor(facts))
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
        servedBy,
    }
    const aggregate = buildUsageAggregate([{ startedAt: 1_900_000_020_000, ...projectUsageSettlement(settlement) }], {})
    return JSON.stringify(aggregate)
}

describe("servedModelOf", () => {
    it.each<[string, ModelOriginFacts]>([
        ["a model the provider's catalog does not list", { providerId: "anthropic", modelId: "acme-private-7b" }],
        [
            "a model the user added to the catalog",
            { providerId: "deepseek", modelId: "acme-private-7b", catalogModel: { userDefined: true } },
        ],
        [
            "a catalog model behind a custom endpoint (OpenAI Compatible)",
            {
                providerId: "openai",
                modelId: "acme-private-7b",
                baseUrl: "https://llm.corp.example/v1",
                catalogModel: BUILT_IN,
            },
        ],
        ["a model on Ollama", { providerId: "ollama", modelId: "acme-private-7b", catalogModel: BUILT_IN }],
        ["a model on LM Studio", { providerId: "lmstudio", modelId: "acme-private-7b", catalogModel: BUILT_IN }],
    ])("reports %s only as _custom, so its ID is nowhere in the batch", (_case, facts) => {
        const body = sentBody(facts)

        expect(body).not.toContain("acme-private-7b")
        expect(body).toContain(`dline.usage.model.${facts.providerId}.requests._custom`)
    })

    it("reports a built-in catalog model on the provider's own endpoint by its ID", () => {
        const facts = {
            providerId: "anthropic",
            modelId: "claude-sonnet-4.5",
            baseUrl: "https://api.anthropic.com/",
            defaultBaseUrl: "https://api.anthropic.com",
            catalogModel: BUILT_IN,
        }

        expect(servedModelOf(handlerFor(facts))).toEqual({ provider: "anthropic", model: "claude-sonnet-4.5" })
        expect(sentBody(facts)).toContain("dline.usage.model.anthropic.requests.claude-sonnet-4.5")
    })

    it("treats a handler that cannot classify its model as serving the user's own", () => {
        const servedBy = servedModelOf({ getModel: () => ({ id: "something", info: {} as never }), getProviderId: () => "x" })

        expect(servedBy).toEqual({ provider: "x", model: "something", custom: true })
    })
})
