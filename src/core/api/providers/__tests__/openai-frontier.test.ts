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
        expect(model.apiFormats).toEqual([ApiFormat.OPENAI_RESPONSES])
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
        expect(request.instructions).toBe("stable instructions")
        expect(request.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "hello" }] }])
        expect(request.tools).toMatchObject([{ type: "function", name: "inspect" }])
        expect(request.reasoning).toEqual(effort === "none" ? { effort } : { effort, summary: "auto" })
        if (effort !== "none") expect(request).not.toHaveProperty("temperature")
    })

    it("keeps account-specific limits and reasoning separate from the API catalog", () => {
        const model = openAiCodexModels[id]
        expect(model?.name).toBe("GPT-6.1 Terra")
        expect(model.apiFormats).toEqual([ApiFormat.OPENAI_RESPONSES])
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
        expect(request.instructions).toBeUndefined()
        expect(request.prompt_cache_options).toBeUndefined()
        expect(request.input).toEqual([
            {
                type: "message",
                role: "developer",
                content: [{ type: "input_text", text: "stable instructions" }],
            },
            { role: "user", content: [{ type: "input_text", text: "hello" }] },
        ])
        expect(JSON.stringify(request)).not.toContain("prompt_cache_breakpoint")
        expect(request.tools).toMatchObject([{ type: "function", name: "inspect" }])
        expect(request.reasoning).toMatchObject({ summary: "auto" })
        expect(request.reasoning?.effort).toBe(reasoning.effort === "max" ? "max" : undefined)
        expect(request).not.toHaveProperty("temperature")
        expect(request).not.toHaveProperty("top_p")
        expect(request).not.toHaveProperty("reasoning_effort")
    })

    it("uses WebSocket transport for GPT-6.2 initial and continuation turns when websocketEnabled is true", async () => {
        const handler = new OpenAiHandler({
            profile: ApiProfile.create({
                provider: "openai",
                modelId: id,
                openai: { apiFormat: ApiFormat.OPENAI_RESPONSES, websocketEnabled: true },
            }),
            mode: "act",
        })
        const wsCalls: OpenAI.Responses.ResponseCreateParamsStreaming[] = []
        vi.spyOn(handler as any, "createResponseEventsViaWebsocket").mockImplementation(async (...args: unknown[]) => {
            const params = args[0] as OpenAI.Responses.ResponseCreateParamsStreaming
            wsCalls.push(params)
            return {
                stream: {
                    [Symbol.asyncIterator]: async function* () {
                        yield { type: "response.output_text.delta", delta: `ws-${wsCalls.length}` }
                        yield { type: "response.completed", response: { id: `resp_${wsCalls.length}`, status: "completed" } }
                    },
                },
                sentAtMs: Date.now(),
                release: vi.fn(),
            }
        })
        const httpCreate = vi.fn()
        vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
            responses: { create: httpCreate },
        })

        // Turn 1: initial turn starts on WebSocket with leading developer system prompt.
        for await (const _chunk of handler.createMessage("stable instructions", [{ role: "user", content: "turn 1" }])) {
            // Consume stream.
        }
        // Turn 2: continuation inherits developer prompt via previous_response_id.
        for await (const _chunk of handler.createMessage("stable instructions", [
            { role: "user", content: "turn 1" },
            {
                role: "assistant",
                content: [{ type: "text", text: "ws-1" }],
                ts: Date.now(),
                provider_metadata: { response_id: "resp_1" },
            },
            { role: "user", content: "turn 2" },
        ])) {
            // Consume stream.
        }

        expect(httpCreate).not.toHaveBeenCalled()
        expect(wsCalls).toHaveLength(2)
        expect(wsCalls[0].instructions).toBeUndefined()
        expect(wsCalls[0].previous_response_id).toBeUndefined()
        expect(wsCalls[0].input).toEqual([
            { type: "message", role: "developer", content: [{ type: "input_text", text: "stable instructions" }] },
            { role: "user", content: [{ type: "input_text", text: "turn 1" }] },
        ])
        expect(wsCalls[1].instructions).toBeUndefined()
        expect(wsCalls[1].previous_response_id).toBe("resp_1")
        expect(wsCalls[1].input).toEqual([{ role: "user", content: [{ type: "input_text", text: "turn 2" }] }])
        expect(wsCalls[1].prompt_cache_key).toBe(wsCalls[0].prompt_cache_key)
    })

    it("retries full context on a fresh WebSocket after previous_response_not_found and falls back to HTTP on WS failure", async () => {
        const handler = new OpenAiHandler({
            profile: ApiProfile.create({
                provider: "openai",
                modelId: id,
                openai: { apiFormat: ApiFormat.OPENAI_RESPONSES, websocketEnabled: true },
            }),
            mode: "act",
        })
        const wsCalls: OpenAI.Responses.ResponseCreateParamsStreaming[] = []
        const closeSpy = vi.spyOn(handler as any, "closeResponsesWebsocket")
        vi.spyOn(handler as any, "createResponseEventsViaWebsocket").mockImplementation(async (...args: unknown[]) => {
            const params = args[0] as OpenAI.Responses.ResponseCreateParamsStreaming
            wsCalls.push(params)
            if (wsCalls.length === 1) {
                throw Object.assign(new Error("Previous response not found"), { code: "previous_response_not_found" })
            }
            throw Object.assign(new Error("WS unsupported"), { code: "websocket_concurrency_limit" })
        })
        const httpCreate = vi.fn().mockResolvedValue({
            [Symbol.asyncIterator]: async function* () {
                yield { type: "response.output_text.delta", delta: "from-http" }
            },
        })
        vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
            responses: { create: httpCreate },
        })

        const texts: string[] = []
        for await (const chunk of handler.createMessage("stable instructions", [
            { role: "user", content: "turn 1" },
            {
                role: "assistant",
                content: [{ type: "text", text: "answer 1" }],
                ts: Date.now(),
                provider_metadata: { response_id: "resp_expired" },
            },
            { role: "user", content: "turn 2" },
        ])) {
            if (chunk.type === "text") texts.push(chunk.text)
        }

        expect(texts).toEqual(["from-http"])
        expect(closeSpy).toHaveBeenCalledTimes(2)
        expect(wsCalls).toHaveLength(2)
        expect(wsCalls[0].previous_response_id).toBe("resp_expired")
        expect(wsCalls[0].input).toEqual([{ role: "user", content: [{ type: "input_text", text: "turn 2" }] }])
        expect(wsCalls[1].previous_response_id).toBeUndefined()
        expect(wsCalls[1].input).toEqual([
            { type: "message", role: "developer", content: [{ type: "input_text", text: "stable instructions" }] },
            { role: "user", content: [{ type: "input_text", text: "turn 1" }] },
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer 1" }] },
            { role: "user", content: [{ type: "input_text", text: "turn 2" }] },
        ])
        expect(httpCreate).toHaveBeenCalledTimes(1)
        const httpParams = httpCreate.mock.calls[0]?.[0] as OpenAI.Responses.ResponseCreateParamsStreaming
        expect(httpParams.previous_response_id).toBeUndefined()
        expect(httpParams.instructions).toBeUndefined()
        expect(httpParams.input).toEqual(wsCalls[1].input)
    })
})
