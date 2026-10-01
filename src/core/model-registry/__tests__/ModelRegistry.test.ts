/**
 * Unit tests for ModelRegistry.
 */

// sinon import removed: using vitest globals
import { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"
import { expect } from "chai"
import fsPromises from "fs/promises"
import * as path from "path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"
import { ModelRegistry } from "../ModelRegistry"

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

	describe("getAllModels", () => {
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
