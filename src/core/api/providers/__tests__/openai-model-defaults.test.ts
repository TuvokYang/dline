import type { ModelInfo } from "@shared/proto/dline/models"
import { ApiFormat } from "@shared/proto/dline/models/metadata"
import { ApiProfile } from "@shared/proto/dline/profile"
import type { ReasoningConfig } from "@shared/proto/dline/provider/common"
import { OpenAiProviderConfig } from "@shared/proto/dline/provider/openai"
import type OpenAI from "openai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { OpenAiHandler } from "../openai"

function createHandler(modelId: string, apiFormat: ApiFormat, reasoning?: ReasoningConfig, modelInfo?: ModelInfo) {
    return new OpenAiHandler({
        profile: ApiProfile.create({
            provider: "openai",
            modelId,
            modelInfo,
            openai: OpenAiProviderConfig.create({ apiFormat, reasoning }),
        }),
        mode: "act",
    })
}

afterEach(() => vi.restoreAllMocks())

describe("OpenAI effective remote metadata", () => {
    it("defaults a directly constructed unknown model's cache to true", () => {
        const model = createHandler("remote-unknown", ApiFormat.OPENAI_CHAT).getModel()
        expect(model.id).toBe("remote-unknown")
        expect(model.info.capabilities?.supportsPromptCache).toBe(true)
        expect(model.info.capabilities?.thinking?.defaultEnabled).toBe(true)
    })

    it("inherits a new Astra minor's reasoning without inheriting billing or hosted tools", () => {
        const model = createHandler("gpt-6.99-astra", ApiFormat.OPENAI_RESPONSES).getModel()
        expect(model.id).toBe("gpt-6.99-astra")
        expect(model.info.capabilities?.thinking?.effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"])
        expect(model.info.capabilities?.supportsPromptCache).toBe(true)
        expect(model.info.pricing).toBeUndefined()
        expect(model.info.capabilities?.tools).toBeUndefined()
    })

    describe.each([ApiFormat.OPENAI_CHAT, ApiFormat.OPENAI_RESPONSES])("wire format %s", (apiFormat) => {
        it.each([
            { id: "remote-unknown", config: undefined, effort: undefined },
            { id: "remote-unknown", config: { enableThinking: true, effort: "high" }, effort: "high" },
            { id: "remote-unknown", config: { enableThinking: false }, effort: "none" },
            { id: "remote-unknown", config: { enableThinking: true, effort: "unsupported" }, effort: undefined },
            { id: "gpt-6.99-astra", config: { enableThinking: true, effort: "max" }, effort: "max" },
        ])("sends the selected effort $effort for $id without inventing a default", async ({ id, config, effort }) => {
            const handler = createHandler(id, apiFormat, config)
            const create = vi.fn().mockResolvedValue({ [Symbol.asyncIterator]: async function* () {} })
            vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
                chat: { completions: { create } },
                responses: { create },
            })
            for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hello" }])) {
                // Consume the complete request without contacting a provider.
            }
            const request = create.mock.calls[0]?.[0] as OpenAI.Chat.ChatCompletionCreateParams &
                OpenAI.Responses.ResponseCreateParams
            expect(request.model).toBe(id)
            if (apiFormat === ApiFormat.OPENAI_CHAT) {
                expect(request.reasoning_effort).toBe(effort)
            } else {
                expect(request.reasoning?.effort).toBe(effort)
                expect(request).not.toHaveProperty("reasoning_effort")
                expect(request).not.toHaveProperty("enable_thinking")
                expect(request).not.toHaveProperty("thinking_budget")
            }
        })

        it("does not send reasoning controls when the selected model explicitly refuses reasoning", async () => {
            const handler = createHandler(
                "remote-unknown",
                apiFormat,
                { enableThinking: true, effort: "high" },
                { id: "remote-unknown", capabilities: { supportsReasoning: false } },
            )
            const create = vi.fn().mockResolvedValue({ [Symbol.asyncIterator]: async function* () {} })
            vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
                chat: { completions: { create } },
                responses: { create },
            })
            for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hello" }])) {
                // Consume the request to inspect the public wire payload.
            }
            const request = create.mock.calls[0]?.[0]
            expect(request).not.toHaveProperty("reasoning_effort")
            expect(request).not.toHaveProperty("reasoning")
        })
    })
})
