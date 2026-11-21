import { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"
import { ApiProfile } from "@shared/proto/dline/profile"
import type { ReasoningConfig } from "@shared/proto/dline/provider/common"
import type OpenAI from "openai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiHandler } from "../../ApiHandler"
import { openAiDefaultModelId, openAiModels } from "../models/openai"
import { openAiCodexDefaultModelId, openAiCodexModels } from "../models/openai-codex"
import { OpenAiHandler } from "../openai"

const models = ["gpt-6.2-astra", "gpt-6.2-sol"] as const

afterEach(() => vi.restoreAllMocks())

function createHandler(modelId: string, reasoning?: ReasoningConfig) {
    return new OpenAiHandler({
        profile: ApiProfile.create({
            provider: "openai",
            modelId,
            openai: { reasoning, temperature: 0.5 },
        }),
        mode: "act",
    })
}

describe("GPT-6.2 bundled metadata", () => {
    it.each(models)("resolves %s with its own limits and required reasoning", (id) => {
        expect(openAiModels[id]).toBeDefined()
        const { info } = createHandler(id).getModel()
        expect(info.apiFormats).toEqual([ApiFormat.OPENAI_RESPONSES])
        expect(info.capabilities).toMatchObject({
            contextWindow: 1_050_000,
            maxTokens: 128_000,
            supportsImages: true,
            supportsStreaming: true,
            supportsTools: true,
            supportsPromptCache: true,
            thinking: {
                supported: true,
                mode: "effort",
                effortLevels: ["low", "medium", "high", "xhigh", "max"],
                defaultEnabled: true,
                canDisable: false,
            },
        })
        expect(info.capabilities?.tools).toContain(ServerTool.WEB_SEARCH)
        expect(info.capabilities?.tools).toContain(ServerTool.IMAGE_GENERATION)
    })

    // Official Standard rates, including 30-minute cache writes. The threshold
    // counts uncached input, cache reads and cache writes together.
    it.each([
        { id: "gpt-6.2-astra", input: 242_000, amount: 2.084 },
        { id: "gpt-6.2-astra", input: 242_001, amount: 4.148016 },
        { id: "gpt-6.2-sol", input: 242_000, amount: 0.521 },
        { id: "gpt-6.2-sol", input: 242_001, amount: 1.037004 },
    ])("bills $id at the 272K boundary with $input uncached tokens", ({ id, input, amount }) => {
        const pricing = createHandler(id).getModel().info.pricing
        const result = ApiHandler.calculateUsageCost(
            pricing,
            { inputTokens: input, cacheReadTokens: 20_000, cacheWriteTokens: 10_000, outputTokens: 1_000 },
            1_795_046_400_000,
        )
        expect(result.kind).toBe("calculated")
        if (result.kind !== "calculated") throw new Error("Expected published GPT-6.2 pricing")
        expect(result.currency).toBe("USD")
        expect(result.amount).toBeCloseTo(amount, 10)
    })

    it.each([
        { id: "gpt-6.2-astra", context: 272_000 },
        { id: "gpt-6.2-sol", context: 500_000 },
    ])("keeps $id Codex defaults separate from API prices and limits", ({ id, context }) => {
        const model = openAiCodexModels[id]
        expect(model).toBeDefined()
        expect(model.capabilities?.contextWindow).toBe(context)
        expect(model.apiFormats).toEqual([ApiFormat.OPENAI_RESPONSES, ApiFormat.OPENAI_RESPONSES_WEBSOCKET_MODE])
        expect(model.pricing).toBeUndefined()
        // The account listing, not an API catalog copy, declares Codex effort controls.
        expect(model.capabilities?.thinking).toBeUndefined()
    })

    it("preserves existing provider defaults", () => {
        expect(openAiDefaultModelId).toBe("gpt-5.6-sol")
        expect(openAiCodexDefaultModelId).toBe("gpt-5.6-sol")
    })
})

describe("GPT-6.1 Terra", () => {
    const id = "gpt-6.1-terra"

    it("offers Responses tools and optionally disables reasoning", () => {
        const model = createHandler(id).getModel()
        expect(model.id).toBe(id)
        expect(model.info.name).toBe("GPT-6.1 Terra")
        expect(model.info.apiFormats).toEqual([ApiFormat.OPENAI_RESPONSES])
        expect(model.info.capabilities).toMatchObject({
            contextWindow: 1_050_000,
            maxTokens: 128_000,
            supportsImages: true,
            supportsStreaming: true,
            supportsTools: true,
            supportsPromptCache: true,
            tools: [ServerTool.WEB_SEARCH, ServerTool.IMAGE_GENERATION],
            thinking: {
                supported: true,
                mode: "effort",
                effortLevels: ["none", "low", "medium", "high", "xhigh", "max"],
                defaultEffort: "medium",
                defaultEnabled: true,
                canDisable: true,
            },
        })
    })

    it.each([
        { input: 242_000, amount: 0.2605 },
        { input: 242_001, amount: 0.518502 },
    ])("bills the whole request at the correct rate with $input uncached tokens", ({ input, amount }) => {
        const result = ApiHandler.calculateUsageCost(
            createHandler(id).getModel().info.pricing,
            { inputTokens: input, cacheReadTokens: 20_000, cacheWriteTokens: 10_000, outputTokens: 1_000 },
            1_795_046_400_000,
        )
        expect(result.kind).toBe("calculated")
        if (result.kind !== "calculated") throw new Error("Expected published Terra pricing")
        expect(result.currency).toBe("USD")
        expect(result.amount).toBeCloseTo(amount, 10)
    })

    it.each([
        { config: undefined, effort: "medium" },
        { config: { enableThinking: false }, effort: "none" },
        { config: { enableThinking: true, effort: "max" }, effort: "max" },
    ])("sends $effort on a Responses tool request", async ({ config, effort }) => {
        const handler = createHandler(id, config)
        const create = vi.fn().mockResolvedValue({ [Symbol.asyncIterator]: async function* () {} })
        vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
            responses: { create },
        })
        for await (const _chunk of handler.createMessage(
            "stable instructions",
            [{ role: "user", content: "hello" }],
            [{ type: "function", function: { name: "inspect", parameters: { type: "object", properties: {} } } }],
        )) {
            // Consume the request without contacting a provider.
        }
        const request = create.mock.calls[0]?.[0] as OpenAI.Responses.ResponseCreateParams
        expect(request.model).toBe(id)
        expect(request.tools).toMatchObject([{ type: "function", name: "inspect" }])
        expect(request.reasoning).toEqual(effort === "none" ? { effort } : { effort, summary: "auto" })
        if (effort !== "none") expect(request).not.toHaveProperty("temperature")
    })

    it("keeps account-specific limits and reasoning separate from the API catalog", () => {
        const model = openAiCodexModels[id]
        expect(model?.name).toBe("GPT-6.1 Terra")
        expect(model.apiFormats).toEqual([ApiFormat.OPENAI_RESPONSES, ApiFormat.OPENAI_RESPONSES_WEBSOCKET_MODE])
        expect(model.pricing).toBeUndefined()
        expect(model.capabilities?.contextWindow).toBeUndefined()
        expect(model.capabilities?.thinking).toBeUndefined()
    })
})

describe.each(models)("%s Responses requests", (id) => {
    it.each([
        { enableThinking: true, effort: "max" },
        { enableThinking: false, effort: "none" },
    ])("does not send unsupported parameters for $effort", async (reasoning) => {
        const handler = createHandler(id, reasoning)
        const create = vi.fn().mockResolvedValue({ [Symbol.asyncIterator]: async function* () {} })
        vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
            responses: { create },
        })
        for await (const _chunk of handler.createMessage(
            "stable instructions",
            [{ role: "user", content: "hello" }],
            [{ type: "function", function: { name: "inspect", parameters: { type: "object", properties: {} } } }],
        )) {
            // Consume the request without contacting a provider.
        }
        const request = create.mock.calls[0]?.[0] as OpenAI.Responses.ResponseCreateParams
        expect(request.model).toBe(id)
        expect(request.tools).toMatchObject([{ type: "function", name: "inspect" }])
        expect(request.reasoning).toMatchObject({ summary: "auto" })
        expect(request.reasoning?.effort).toBe(reasoning.effort === "max" ? "max" : undefined)
        expect(request).not.toHaveProperty("temperature")
        expect(request).not.toHaveProperty("top_p")
        expect(request).not.toHaveProperty("reasoning_effort")
    })
})
