import { ModelRegistry } from "@core/model-registry/ModelRegistry"
import type { ModelInfo } from "@shared/proto/dline/models"
import { ApiProfile } from "@shared/proto/dline/profile"
import type { ReasoningConfig } from "@shared/proto/dline/provider/common"
import { afterEach, describe, expect, it, vi } from "vitest"
import { openAiCodexOAuthManager } from "@/integrations/openai-codex/oauth"
import { getProfileModelInfo } from "../../model-info"
import { AnthropicHandler } from "../anthropic"
import { ClaudeCodeHandler } from "../claude-code"
import { anthropicModels } from "../models/anthropic"
import { claudeCodeModels } from "../models/claude-code"
import { OpenAiCodexHandler } from "../openai-codex"

const providers = ["anthropic", "claude-code", "openai-codex"] as const

afterEach(() => vi.restoreAllMocks())

function resolveProfile(profile: ApiProfile, models: Record<string, ModelInfo>): ApiProfile {
    vi.spyOn(ModelRegistry, "getInstance").mockReturnValue({
        getProviderCatalog: () => ({ provider: profile.provider, models, defaultModelId: Object.keys(models)[0] }),
    } as unknown as ModelRegistry)
    return ApiProfile.create({ ...profile, modelInfo: getProfileModelInfo(profile) })
}

function runtimeProfile(provider: string, reasoning?: ReasoningConfig, veto = false, budget = false): ApiProfile {
    const codex = provider === "openai-codex"
    const ancestor = codex ? "gpt-6-astra" : "claude-opus-5-5"
    const modelId = codex ? "gpt-6.2-astra" : "claude-opus-5-6"
    const model: ModelInfo = {
        id: ancestor,
        capabilities: {
            supportsPromptCache: true,
            supportsReasoning: true,
            contextWindow: 999_999,
            thinking: budget
                ? { supported: true, mode: "budget", minBudget: 1024, maxBudget: 4096, defaultEnabled: true, canDisable: true }
                : {
                      supported: true,
                      mode: "effort",
                      effortLevels: ["none", "low", "high", "max"],
                      defaultEnabled: true,
                      canDisable: true,
                  },
        },
        pricing: { strategy: { flat: { prices: { inputPrice: 999 } } } },
    }
    const config = { reasoning, capabilities: veto ? { supportsReasoning: false } : undefined }
    const arm = codex ? { openaiCodex: config } : provider === "anthropic" ? { anthropic: config } : { claudeCode: config }
    const profile = ApiProfile.create({ id: "inheritance-test", provider, modelId, apiKey: "test-key", ...arm })
    return resolveProfile(profile, { [ancestor]: model })
}

async function requestBody(profile: ApiProfile): Promise<Record<string, any>> {
    if (profile.provider === "openai-codex") {
        const handler = new OpenAiCodexHandler({ profile, mode: "act" })
        vi.spyOn(openAiCodexOAuthManager, "getCredentialContext").mockResolvedValue({ accessToken: "test-token", expires: 0 })
        const bodies: Record<string, any>[] = []
        vi.spyOn(
            handler as unknown as { executeRequest: (...args: any[]) => AsyncGenerator<never> },
            "executeRequest",
        ).mockImplementation(async function* (primary, fallback) {
            bodies.push(primary, fallback)
        })
        for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hello" }])) {
        }
        expect(bodies).toHaveLength(2)
        expect(bodies[1].reasoning).toEqual(bodies[0].reasoning)
        expect(handler.getModel().info).toEqual(profile.modelInfo)
        return bodies[0]
    }
    const handler =
        profile.provider === "anthropic"
            ? new AnthropicHandler({ profile, mode: "act" })
            : new ClaudeCodeHandler({ profile, mode: "act" })
    if (handler instanceof ClaudeCodeHandler) {
        vi.spyOn(handler as unknown as { resolveAccessToken: () => Promise<string> }, "resolveAccessToken").mockResolvedValue(
            "test-token",
        )
        vi.spyOn(handler as unknown as { buildIdentity: () => Promise<any> }, "buildIdentity").mockResolvedValue({
            systemBlocks: [],
            headers: {},
        })
    }
    const create = vi.fn().mockResolvedValue({ [Symbol.asyncIterator]: async function* () {} })
    vi.spyOn(handler as unknown as { ensureClient: () => any }, "ensureClient").mockReturnValue({
        messages: { create },
        beta: { messages: { create } },
    })
    for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hello" }])) {
    }
    expect(handler.getModel().info).toBe(profile.modelInfo)
    return create.mock.calls[0][0]
}

describe.each(providers)("%s inherited request controls", (provider) => {
    it("sends the inherited selected effort through the provider's own wire format", async () => {
        const profile = runtimeProfile(provider, { enableThinking: true, effort: "high" })
        expect(profile.modelInfo?.pricing).toBeUndefined()
        expect(profile.modelInfo?.capabilities?.contextWindow).toBeUndefined()
        const body = await requestBody(profile)
        expect(body.model).toBe(profile.modelId)
        if (provider === "openai-codex") {
            expect(body.reasoning).toEqual({ effort: "high", summary: "auto" })
            expect(body.include).toEqual(["reasoning.encrypted_content"])
            expect(body).not.toHaveProperty("thinking")
        } else {
            expect(body.thinking).toEqual({ type: "adaptive" })
            expect(body.output_config).toEqual({ effort: "high" })
            expect(body).not.toHaveProperty("reasoning_effort")
        }
    })

    it("keeps a user capability veto above inherited reasoning", async () => {
        const body = await requestBody(runtimeProfile(provider, { enableThinking: true, effort: "high" }, true))
        expect(body.reasoning).toBeUndefined()
        expect(body.thinking).toBeUndefined()
        expect(body.output_config).toBeUndefined()
    })
})

describe.each(["anthropic", "claude-code"])("%s final metadata boundaries", (provider) => {
    const models = provider === "anthropic" ? anthropicModels : claudeCodeModels

    it("does not bypass a coarse nearest declaration with an older bundled thinking mode", async () => {
        const profile = resolveProfile(ApiProfile.create({ provider, modelId: "claude-opus-5-7", apiKey: "test-key" }), {
            ...models,
            "claude-opus-5-6": { id: "claude-opus-5-6", capabilities: { supportsReasoning: true } },
        })
        expect(profile.modelInfo?.capabilities?.thinking).toBeUndefined()
        const body = await requestBody(profile)
        expect(body.thinking).toBeUndefined()
        expect(body.output_config).toBeUndefined()
    })

    it.each([
        "claude-sonnet-4-20250514",
        "claude-opus-4-20250514",
    ])("leaves the native thinking mode undeclared for dated snapshot %s", async (modelId) => {
        const profile = resolveProfile(ApiProfile.create({ provider, modelId, apiKey: "test-key" }), models)
        expect(profile.modelInfo?.capabilities?.thinking).toBeUndefined()
        const body = await requestBody(profile)
        expect(body.model).toBe(modelId)
        expect(body.thinking).toBeUndefined()
        expect(body.output_config).toBeUndefined()
    })
})

describe("inherited native mode boundaries", () => {
    it.each(["anthropic", "claude-code"])("sends bounded budgets instead of efforts for %s", async (provider) => {
        const body = await requestBody(runtimeProfile(provider, { enableThinking: true, thinkingBudget: 2048 }, false, true))
        expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 2048 })
        expect(body.output_config).toBeUndefined()
    })

    it("leaves the Codex effort absent when the inherited declaration gives no default", async () => {
        const body = await requestBody(runtimeProfile("openai-codex"))
        expect(body.reasoning).toEqual({ summary: "auto" })
        expect(body).not.toHaveProperty("max_output_tokens")
    })

    it("sends an explicit Codex opt-out without encrypted reasoning", async () => {
        const body = await requestBody(runtimeProfile("openai-codex", { enableThinking: false }))
        expect(body.reasoning).toEqual({ effort: "none" })
        expect(body.include).toBeUndefined()
    })
})
