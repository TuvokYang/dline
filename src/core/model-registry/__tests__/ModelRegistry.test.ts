/**
 * Unit tests for ModelRegistry.
 */

import { resolveOpenRouterReasoning } from "@core/api/providers/openrouter/reasoning"
import { resolveVercelReasoning } from "@core/api/providers/vercel-ai-gateway/reasoning"
import type { Controller } from "@core/controller"
import { getAvailableModels } from "@core/controller/models/getAvailableModels"
import { refreshProviderModels } from "@core/controller/models/refreshProviderModels"
import { mockFetchForTesting } from "@shared/net"
import type { ProviderModelsRequest } from "@shared/proto/dline/models"
import { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"
import { buildEffectiveModelInfo } from "@shared/providers/effective-model-info"
import { expect } from "chai"
import fsPromises from "fs/promises"
import * as path from "path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"
import { ModelRegistry } from "../ModelRegistry"
import { persistProviderCatalog } from "../provider-catalog-storage"
import { discoverProviderModels } from "../remote/model-refresh"

/**
 * Wait for a watcher-driven effect the test cannot await directly.
 *
 * The registry debounces watcher notifications, so a persistence call returns
 * before the reload and callback it triggers. The bound keeps a regression from
 * hanging the suite instead of failing it.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (predicate()) return true
        await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return predicate()
}

describe("ModelRegistry", () => {
    let registry: ModelRegistry
    let sandbox: any /* sinon.SinonSandbox → vitest */
    let tempDir: string

    beforeEach(async () => {
        sandbox = { mockRestore: () => {} }
        // Create a temp directory for providers
        tempDir = path.join(process.env.TEMP || "/tmp", `model-registry-test-${Date.now()}`)
        await fsPromises.mkdir(tempDir, { recursive: true })

        // Reset singleton
        ;(ModelRegistry as any).instance = undefined
        registry = ModelRegistry.getInstance()

        // Stub providersDir getter to use temp directory
        Object.defineProperty(registry, "providersDir", {
            get: () => tempDir,
            configurable: true,
        })
        // Stub startWatch to prevent chokidar watcher from actually starting,
        // avoiding EPERM errors on Windows when cleaning up temp directories.
        Object.defineProperty(registry, "startWatch", {
            value: vi.fn(),
            configurable: true,
        })
    })

    afterEach(async () => {
        // Dispose first to stop any active watcher before restoring stubs
        try {
            await registry.dispose()
        } catch {
            // Ignore dispose errors
        }
        vi.restoreAllMocks()
        try {
            await fsPromises.rm(tempDir, { recursive: true, force: true })
        } catch {
            // Ignore cleanup errors
        }
    })

    describe("version", () => {
        it("should start at 0", () => {
            expect(registry.version).to.equal(0)
        })

        it("should increment after reload", async () => {
            // Write a provider JSON file
            const config = {
                provider: "test-provider",
                providerName: "Test Provider",
                defaultModelId: "model-1",
                models: {
                    "model-1": {
                        id: "model-1",
                        name: "Model 1",
                        capabilities: {
                            maxTokens: 4096,
                            contextWindow: 128000,
                            supportsImages: false,
                            supportsPromptCache: false,
                        },
                    },
                },
            }
            await fsPromises.writeFile(path.join(tempDir, "test-provider.json"), JSON.stringify(config))

            await registry.initialize()
            // After initialize calls reload(), version should be 1
            expect(registry.version).to.equal(1)
        })

        it("should increment on each reload", async () => {
            await registry.initialize()
            const v1 = registry.version

            // Write another file and reload
            const config = {
                provider: "another",
                providerName: "Another",
                models: {
                    m1: {
                        id: "m1",
                        name: "M1",
                        capabilities: {
                            maxTokens: 100,
                            contextWindow: 1000,
                            supportsImages: false,
                            supportsPromptCache: false,
                        },
                    },
                },
            }
            await fsPromises.writeFile(path.join(tempDir, "another.json"), JSON.stringify(config))
            await registry.reload()

            expect(registry.version).to.equal(v1 + 1)
        })
    })

    describe("deferred provider loading", () => {
        it("does not wait for dynamic provider catalogs during initialization", async () => {
            const staticConfig = {
                provider: "anthropic",
                providerName: "Anthropic",
                billingMode: "token",
                models: { static: { id: "static", name: "Static" } },
            }
            const dynamicConfig = {
                provider: "openrouter",
                providerName: "OpenRouter",
                billingMode: "token",
                models: { dynamic: { id: "dynamic", name: "Dynamic" } },
            }
            await fsPromises.writeFile(path.join(tempDir, "anthropic.json"), JSON.stringify(staticConfig))
            await fsPromises.writeFile(path.join(tempDir, "openrouter.json"), JSON.stringify(dynamicConfig))

            let releaseDynamicRead: (() => void) | undefined
            const dynamicReadStarted = new Promise<void>((resolveStarted) => {
                vi.spyOn(fsPromises, "readFile").mockImplementation(async (filePath) => {
                    if (path.basename(filePath.toString()) === "openrouter.json") {
                        resolveStarted()
                        await new Promise<void>((resolve) => {
                            releaseDynamicRead = resolve
                        })
                        return JSON.stringify(dynamicConfig)
                    }
                    return JSON.stringify(staticConfig)
                })
            })

            await registry.initialize()

            expect(registry.getProviderModels("anthropic")?.models).to.have.property("static")
            expect(registry.getProviderModels("openrouter")).to.be.undefined
            await dynamicReadStarted
            releaseDynamicRead?.()
            await registry.waitForDeferredProviders()
            expect(registry.getProviderModels("openrouter")?.models).to.have.property("dynamic")
        })
    })

    describe("leftover alternative catalog files", () => {
        it("ignores a stored file whose id became another provider's catalog", async () => {
            await fsPromises.writeFile(
                path.join(tempDir, "opencode.json"),
                JSON.stringify({
                    provider: "opencode",
                    providerName: "OpenCode",
                    baseUrl: "https://opencode.ai/inference",
                    billingMode: "console",
                    models: { "claude-sonnet-5-5": { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" } },
                }),
            )
            // Written by the build that registered the Go catalog as its own
            // provider. Loading it would offer a second, selectable OpenCode.
            await fsPromises.writeFile(
                path.join(tempDir, "opencode-go.json"),
                JSON.stringify({
                    provider: "opencode-go",
                    providerName: "OpenCode Go (leftover)",
                    baseUrl: "https://leftover.invalid",
                    billingMode: "console",
                    models: { "go-only-model": { id: "go-only-model", name: "Go Only" } },
                }),
            )

            await registry.initialize()
            await registry.waitForDeferredProviders()

            const providerIds = registry.getAllProviders().map((provider) => provider.provider)
            expect(providerIds).to.include("opencode")
            expect(providerIds).to.not.include("opencode-go")

            // The leftover file must not shadow the entry that owns identity,
            // base URL and billing for the Go catalog.
            const resolved = registry.getProviderModels("opencode-go")
            expect(resolved?.provider).to.equal("opencode")
            expect(resolved?.baseUrl).to.equal("https://opencode.ai/inference")
        })

        it("leaves another provider's leftover catalog file on disk", async () => {
            await fsPromises.writeFile(
                path.join(tempDir, "qwen.json"),
                JSON.stringify({ provider: "qwen", providerName: "Alibaba Qwen", models: { m: { id: "m" } } }),
            )
            await fsPromises.writeFile(
                path.join(tempDir, "qwen-cn.json"),
                JSON.stringify({ provider: "qwen-cn", providerName: "Leftover", models: { m: { id: "m" } } }),
            )

            await registry.initialize()

            // The registry ignores this file at load time, but it is not this
            // bugfix's file to delete: it still holds a configuration a person may
            // want to read or restore. Only OpenCode's own leftover is cleaned up.
            const remaining = await fsPromises.readdir(tempDir)
            expect(remaining).to.include("qwen-cn.json")
            expect(remaining).to.include("qwen.json")
        })

        it("ignores leftover mainland catalogs of Qwen and Z AI", async () => {
            await fsPromises.writeFile(
                path.join(tempDir, "qwen.json"),
                JSON.stringify({
                    provider: "qwen",
                    providerName: "Alibaba Qwen",
                    models: { "qwen-intl-model": { id: "qwen-intl-model", name: "Qwen Intl" } },
                }),
            )
            await fsPromises.writeFile(
                path.join(tempDir, "qwen-cn.json"),
                JSON.stringify({
                    provider: "qwen-cn",
                    providerName: "Qwen Mainland (leftover)",
                    models: { "qwen-cn-model": { id: "qwen-cn-model", name: "Qwen CN" } },
                }),
            )
            await fsPromises.writeFile(
                path.join(tempDir, "zai.json"),
                JSON.stringify({
                    provider: "zai",
                    providerName: "Z AI",
                    models: { "zai-intl-model": { id: "zai-intl-model", name: "Z AI Intl" } },
                }),
            )
            await fsPromises.writeFile(
                path.join(tempDir, "zai-cn.json"),
                JSON.stringify({
                    provider: "zai-cn",
                    providerName: "Z AI Mainland (leftover)",
                    models: { "zai-cn-model": { id: "zai-cn-model", name: "Z AI CN" } },
                }),
            )

            await registry.initialize()

            const providerIds = registry.getAllProviders().map((provider) => provider.provider)
            expect(providerIds).to.include("qwen")
            expect(providerIds).to.include("zai")
            expect(providerIds).to.not.include("qwen-cn")
            expect(providerIds).to.not.include("zai-cn")
        })
    })

    describe("getAllModels", () => {
        it("projects an alternative catalog through the models RPC without creating a selectable provider", async () => {
            await fsPromises.writeFile(
                path.join(tempDir, "opencode.json"),
                JSON.stringify({
                    provider: "opencode",
                    providerName: "OpenCode",
                    billingMode: "console",
                    models: { "console-only": { id: "console-only" } },
                }),
            )
            await registry.initialize()
            await registry.waitForDeferredProviders()

            const response = await getAvailableModels({} as never)
            expect(registry.getAllProviders().map((provider) => provider.provider)).to.deep.equal(["opencode"])
            expect(response.providers.map((group) => group.provider)).to.deep.equal(["opencode-console", "opencode-go"])
            expect(response.providers[0].models.map((model) => model.id)).to.deep.equal(["console-only"])
            // The Go catalog declares no model of its own; it is populated by
            // discovery, so an empty stored catalog reads back empty.
            expect(response.providers[1].models).to.deep.equal([])
        })

        it("loads vercel.json under the Vercel provider ID and ignores the legacy duplicate", async () => {
            const legacyConfig = {
                provider: "vercel-ai-gateway",
                providerName: "Vercel AI Gateway",
                billingMode: "token",
                models: {},
            }
            const canonicalConfig = {
                ...legacyConfig,
                models: {
                    "anthropic/claude-sonnet": {
                        id: "anthropic/claude-sonnet",
                        name: "Claude Sonnet",
                    },
                },
            }
            await fsPromises.writeFile(path.join(tempDir, "vercel-ai-gateway.json"), JSON.stringify(legacyConfig))
            await fsPromises.writeFile(path.join(tempDir, "vercel.json"), JSON.stringify(canonicalConfig))

            await registry.initialize()
            await registry.waitForDeferredProviders()

            expect(registry.getProviderModels("vercel-ai-gateway")?.models).to.have.property("anthropic/claude-sonnet")
            expect(registry.getAllProviders().filter((provider) => provider.provider === "vercel-ai-gateway")).to.have.lengthOf(1)
        })

        it("should return defaultModelId from provider config", async () => {
            const config = {
                provider: "doubao",
                providerName: "Doubao",
                defaultModelId: "doubao-pro-256k",
                models: {
                    "doubao-pro-256k": {
                        id: "doubao-pro-256k",
                        name: "Doubao Pro 256K",
                        capabilities: {
                            maxTokens: 12288,
                            contextWindow: 256000,
                            supportsImages: false,
                            supportsPromptCache: false,
                        },
                    },
                    "doubao-lite-32k": {
                        id: "doubao-lite-32k",
                        name: "Doubao Lite 32K",
                        capabilities: {
                            maxTokens: 4096,
                            contextWindow: 32000,
                            supportsImages: false,
                            supportsPromptCache: false,
                        },
                    },
                },
            }
            await fsPromises.writeFile(path.join(tempDir, "doubao.json"), JSON.stringify(config))
            await registry.initialize()

            const allModels = registry.getAllModels()
            expect(allModels).to.have.lengthOf(1)
            expect(allModels[0].provider).to.equal("doubao")
            expect(allModels[0].defaultModelId).to.equal("doubao-pro-256k")
            expect(allModels[0].models).to.have.lengthOf(2)
        })

        it("returns image models and their default separately from chat models", async () => {
            const config = {
                provider: "image-provider",
                providerName: "Image Provider",
                billingMode: "token",
                defaultModelId: "chat-model",
                models: {
                    "chat-model": { id: "chat-model", name: "Chat Model" },
                },
                defaultImageModelId: "image-model",
                imageModels: {
                    "image-model": { id: "image-model", name: "Image Model" },
                },
            }
            await fsPromises.writeFile(path.join(tempDir, "image-provider.json"), JSON.stringify(config))
            await registry.initialize()

            const group = registry.getAllModels()[0] as unknown as {
                defaultImageModelId?: string
                imageModels?: Array<{ id: string }>
                models: Array<{ id: string }>
            }
            expect(group.models.map((model) => model.id)).to.deep.equal(["chat-model"])
            expect(group.defaultImageModelId).to.equal("image-model")
            expect(group.imageModels?.map((model) => model.id)).to.deep.equal(["image-model"])
        })

        it("should have undefined defaultModelId when not set", async () => {
            const config = {
                provider: "simple",
                providerName: "Simple",
                models: {
                    m1: {
                        id: "m1",
                        name: "M1",
                        capabilities: {
                            maxTokens: 100,
                            contextWindow: 1000,
                            supportsImages: false,
                            supportsPromptCache: false,
                        },
                    },
                },
            }
            await fsPromises.writeFile(path.join(tempDir, "simple.json"), JSON.stringify(config))
            await registry.initialize()

            const allModels = registry.getAllModels()
            expect(allModels[0].defaultModelId).to.be.undefined
        })
    })

    describe("getProviderModels", () => {
        it("marks every OpenAI conversation model as capable of the image generation server tool", async () => {
            await fsPromises.writeFile(
                path.join(tempDir, "openai.json"),
                JSON.stringify({
                    provider: "openai",
                    providerName: "OpenAI",
                    billingMode: "token",
                    models: {
                        "custom-responses-model": {
                            id: "custom-responses-model",
                            userDefined: true,
                            apiFormats: [ApiFormat.OPENAI_RESPONSES],
                            capabilities: { supportsTools: true, tools: [ServerTool.WEB_SEARCH] },
                        },
                    },
                }),
            )

            await registry.initialize()

            const model = registry.getProviderModels("openai")?.models["custom-responses-model"]
            expect(model?.capabilities?.tools).to.deep.equal([ServerTool.WEB_SEARCH, ServerTool.IMAGE_GENERATION])
        })

        it("fills only missing native-tool capability from built-in seed metadata in memory", async () => {
            const filePath = path.join(tempDir, "anthropic.json")
            const config = {
                provider: "anthropic",
                providerName: "Anthropic",
                defaultModelId: "claude-sonnet-4-6",
                models: {
                    "claude-sonnet-4-6": {
                        id: "claude-sonnet-4-6",
                        capabilities: { contextWindow: 200_000 },
                    },
                    "claude-opus-4-6": {
                        id: "claude-opus-4-6",
                        capabilities: { contextWindow: 200_000, supportsTools: false },
                    },
                    "private-model": {
                        id: "private-model",
                        capabilities: { contextWindow: 64_000 },
                    },
                },
            }
            await fsPromises.writeFile(filePath, JSON.stringify(config))

            await registry.initialize()

            const result = registry.getProviderModels("anthropic")
            expect(result?.models["claude-sonnet-4-6"].capabilities?.supportsTools).to.equal(true)
            expect(result?.models["claude-opus-4-6"].capabilities?.supportsTools).to.equal(false)
            expect(result?.models["private-model"].capabilities?.supportsTools).to.equal(undefined)

            const persisted = JSON.parse(await fsPromises.readFile(filePath, "utf8"))
            expect(persisted.models["claude-sonnet-4-6"].capabilities).not.to.have.property("supportsTools")
        })

        it("fills missing API formats from built-in metadata in memory", async () => {
            const filePath = path.join(tempDir, "deepseek.json")
            await fsPromises.writeFile(
                filePath,
                JSON.stringify({
                    provider: "deepseek",
                    providerName: "DeepSeek",
                    defaultModelId: "deepseek-v4-pro",
                    models: {
                        "deepseek-v4-pro": {
                            id: "deepseek-v4-pro",
                            capabilities: { contextWindow: 1_000_000 },
                        },
                    },
                }),
            )

            await registry.initialize()

            expect(registry.getProviderModels("deepseek")?.models["deepseek-v4-pro"].apiFormats).to.deep.equal([
                ApiFormat.OPENAI_CHAT,
                ApiFormat.OPENAI_RESPONSES,
                ApiFormat.ANTHROPIC_CHAT,
            ])
            const persisted = JSON.parse(await fsPromises.readFile(filePath, "utf8"))
            expect(persisted.models["deepseek-v4-pro"]).not.to.have.property("apiFormats")
        })

        it("normalizes protobuf server-tool names at the provider JSON boundary", async () => {
            await fsPromises.writeFile(
                path.join(tempDir, "custom.json"),
                JSON.stringify({
                    provider: "custom",
                    providerName: "Custom",
                    billingMode: "token",
                    models: {
                        "search-model": {
                            id: "search-model",
                            capabilities: { tools: ["WEB_SEARCH", "UNKNOWN_SERVER_TOOL"] },
                        },
                    },
                }),
            )

            await registry.initialize()

            expect(registry.getProviderModels("custom")?.models["search-model"].capabilities?.tools).to.deep.equal([
                ServerTool.WEB_SEARCH,
            ])
        })

        it("does not merge built-in metadata into a user-defined model", async () => {
            await fsPromises.writeFile(
                path.join(tempDir, "deepseek.json"),
                JSON.stringify({
                    provider: "deepseek",
                    providerName: "DeepSeek",
                    models: {
                        "deepseek-v4-pro": {
                            id: "deepseek-v4-pro",
                            userDefined: true,
                            capabilities: { supportsTools: false },
                        },
                    },
                }),
            )

            await registry.initialize()

            const model = registry.getProviderModels("deepseek")?.models["deepseek-v4-pro"]
            expect(model?.userDefined).to.equal(true)
            expect(model?.capabilities?.supportsTools).to.equal(false)
            expect(model?.apiFormats).to.equal(undefined)
        })

        it("should return config for existing provider", async () => {
            const config = {
                provider: "anthropic",
                providerName: "Anthropic",
                defaultModelId: "claude-sonnet-4-6",
                models: {
                    "claude-sonnet-4-6": {
                        id: "claude-sonnet-4-6",
                        name: "Claude Sonnet 4.6",
                        capabilities: {
                            maxTokens: 8192,
                            contextWindow: 200000,
                            supportsImages: true,
                            supportsPromptCache: true,
                        },
                    },
                },
            }
            await fsPromises.writeFile(path.join(tempDir, "anthropic.json"), JSON.stringify(config))
            await registry.initialize()

            const result = registry.getProviderModels("anthropic")
            expect(result).to.not.be.undefined
            expect(result?.provider).to.equal("anthropic")
            expect(result?.defaultModelId).to.equal("claude-sonnet-4-6")
            expect(Object.keys(result?.models ?? {})).to.have.lengthOf(1)
        })

        it("should return undefined for unknown provider", async () => {
            await registry.initialize()
            const result = registry.getProviderModels("nonexistent")
            expect(result).to.be.undefined
        })
    })

    describe("gateway catalog reasoning authority", () => {
        for (const provider of ["openrouter", "vercel-ai-gateway"] as const) {
            it(`keeps coarse ${provider} listing support separate from thinking after refresh and restart`, async () => {
                const entries = [
                    { id: "openai/o3-opaque", supported_parameters: ["reasoning", "tools"], tags: ["reasoning"] },
                    { id: "google/gemini-3-opaque", supported_parameters: [], tags: [] },
                    { id: "anthropic/claude-opaque" },
                ]
                const stale = Object.fromEntries(
                    entries.map(({ id }) => [
                        id,
                        {
                            id,
                            capabilities: { thinking: { supported: true, mode: "budget", maxBudget: 8192 } },
                        },
                    ]),
                )
                await fsPromises.writeFile(
                    path.join(tempDir, `${provider}.json`),
                    JSON.stringify({
                        provider,
                        providerName: provider,
                        models: stale,
                    }),
                )
                await registry.initialize()
                const requests: string[] = []
                const discovered = await mockFetchForTesting(
                    async (input) => {
                        const url = new URL(String(input))
                        requests.push(url.toString())
                        if (!url.pathname.endsWith("/models")) throw new Error("Unexpected listing request")
                        return new Response(JSON.stringify({ data: entries }), {
                            headers: { "content-type": "application/json" },
                        })
                    },
                    () => discoverProviderModels(provider, {}, { persist: true, throwOnError: true }),
                )
                expect(requests).to.have.lengthOf(1)
                expect(discovered[entries[0].id].capabilities).to.include({ supportsReasoning: true })
                expect(discovered[entries[1].id].capabilities).to.include({ supportsReasoning: false })
                expect(discovered[entries[2].id].capabilities?.supportsReasoning).to.equal(undefined)
                await registry.dispose()
                await registry.initialize()
                await registry.waitForDeferredProviders()
                const restored = registry.getProviderModels(provider)
                expect(restored).to.exist
                const encode = provider === "openrouter" ? resolveOpenRouterReasoning : resolveVercelReasoning
                for (const { id } of entries) {
                    const model = restored?.models[id]
                    expect(model, id).to.exist
                    expect(model?.capabilities?.thinking, id).to.equal(undefined)
                    expect(
                        encode(id, model?.capabilities, { enableThinking: true, thinkingBudget: 4096, effort: "high" }).reasoning,
                        id,
                    ).to.equal(undefined)
                }
                const effective = buildEffectiveModelInfo(entries[0].id, restored?.models[entries[0].id], {
                    capabilities: { thinking: { supported: true, mode: "effort", effortLevels: ["high"] } },
                })
                expect(encode(entries[0].id, effective.capabilities, { effort: "high" }).reasoning).to.deep.equal({
                    effort: "high",
                })
            })
        }
    })

    describe("getAllProviders", () => {
        it("should return all provider configs", async () => {
            const configA = {
                provider: "openai",
                providerName: "OpenAI",
                models: {
                    "gpt-5": {
                        id: "gpt-5",
                        name: "GPT-5",
                        capabilities: {
                            maxTokens: 4096,
                            contextWindow: 128000,
                            supportsImages: false,
                            supportsPromptCache: false,
                        },
                    },
                },
            }
            const configB = {
                provider: "gemini",
                providerName: "Gemini",
                models: {
                    "gemini-2.5-pro": {
                        id: "gemini-2.5-pro",
                        name: "Gemini 2.5 Pro",
                        capabilities: {
                            maxTokens: 65536,
                            contextWindow: 1048576,
                            supportsImages: true,
                            supportsPromptCache: false,
                        },
                    },
                },
            }
            await fsPromises.writeFile(path.join(tempDir, "openai.json"), JSON.stringify(configA))
            await fsPromises.writeFile(path.join(tempDir, "gemini.json"), JSON.stringify(configB))
            await registry.initialize()

            const all = registry.getAllProviders()
            expect(all).to.have.lengthOf(2)
            const providers = all.map((p) => p.provider).sort()
            expect(providers).to.deep.equal(["gemini", "openai"])
        })

        it("should return empty array when no providers", async () => {
            await registry.initialize()
            expect(registry.getAllProviders()).to.deep.equal([])
        })
    })

    describe("hasProvider", () => {
        it("should return true for existing provider with models", async () => {
            const config = {
                provider: "doubao",
                providerName: "Doubao",
                models: {
                    m1: {
                        id: "m1",
                        name: "M1",
                        capabilities: {
                            maxTokens: 100,
                            contextWindow: 1000,
                            supportsImages: false,
                            supportsPromptCache: false,
                        },
                    },
                },
            }
            await fsPromises.writeFile(path.join(tempDir, "doubao.json"), JSON.stringify(config))
            await registry.initialize()

            expect(registry.hasProvider("doubao")).to.be.true
        })

        it("should return false for non-existing provider", () => {
            expect(registry.hasProvider("nonexistent")).to.be.false
        })

        it("should return false when provider has empty models", async () => {
            // Write a provider config with empty models object
            const config = {
                provider: "empty",
                providerName: "Empty Provider",
                models: {},
            }
            await fsPromises.writeFile(path.join(tempDir, "empty.json"), JSON.stringify(config))
            await registry.initialize()

            expect(registry.hasProvider("empty")).to.be.false
        })
    })

    describe("publish after a persisted listing", () => {
        it("publishes a persisted catalog the settings page did not refresh itself", async () => {
            await fsPromises.writeFile(
                path.join(tempDir, "baseten.json"),
                JSON.stringify({
                    provider: "baseten",
                    providerName: "Baseten",
                    billingMode: "token",
                    models: { "old-model": { id: "old-model" } },
                }),
            )
            await registry.initialize()

            // Baseten persists from its RPC and returns, without posting state.
            // The watcher notification is the only thing that publishes the new
            // catalog, so treating a file this process wrote as "already
            // published" would leave every consumer on the pre-refresh list until
            // an unrelated update arrived.
            //
            // The startup deferred load publishes on its own; wait it out first so
            // the count below can only come from the notification this case sends.
            await registry.waitForDeferredProviders()
            const published: string[][] = []
            registry.onChange(() => published.push(Object.keys(registry.getProviderModels("baseten")?.models ?? {})))
            await persistProviderCatalog({
                providerId: "baseten",
                providerName: "Baseten",
                billingMode: "token",
                models: { "new-model": { id: "new-model", name: "New Model" } },
            })
            expect(registry.getProviderModels("baseten")?.models).to.have.property("new-model")
            // The writer refreshes the cache silently; publishing belongs to the
            // watcher notification, so nothing may have been announced yet.
            expect(published).to.have.lengthOf(0)

            // The watcher is stubbed out in this suite, so deliver the notification
            // it would have produced for the file the writer just changed.
            ;(registry as unknown as { noteChangedFile: (fileName: string) => void }).noteChangedFile("baseten.json")
            // The reload is debounced, so the callback follows asynchronously.
            const notified = await waitFor(() => published.length > 0)
            expect(notified).to.be.true
            // Consumers re-read the catalog on publication, so the callback must
            // observe the model that was just written, not the pre-write list.
            expect(published[0]).to.deep.equal(["new-model"])
        })

        it("keeps a committed primary catalog the cache has not seen yet", async () => {
            await fsPromises.writeFile(
                path.join(tempDir, "opencode.json"),
                JSON.stringify({
                    provider: "opencode",
                    providerName: "OpenCode",
                    billingMode: "console",
                    models: { old: { id: "old" } },
                }),
            )
            await registry.initialize()
            await registry.waitForDeferredProviders()

            // Another window commits a newer primary catalog. This window's
            // watcher has not reloaded it yet, which is the normal state for the
            // duration of its debounce.
            await fsPromises.writeFile(
                path.join(tempDir, "opencode.json"),
                JSON.stringify({
                    provider: "opencode",
                    providerName: "OpenCode",
                    billingMode: "console",
                    models: { committed: { id: "committed" } },
                }),
            )

            // A Go refresh must compose with what is on disk. Building from the
            // cached entry instead replaces the whole owner entry and writes the
            // older primary list back, losing the other window's work.
            await persistProviderCatalog({
                providerId: "opencode-go",
                providerName: "OpenCode",
                billingMode: "console",
                models: { "new-go": { id: "new-go", name: "New Go" } },
            })

            const written = JSON.parse(await fsPromises.readFile(path.join(tempDir, "opencode.json"), "utf8"))
            expect(written.models).to.have.property("committed")
            expect(written.models).to.not.have.property("old")
            expect(written.catalogs?.["opencode-go"]?.models).to.have.property("new-go")
        })

        it("does not let an older watcher reload roll back a completed write", async () => {
            await fsPromises.writeFile(
                path.join(tempDir, "opencode.json"),
                JSON.stringify({
                    provider: "opencode",
                    providerName: "OpenCode",
                    billingMode: "console",
                    models: { old: { id: "old" } },
                }),
            )
            await registry.initialize()
            await registry.waitForDeferredProviders()

            // A watcher pass can already be under way when a write lands. Hold the
            // content the first pass read so the second pass can be started while
            // the first has not finished applying its snapshot.
            const readFile = fsPromises.readFile.bind(fsPromises)
            let releaseOlderPass: (() => void) | undefined
            const olderPassRead = new Promise<void>((resolve) => {
                releaseOlderPass = resolve
            })
            let reads = 0
            const readFileSpy = vi.spyOn(fsPromises, "readFile").mockImplementation((async (
                ...args: Parameters<typeof fsPromises.readFile>
            ) => {
                reads++
                const contents = await (readFile as (...rest: unknown[]) => Promise<unknown>)(...args)
                if (reads === 1) await olderPassRead
                return contents
            }) as unknown as typeof fsPromises.readFile)
            try {
                const olderPass = registry.reload()
                expect(await waitFor(() => reads === 1)).to.be.true
                await fsPromises.writeFile(
                    path.join(tempDir, "opencode.json"),
                    JSON.stringify({
                        provider: "opencode",
                        providerName: "OpenCode",
                        billingMode: "console",
                        models: { fresh: { id: "fresh" } },
                    }),
                )
                const newerPass = registry.reload()
                // Passes read the directory and then publish what they read, so an
                // unordered second pass would already be reading here and could
                // land its older snapshot after the newer one.
                await new Promise((resolve) => setTimeout(resolve, 50))
                expect(reads).to.equal(1)
                releaseOlderPass?.()
                await Promise.all([olderPass, newerPass])
            } finally {
                readFileSpy.mockRestore()
            }

            // The older pass read `old`, so applying it after the newer pass would
            // resurrect a model that no longer exists on disk.
            expect(registry.getProviderModels("opencode")?.models).to.have.property("fresh")
            expect(registry.getProviderModels("opencode")?.models).to.not.have.property("old")
        })

        it.each(["opencode-console", "opencode-go"])("posts the state after persisting %s", async (providerId) => {
            const postStateToWebview = vi.fn(async () => undefined)
            await mockFetchForTesting(
                (async () =>
                    new Response(
                        JSON.stringify({
                            data: [
                                {
                                    id: "deepseek-v4.1-flash",
                                    name: "DeepSeek V4.1 Flash",
                                    limit: { context: 1_000_000, output: 384_000 },
                                    capabilities: { cache: { implicit: true } },
                                    api: { "chat-completions": { base_url: "https://opencode.ai/inference/openai/v1" } },
                                },
                            ],
                        }),
                        { status: 200 },
                    )) as typeof fetch,
                () =>
                    refreshProviderModels(
                        { postStateToWebview } as unknown as Controller,
                        {
                            providerId,
                        } as ProviderModelsRequest,
                    ),
            )

            // The registry applies its own write silently, so without this post the
            // open settings page keeps showing pre-refresh limits and cache flags.
            expect((postStateToWebview as unknown as { mock: { calls: unknown[] } }).mock.calls).to.have.lengthOf(1)
            expect(registry.getProviderCatalog(providerId)?.models["deepseek-v4.1-flash"]?.capabilities).to.include({
                contextWindow: 1_000_000,
                supportsPromptCache: true,
            })
        })
    })

    describe("alternative catalog metadata", () => {
        /**
         * The Go catalog is a constant projection, so a vendor listing that only
         * previews leaves its limits and cache flag unreachable. These cases pin
         * what a stored catalog contributes, and what the plan keeps owning.
         */
        it("keeps a model only the listing knows instead of dropping it", async () => {
            await fsPromises.writeFile(
                path.join(tempDir, "opencode.json"),
                JSON.stringify({
                    provider: "opencode",
                    providerName: "OpenCode",
                    billingMode: "console",
                    models: { "console-only": { id: "console-only" } },
                    catalogs: {
                        "opencode-go": {
                            models: {
                                "released-after-build": {
                                    id: "released-after-build",
                                    name: "Released After Build",
                                    apiFormats: [ApiFormat.OPENAI_RESPONSES, ApiFormat.OPENAI_CHAT],
                                    capabilities: { contextWindow: 200_000, supportsPromptCache: true },
                                },
                            },
                        },
                    },
                }),
            )
            await registry.initialize()

            // The seed cannot enumerate a model released after this build, so the
            // stored listing is the only place that knows it exists. Dropping it
            // would put the settings page back to "no such model".
            const model = registry.getProviderCatalog("opencode-go")?.models["released-after-build"]
            expect(model).to.exist
            expect(model?.capabilities?.contextWindow).to.equal(200_000)
            expect(model?.apiFormats).to.deep.equal([ApiFormat.OPENAI_RESPONSES, ApiFormat.OPENAI_CHAT])
        })

        it("does not let a seed default survive beside a published effort list", async () => {
            await fsPromises.writeFile(
                path.join(tempDir, "opencode.json"),
                JSON.stringify({
                    provider: "opencode",
                    providerName: "OpenCode",
                    billingMode: "console",
                    models: { "console-only": { id: "console-only" } },
                    catalogs: {
                        "opencode-go": {
                            models: {
                                "deepseek-v4.1-flash": {
                                    id: "deepseek-v4.1-flash",
                                    capabilities: {
                                        thinking: { supported: true, mode: "effort", effortLevels: ["low", "high", "max"] },
                                    },
                                },
                            },
                        },
                    },
                }),
            )
            await registry.initialize()

            // The listing never published a default level or a disable rule. A seed
            // `defaultEffort` surviving here would show a level nobody chose and a
            // `canDisable: false` would lock a toggle the gateway allows.
            const thinking = registry.getProviderCatalog("opencode-go")?.models["deepseek-v4.1-flash"]?.capabilities?.thinking
            expect(thinking).to.deep.equal({ supported: true, mode: "effort", effortLevels: ["low", "high", "max"] })
        })

        it("keeps a published effort list authoritative for the primary catalog too", async () => {
            await fsPromises.writeFile(
                path.join(tempDir, "opencode.json"),
                JSON.stringify({
                    provider: "opencode",
                    providerName: "OpenCode",
                    billingMode: "console",
                    models: {
                        // A model the Console seed also describes, so a seed default
                        // and disable rule exist and could reappear.
                        "claude-sonnet-5-5": {
                            id: "claude-sonnet-5-5",
                            capabilities: { thinking: { supported: true, mode: "effort", effortLevels: ["low", "high"] } },
                        },
                    },
                }),
            )
            await registry.initialize()

            // The listing publishes levels but no default and no disable rule. A
            // seed value reappearing here would show a level nobody picked and
            // lock a toggle the gateway allows.
            const thinking = registry.getProviderCatalog("opencode")?.models["claude-sonnet-5-5"]?.capabilities?.thinking
            expect(thinking).to.deep.equal({ supported: true, mode: "effort", effortLevels: ["low", "high"] })
        })

        it("keeps a flag-only declaration from inheriting a seed level and switch", async () => {
            await fsPromises.writeFile(
                path.join(tempDir, "opencode.json"),
                JSON.stringify({
                    provider: "opencode",
                    providerName: "OpenCode",
                    billingMode: "console",
                    models: {
                        "claude-sonnet-5-5": {
                            id: "claude-sonnet-5-5",
                            capabilities: { thinking: { supported: true } },
                        },
                    },
                    catalogs: {
                        "opencode-go": {
                            models: {
                                "deepseek-v4.1-flash": {
                                    id: "deepseek-v4.1-flash",
                                    capabilities: { thinking: { supported: true } },
                                },
                            },
                        },
                    },
                }),
            )
            await registry.initialize()

            // A support flag is the whole statement the listing makes. The Go seed
            // for this model declares a level, a default and a forced-on switch, so
            // inheriting any of them would offer and send a level nobody published.
            const primary = registry.getProviderCatalog("opencode")?.models["claude-sonnet-5-5"]?.capabilities?.thinking
            const go = registry.getProviderCatalog("opencode-go")?.models["deepseek-v4.1-flash"]?.capabilities?.thinking
            expect(primary).to.deep.equal({ supported: true })
            expect(go).to.deep.equal({ supported: true })
        })

        it("preserves declared pricing independently of a subscription catalog", async () => {
            await fsPromises.writeFile(
                path.join(tempDir, "opencode.json"),
                JSON.stringify({
                    provider: "opencode",
                    providerName: "OpenCode",
                    billingMode: "console",
                    models: { "console-only": { id: "console-only" } },
                    catalogs: {
                        "opencode-go": {
                            models: {
                                "released-after-build": {
                                    id: "released-after-build",
                                    capabilities: { contextWindow: 200_000 },
                                    pricing: {
                                        metered: {
                                            currency: "USD",
                                            strategy: { flat: { prices: { inputPrice: 3, outputPrice: 15 } } },
                                        },
                                    },
                                },
                            },
                        },
                    },
                }),
            )
            await registry.initialize()

            // Account identity does not erase a model's published price declaration.
            const model = registry.getProviderCatalog("opencode-go")?.models["released-after-build"]
            expect(model?.capabilities?.contextWindow).to.equal(200_000)
            expect(model?.pricing?.strategy?.flat?.prices?.inputPrice).to.equal(3)
            expect(model?.pricing?.strategy?.flat?.prices?.outputPrice).to.equal(15)
            expect(model?.pricing?.metered).to.equal(undefined)
        })

        it("leaves a user-defined model with exactly what the user declared", async () => {
            await fsPromises.writeFile(
                path.join(tempDir, "opencode.json"),
                JSON.stringify({
                    provider: "opencode",
                    providerName: "OpenCode",
                    billingMode: "console",
                    models: {
                        "claude-sonnet-5-5": {
                            id: "claude-sonnet-5-5",
                            userDefined: true,
                            capabilities: { supportsTools: false },
                        },
                    },
                }),
            )
            await registry.initialize()

            // A model a person added is not described by the listing, so the seed
            // must not re-supply limits, tools or reasoning for it.
            const capabilities = registry.getProviderCatalog("opencode")?.models["claude-sonnet-5-5"]?.capabilities
            expect(capabilities).to.deep.equal({ supportsTools: false })
        })

        it("keeps a listing-only model's price in a catalog the plan does not bill", async () => {
            await fsPromises.writeFile(
                path.join(tempDir, "qwen.json"),
                JSON.stringify({
                    provider: "qwen",
                    providerName: "Alibaba Qwen",
                    billingMode: "token",
                    models: { "qwen3-235b-a22b": { id: "qwen3-235b-a22b" } },
                    catalogs: {
                        "qwen-cn": {
                            models: {
                                "qwen-listing-only": {
                                    id: "qwen-listing-only",
                                    capabilities: { contextWindow: 262_144 },
                                    pricing: {
                                        metered: {
                                            currency: "USD",
                                            strategy: { flat: { prices: { inputPrice: 0.4, outputPrice: 1.2 } } },
                                        },
                                    },
                                },
                            },
                        },
                    },
                }),
            )
            await registry.initialize()

            // Read migration preserves the published rates without retaining the old envelope.
            const model = registry.getProviderCatalog("qwen-cn")?.models["qwen-listing-only"]
            expect(model?.capabilities?.contextWindow).to.equal(262_144)
            expect(model?.pricing?.strategy?.flat?.prices?.inputPrice).to.equal(0.4)
        })

        it("does not put a seed model back into a catalog the listing replaced", async () => {
            await fsPromises.writeFile(
                path.join(tempDir, "opencode.json"),
                JSON.stringify({
                    provider: "opencode",
                    providerName: "OpenCode",
                    billingMode: "console",
                    models: { "console-only": { id: "console-only" } },
                    catalogs: {
                        "opencode-go": {
                            defaultModelId: "released-after-build",
                            models: { "released-after-build": { id: "released-after-build" } },
                        },
                    },
                }),
            )
            await registry.initialize()

            // The plan may have dropped a model since this build. Re-adding it from
            // the seed would offer a model the plan no longer serves, and keeping the
            // seed default would select a model that is not in the catalog at all.
            const catalog = registry.getProviderCatalog("opencode-go")
            expect(catalog?.models).to.not.have.property("deepseek-v4-pro")
            expect(catalog?.defaultModelId).to.equal("released-after-build")
        })

        it("leaves a user-defined model in an alternative catalog alone", async () => {
            await fsPromises.writeFile(
                path.join(tempDir, "opencode.json"),
                JSON.stringify({
                    provider: "opencode",
                    providerName: "OpenCode",
                    billingMode: "console",
                    models: { "console-only": { id: "console-only" } },
                    catalogs: {
                        "opencode-go": {
                            models: {
                                "deepseek-v4-pro": {
                                    id: "deepseek-v4-pro",
                                    userDefined: true,
                                    capabilities: { supportsTools: false },
                                },
                            },
                        },
                    },
                }),
            )
            await registry.initialize()

            // The seed describes the model the plan publishes, not the entry a person
            // wrote under the same id, so the stored declaration must stand as written.
            const capabilities = registry.getProviderCatalog("opencode-go")?.models["deepseek-v4-pro"]?.capabilities
            expect(capabilities).to.deep.equal({ supportsTools: false })
        })

        it("composes concurrent primary and alternative writes instead of overwriting one", async () => {
            await fsPromises.writeFile(
                path.join(tempDir, "opencode.json"),
                JSON.stringify({
                    provider: "opencode",
                    providerName: "OpenCode",
                    billingMode: "console",
                    models: { "console-only": { id: "console-only" } },
                }),
            )
            await registry.initialize()

            // Both catalogs live in one file, so a primary refresh landing while a
            // Go refresh is mid-write must not roll the other region back.
            await mockFetchForTesting(
                (async () =>
                    new Response(
                        JSON.stringify({
                            data: [
                                {
                                    id: "deepseek-v4.1-flash",
                                    name: "DeepSeek V4.1 Flash",
                                    limit: { context: 1_000_000, output: 384_000 },
                                    capabilities: { cache: { implicit: true } },
                                    api: { "chat-completions": { base_url: "https://opencode.ai/inference/openai/v1" } },
                                },
                            ],
                        }),
                        { status: 200 },
                    )) as typeof fetch,
                () =>
                    Promise.all([
                        discoverProviderModels("opencode", {}, { persist: true, throwOnError: true }),
                        discoverProviderModels("opencode-go", {}, { persist: true, throwOnError: true }),
                    ]),
            )

            // A lost update shows up as one region still carrying the pre-write
            // document: the primary catalog would keep its old models, or the Go
            // region would be missing entirely.
            const written = JSON.parse(await fsPromises.readFile(path.join(tempDir, "opencode.json"), "utf8"))
            expect(written.models).to.have.property("deepseek-v4.1-flash")
            expect(written.catalogs?.["opencode-go"]?.models).to.have.property("deepseek-v4.1-flash")
        })

        it("refreshes the canonical Console catalog from its disk owner and keeps Go across a restart", async () => {
            const ownerPath = path.join(tempDir, "opencode.json")
            const original = {
                provider: "opencode",
                providerName: "OpenCode",
                billingMode: "console",
                models: { "saved-custom": { id: "saved-custom", userDefined: true } },
                catalogs: { "opencode-go": { models: { "go-kept": { id: "go-kept" } } } },
            }
            await fsPromises.writeFile(ownerPath, JSON.stringify(original))
            await registry.initialize()
            await registry.waitForDeferredProviders()
            // A write reads the current owner document, including edits not yet
            // published by the watcher, rather than a stale registry baseline.
            await fsPromises.writeFile(
                ownerPath,
                JSON.stringify({
                    ...original,
                    defaultModelId: "disk-custom",
                    models: { ...original.models, "disk-custom": { id: "disk-custom", userDefined: true } },
                }),
            )
            const requestedUrls: string[] = []
            await mockFetchForTesting(
                (async (input) => {
                    requestedUrls.push(String(input))
                    return new Response(
                        JSON.stringify({
                            data: [
                                {
                                    id: "listed-console",
                                    limit: { input: 32768, output: 4096 },
                                    api: { "chat-completions": { base_url: "https://opencode.ai/inference/openai/v1" } },
                                },
                            ],
                        }),
                        { status: 200 },
                    )
                }) as typeof fetch,
                async () => {
                    const models = await discoverProviderModels("opencode-console", {}, { persist: true, throwOnError: true })
                    expect(Object.keys(models)).to.deep.equal(["listed-console"])
                },
            )
            expect(requestedUrls).to.deep.equal(["https://opencode.ai/inference/v1/models"])
            const written = JSON.parse(await fsPromises.readFile(ownerPath, "utf8"))
            expect(written.provider).to.equal("opencode")
            expect(written.models).to.have.keys("saved-custom", "disk-custom", "listed-console")
            expect(written.defaultModelId).to.equal("disk-custom")
            expect(written.catalogs["opencode-go"].models).to.have.property("go-kept")
            expect(written.catalogs).not.to.have.property("opencode-console")
            expect(await fsPromises.readdir(tempDir)).to.deep.equal(["opencode.json"])

            await registry.dispose()
            Reflect.set(ModelRegistry, "instance", undefined)
            registry = ModelRegistry.getInstance()
            Object.defineProperty(registry, "providersDir", { get: () => tempDir, configurable: true })
            Object.defineProperty(registry, "startWatch", { value: vi.fn(), configurable: true })
            await registry.initialize()
            await registry.waitForDeferredProviders()
            const response = await getAvailableModels({} as Controller)
            const consoleModels = response.providers.find((group) => group.provider === "opencode-console")
            expect(consoleModels?.defaultModelId).to.equal("disk-custom")
            expect(consoleModels?.models.find((model) => model.id === "listed-console")?.capabilities?.contextWindow).to.equal(
                32768,
            )
            expect(
                response.providers.find((group) => group.provider === "opencode-go")?.models.map((model) => model.id),
            ).to.include("go-kept")
        })

        it("writes a Go listing into its own catalog and keeps it across a restart", async () => {
            await fsPromises.writeFile(
                path.join(tempDir, "opencode.json"),
                JSON.stringify({
                    provider: "opencode",
                    providerName: "OpenCode",
                    billingMode: "console",
                    models: { "console-only": { id: "console-only", name: "Console Only" } },
                }),
            )
            await registry.initialize()

            const listing = {
                data: [
                    {
                        id: "deepseek-v4.1-flash",
                        name: "DeepSeek V4.1 Flash",
                        limit: { context: 1_000_000, output: 384_000 },
                        modalities: { input: ["text", "image/png", "application/pdf"], output: ["text"] },
                        capabilities: {
                            tools: { supported: true },
                            reasoning: { supported: true, effort: ["low", "high", "max"] },
                            cache: { implicit: true },
                        },
                        api: { "chat-completions": { base_url: "https://opencode.ai/inference/go/openai/v1" } },
                    },
                ],
            }
            await mockFetchForTesting((async () => new Response(JSON.stringify(listing), { status: 200 })) as typeof fetch, () =>
                discoverProviderModels("opencode-go", {}, { persist: true, throwOnError: true }),
            )

            // One file owns the provider, so the Go result lives in its catalog
            // region instead of a second selectable entry or a separate file.
            expect(await fsPromises.readdir(tempDir)).to.deep.equal(["opencode.json"])
            const written = JSON.parse(await fsPromises.readFile(path.join(tempDir, "opencode.json"), "utf8"))
            expect(written.models).to.include.keys("console-only")
            expect(written.catalogs["opencode-go"].models["deepseek-v4.1-flash"].capabilities).to.include({
                contextWindow: 1_000_000,
                maxTokens: 384_000,
                supportsPromptCache: true,
            })

            // The original defect was that a reload dropped what the listing
            // declared, so the projection has to survive re-reading the file.
            await registry.dispose()
            await registry.initialize()
            const restored = registry.getProviderCatalog("opencode-go")?.models["deepseek-v4.1-flash"]
            expect(restored?.capabilities?.contextWindow).to.equal(1_000_000)
            expect(restored?.capabilities?.supportsPromptCache).to.equal(true)
            expect(restored?.apiFormats).to.deep.equal([ApiFormat.OPENAI_RESPONSES, ApiFormat.OPENAI_CHAT])
        })
    })

    describe("dispose", () => {
        it("should clear cache and reset state", async () => {
            const config = {
                provider: "test",
                providerName: "Test",
                models: {
                    m1: {
                        id: "m1",
                        name: "M1",
                        capabilities: {
                            maxTokens: 100,
                            contextWindow: 1000,
                            supportsImages: false,
                            supportsPromptCache: false,
                        },
                    },
                },
            }
            await fsPromises.writeFile(path.join(tempDir, "test.json"), JSON.stringify(config))
            await registry.initialize()

            // Verify state before dispose
            expect(registry.isInitialized).to.be.true
            expect(registry.version).to.be.greaterThan(0)

            await registry.dispose()

            // After dispose: not initialized, cache cleared, callbacks reset
            expect(registry.isInitialized).to.be.false
            expect(registry.getAllModels()).to.deep.equal([])
            expect(registry.getAllProviders()).to.deep.equal([])
        })

        it("should allow re-initialization after dispose", async () => {
            const config = {
                provider: "test2",
                providerName: "Test2",
                models: {
                    m1: {
                        id: "m1",
                        name: "M1",
                        capabilities: {
                            maxTokens: 100,
                            contextWindow: 1000,
                            supportsImages: false,
                            supportsPromptCache: false,
                        },
                    },
                },
            }
            await fsPromises.writeFile(path.join(tempDir, "test2.json"), JSON.stringify(config))
            await registry.initialize()
            await registry.dispose()

            // Re-initialize after dispose
            await registry.initialize()
            expect(registry.isInitialized).to.be.true
            expect(registry.getAllModels()).to.have.lengthOf(1)
        })
    })
})
