/**
 * Unit tests for getAvailableModels handler.
 */

// sinon import removed: using vitest globals
import { ModelRegistry } from "@core/model-registry/ModelRegistry"
import { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"
import { expect } from "chai"
import { afterEach, beforeEach, describe, it, vi } from "vitest"
import { getAvailableModels } from "../getAvailableModels"

describe("getAvailableModels handler", () => {
    let sandbox: any /* sinon.SinonSandbox → vitest */

    beforeEach(() => {
        sandbox = { mockRestore: () => {} }
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("should return models with defaultModelId", async () => {
        // Stub ModelRegistry
        const mockRegistry = {
            isInitialized: true,
            waitForDeferredProviders: vi.fn().mockResolvedValue(undefined),
            getAllModels: vi.fn().mockReturnValue([
                {
                    provider: "doubao",
                    providerName: "Doubao",
                    defaultModelId: "doubao-pro-256k",
                    models: [
                        {
                            id: "doubao-pro-256k",
                            name: "Doubao Pro 256K",
                            maxTokens: 12288,
                            contextWindow: 256000,
                            capabilities: {
                                supportsImages: false,
                                supportsPromptCache: false,
                                contextWindow: 256000,
                            },
                        },
                    ],
                },
            ]),
        }
        vi.spyOn(ModelRegistry, "getInstance").mockReturnValue(mockRegistry as any)

        const controller = {} as any
        const response = await getAvailableModels(controller)

        expect(response.providers).to.have.lengthOf(1)
        expect(response.providers?.[0].provider).to.equal("doubao")
        expect(response.providers?.[0].defaultModelId).to.equal("doubao-pro-256k")
        expect(response.providers?.[0].models).to.have.lengthOf(1)
        expect(response.providers?.[0].models?.[0].id).to.equal("doubao-pro-256k")
        expect(response.providers?.[0].models?.[0].capabilities?.contextWindow).to.equal(256000)
    })

    it("projects the image model catalog without mixing it into chat models", async () => {
        const mockRegistry = {
            isInitialized: true,
            waitForDeferredProviders: vi.fn().mockResolvedValue(undefined),
            getAllModels: vi.fn().mockReturnValue([
                {
                    provider: "openai",
                    providerName: "OpenAI",
                    defaultModelId: "gpt-chat",
                    models: [{ id: "gpt-chat", name: "GPT Chat" }],
                    defaultImageModelId: "gpt-image-2",
                    imageModels: [{ id: "gpt-image-2", name: "GPT Image 2" }],
                },
            ]),
        }
        vi.spyOn(ModelRegistry, "getInstance").mockReturnValue(mockRegistry as any)

        const response = await getAvailableModels({} as any)
        const provider = response.providers[0] as unknown as {
            defaultImageModelId?: string
            imageModels?: Array<{ id: string }>
            models: Array<{ id: string }>
        }

        expect(provider.models.map((model) => model.id)).to.deep.equal(["gpt-chat"])
        expect(provider.defaultImageModelId).to.equal("gpt-image-2")
        expect(provider.imageModels?.map((model) => model.id)).to.deep.equal(["gpt-image-2"])
    })

    it("should pass thinking config when model declares thinking metadata", async () => {
        const mockRegistry = {
            isInitialized: true,
            waitForDeferredProviders: vi.fn().mockResolvedValue(undefined),
            getAllModels: vi.fn().mockReturnValue([
                {
                    provider: "gemini",
                    providerName: "Gemini",
                    models: [
                        {
                            id: "gemini-2.5-pro",
                            name: "Gemini 2.5 Pro",
                            capabilities: {
                                supportsImages: true,
                                supportsPromptCache: false,
                                supportsReasoning: true,
                                maxTokens: 65536,
                                contextWindow: 1048576,
                                thinking: {
                                    maxBudget: 24576,
                                },
                            },
                        },
                    ],
                },
            ]),
        }
        vi.spyOn(ModelRegistry, "getInstance").mockReturnValue(mockRegistry as any)

        const controller = {} as any
        const response = await getAvailableModels(controller)

        const model = response.providers?.[0].models?.[0]
        expect(model.capabilities?.thinking?.maxBudget).to.equal(24576)
    })

    it("should initialize registry if not initialized", async () => {
        const initStub = vi.fn().mockResolvedValue(undefined)
        const mockRegistry = {
            isInitialized: false,
            initialize: initStub,
            waitForDeferredProviders: vi.fn().mockResolvedValue(undefined),
            getAllModels: vi.fn().mockReturnValue([]),
        }
        vi.spyOn(ModelRegistry, "getInstance").mockReturnValue(mockRegistry as any)

        const controller = {} as any
        await getAvailableModels(controller)

        expect(initStub.mock.calls.length === 1).to.be.true
    })

    it("should return multiple providers in response", async () => {
        const mockRegistry = {
            isInitialized: true,
            waitForDeferredProviders: vi.fn().mockResolvedValue(undefined),
            getAllModels: vi.fn().mockReturnValue([
                {
                    provider: "anthropic",
                    providerName: "Anthropic",
                    defaultModelId: "claude-sonnet-4-6",
                    models: [
                        {
                            id: "claude-sonnet-4-6",
                            name: "Claude Sonnet 4.6",
                            maxTokens: 8192,
                            contextWindow: 200000,
                            capabilities: {
                                supportsImages: true,
                                supportsPromptCache: true,
                                contextWindow: 200000,
                            },
                        },
                    ],
                },
                {
                    provider: "openai",
                    providerName: "OpenAI",
                    defaultModelId: "gpt-5",
                    models: [
                        {
                            id: "gpt-5",
                            name: "GPT-5",
                            maxTokens: 4096,
                            contextWindow: 128000,
                            capabilities: {
                                supportsImages: false,
                                supportsPromptCache: false,
                                contextWindow: 128000,
                            },
                        },
                    ],
                },
            ]),
        }
        vi.spyOn(ModelRegistry, "getInstance").mockReturnValue(mockRegistry as any)

        const controller = {} as any
        const response = await getAvailableModels(controller)

        expect(response.providers).to.have.lengthOf(2)
        expect(response.providers?.[0].provider).to.equal("anthropic")
        expect(response.providers?.[1].provider).to.equal("openai")
        expect(response.providers?.[0].models).to.have.lengthOf(1)
        expect(response.providers?.[1].models).to.have.lengthOf(1)
    })

    it("should include optional model fields like supportsImages and description", async () => {
        const mockRegistry = {
            isInitialized: true,
            waitForDeferredProviders: vi.fn().mockResolvedValue(undefined),
            getAllModels: vi.fn().mockReturnValue([
                {
                    provider: "test-provider",
                    providerName: "Test Provider",
                    models: [
                        {
                            id: "test-model",
                            name: "Test Model",
                            maxTokens: 4096,
                            contextWindow: 128000,
                            capabilities: {
                                supportsImages: true,
                                supportsPromptCache: true,
                                contextWindow: 128000,
                            },
                            description: "A model for testing",
                            pricing: {
                                currency: "USD",
                            },
                        },
                    ],
                },
            ]),
        }
        vi.spyOn(ModelRegistry, "getInstance").mockReturnValue(mockRegistry as any)

        const controller = {} as any
        const response = await getAvailableModels(controller)

        const model = response.providers?.[0].models?.[0]
        expect(model.capabilities?.supportsImages).to.be.true
        expect(model.capabilities?.supportsPromptCache).to.be.true
        expect(model.description).to.equal("A model for testing")
        expect(model.pricing?.currency).to.equal("USD")
    })

    it("preserves API formats and server-tool capabilities for the Webview catalog", async () => {
        const mockRegistry = {
            isInitialized: true,
            waitForDeferredProviders: vi.fn().mockResolvedValue(undefined),
            getAllModels: vi.fn().mockReturnValue([
                {
                    provider: "deepseek",
                    providerName: "DeepSeek",
                    models: [
                        {
                            id: "deepseek-v4-pro",
                            apiFormats: [ApiFormat.OPENAI_CHAT, ApiFormat.OPENAI_RESPONSES, ApiFormat.ANTHROPIC_CHAT],
                            capabilities: {
                                supportsTools: true,
                                supportsStreaming: true,
                                tools: [ServerTool.WEB_SEARCH],
                            },
                        },
                    ],
                },
            ]),
        }
        vi.spyOn(ModelRegistry, "getInstance").mockReturnValue(mockRegistry as any)

        const response = await getAvailableModels({} as any)
        const model = response.providers[0]?.models[0]

        expect(model?.apiFormats).to.deep.equal([ApiFormat.OPENAI_CHAT, ApiFormat.OPENAI_RESPONSES, ApiFormat.ANTHROPIC_CHAT])
        expect(model?.capabilities?.supportsTools).to.equal(true)
        expect(model?.capabilities?.supportsStreaming).to.equal(true)
        expect(model?.capabilities?.tools).to.deep.equal([ServerTool.WEB_SEARCH])
    })

    it("should handle empty model list gracefully", async () => {
        const mockRegistry = {
            isInitialized: true,
            waitForDeferredProviders: vi.fn().mockResolvedValue(undefined),
            getAllModels: vi.fn().mockReturnValue([]),
        }
        vi.spyOn(ModelRegistry, "getInstance").mockReturnValue(mockRegistry as any)

        const controller = {} as any
        const response = await getAvailableModels(controller)

        expect(response.providers).to.deep.equal([])
    })
})
