/**
 * Unit tests for seed-initializer.
 */

import type { ProviderModelsConfig } from "@shared/providers/types"
import { expect } from "chai"
// sinon import removed: using vitest globals
import fs from "fs"
import fsPromises from "fs/promises"
import * as path from "path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"

// Mock provider data for testing seed initialization
// Generated metadata enum value for ServerTool.WEB_SEARCH. Keep the hoisted fixture
// independent from runtime module initialization.
const WEB_SEARCH_TOOL = 1

const mockAllProviderModels = vi.hoisted(
    (): Record<string, ProviderModelsConfig> => ({
        "test-provider": {
            provider: "test-provider",
            providerName: "Test Provider",
            billingMode: "token",
            defaultModelId: "test-model-1",
            models: {
                "test-model-1": {
                    id: "test-model-1",
                    name: "Test Model 1",
                    capabilities: {
                        maxTokens: 4096,
                        contextWindow: 128000,
                        supportsImages: false,
                        supportsPromptCache: false,
                        tools: [1],
                    },
                },
            },
        },
        "provider-with-optional": {
            provider: "provider-with-optional",
            providerName: "Optional Provider",
            billingMode: "token",
            models: {
                "opt-model": {
                    id: "opt-model",
                    name: "Optional Model",
                    capabilities: {
                        maxTokens: 8192,
                        contextWindow: 200000,
                        supportsImages: true,
                        supportsPromptCache: true,
                        supportsReasoning: true,
                    },
                    pricing: { inputPrice: 3.0, outputPrice: 15.0, currency: "USD" },
                    description: "A test model with optional fields",
                },
            },
        },
    }),
)

vi.mock("@shared/providers/model-infos", () => ({
    allProviderModels: mockAllProviderModels,
}))

import { ensureSeedProviders } from "../seed-initializer"

describe("seed-initializer", () => {
    let sandbox: any /* sinon.SinonSandbox → vitest */
    let tempDir: string
    let writeFileStub: any /* sinon.SinonStub → vitest */

    beforeEach(async () => {
        sandbox = { mockRestore: () => {} }
        tempDir = path.join(process.env.TEMP || "/tmp", `seed-init-test-${Date.now()}`)
        await fsPromises.mkdir(tempDir, { recursive: true })
        // Stub fsPromises.mkdir so the function doesn't fail on existing dir
        vi.spyOn(fsPromises, "mkdir" as "mkdir").mockResolvedValue(void 0)
        // Stub writeFile to intercept and verify written content
        writeFileStub = vi.spyOn(fsPromises, "writeFile").mockResolvedValue()
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        try {
            await fsPromises.rm(tempDir, { recursive: true, force: true })
        } catch {
            // Ignore cleanup errors
        }
    })

    it("should create JSON for missing providers", async () => {
        // All files are missing
        vi.spyOn(fs, "existsSync").mockReturnValue(false)

        const created = await ensureSeedProviders(tempDir)

        expect(created).to.equal(2)
        expect(writeFileStub.mock.calls.length).to.equal(2)
    })

    it("should refresh existing built-in models and create missing provider files", async () => {
        const existsStub = vi.spyOn(fs, "existsSync")
        existsStub.mockImplementation((filePath: fs.PathLike) => {
            const p = filePath.toString()
            return p === path.join(tempDir, "test-provider.json")
        })
        vi.spyOn(fsPromises, "readFile").mockResolvedValue(
            JSON.stringify({
                provider: "test-provider",
                providerName: "Test Provider",
                billingMode: "token",
                defaultModelId: "test-model-1",
                models: {
                    "test-model-1": { id: "test-model-1", name: "Stale Model" },
                },
            }),
        )

        const created = await ensureSeedProviders(tempDir)

        expect(created).to.equal(1)
        expect(writeFileStub.mock.calls.length).to.equal(2)
        const writtenPaths = writeFileStub.mock.calls.map((call: unknown[]) => call[0] as string)
        expect(writtenPaths).to.include(path.join(tempDir, "test-provider.json"))
        expect(writtenPaths).to.include(path.join(tempDir, "provider-with-optional.json"))
        const updatedCall = writeFileStub.mock.calls.find(
            (call: unknown[]) => call[0] === path.join(tempDir, "test-provider.json"),
        )
        const updated = JSON.parse(updatedCall?.[1] as string)
        expect(updated.models["test-model-1"].name).to.equal("Test Model 1")
        expect(updated.models["test-model-1"].userDefined).to.equal(false)
        expect(updated.models["test-model-1"].capabilities.tools).to.deep.equal([WEB_SEARCH_TOOL])
    })

    it("should preserve explicitly marked and unknown user models while refreshing built-ins", async () => {
        vi.spyOn(fs, "existsSync").mockReturnValue(true)
        vi.spyOn(fsPromises, "readFile").mockImplementation(async (filePath) => {
            const providerId = path.basename(filePath.toString(), ".json")
            if (providerId === "test-provider") {
                return JSON.stringify({
                    provider: "test-provider",
                    providerName: "Test Provider",
                    billingMode: "token",
                    models: {
                        "test-model-1": { id: "test-model-1", name: "My Tuned Model", userDefined: true },
                        "private-model": { id: "private-model", name: "Private Model" },
                    },
                })
            }
            return JSON.stringify(mockAllProviderModels[providerId])
        })

        await ensureSeedProviders(tempDir)

        const updatedCall = writeFileStub.mock.calls.find(
            (call: unknown[]) => call[0] === path.join(tempDir, "test-provider.json"),
        )
        const updated = JSON.parse(updatedCall?.[1] as string)
        expect(updated.models["test-model-1"]).to.include({ name: "My Tuned Model", userDefined: true })
        expect(updated.models["private-model"]).to.include({ name: "Private Model", userDefined: true })
    })

    it("should serialize defaultModelId in JSON output", async () => {
        vi.spyOn(fs, "existsSync").mockReturnValue(false)

        await ensureSeedProviders(tempDir)

        // Find the write call for test-provider which has defaultModelId
        const writeCalls = writeFileStub.mock.calls
        const testProviderCall = writeCalls.find((call: unknown[]) => (call[0] as string).includes("test-provider"))
        expect(testProviderCall).to.not.be.undefined

        const jsonContent = testProviderCall?.[1] as string
        const parsed = JSON.parse(jsonContent)
        expect(parsed.defaultModelId).to.equal("test-model-1")
        expect(parsed.provider).to.equal("test-provider")
        expect(parsed.providerName).to.equal("Test Provider")
        expect(parsed.models).to.be.an("object")
        expect(Object.keys(parsed.models)).to.have.lengthOf(1)
        expect(parsed.models["test-model-1"].id).to.equal("test-model-1")
        expect(parsed.models["test-model-1"].userDefined).to.equal(false)
    })

    it("should strip undefined fields from JSON output", async () => {
        vi.spyOn(fs, "existsSync").mockReturnValue(false)

        await ensureSeedProviders(tempDir)

        // Find the write call for provider-with-optional which has optional fields
        const writeCalls = writeFileStub.mock.calls
        const optionalCall = writeCalls.find((call: unknown[]) => (call[0] as string).includes("provider-with-optional"))
        expect(optionalCall).to.not.be.undefined

        const jsonContent = optionalCall?.[1] as string
        const parsed = JSON.parse(jsonContent)
        const model = parsed.models["opt-model"]

        // Present fields should exist
        expect(model.id).to.equal("opt-model")
        expect(model.description).to.equal("A test model with optional fields")
        expect(model.pricing.currency).to.equal("USD")
        expect(model.capabilities.supportsReasoning).to.be.true
        expect(model.pricing.inputPrice).to.equal(3.0)
        expect(model.pricing.outputPrice).to.equal(15.0)

        // Undefined fields must not appear in the JSON
        expect("temperature" in model.capabilities).to.be.false
        expect("cacheWritesPrice" in model.pricing).to.be.false
        expect("cacheReadsPrice" in model.pricing).to.be.false
        expect("supportsGlobalEndpoint" in model.capabilities).to.be.false
        expect("apiFormat" in model).to.be.false
        expect("tiers" in model).to.be.false
    })

    it("does not read or rewrite an existing deferred provider catalog during startup seeding", async () => {
        const providerId = "vercel-ai-gateway"
        mockAllProviderModels[providerId] = {
            provider: providerId,
            providerName: "Vercel AI Gateway",
            billingMode: "token",
            models: {},
        }
        try {
            vi.spyOn(fs, "existsSync").mockImplementation(
                (filePath) => filePath.toString() === path.join(tempDir, "vercel-ai-gateway.json"),
            )
            const readFileStub = vi.spyOn(fsPromises, "readFile")

            await ensureSeedProviders(tempDir)

            expect(readFileStub.mock.calls).to.have.lengthOf(0)
            expect(writeFileStub.mock.calls.some((call: unknown[]) => call[0] === path.join(tempDir, "vercel.json"))).to.be.false
        } finally {
            delete mockAllProviderModels[providerId]
        }
    })

    it("creates a formatted lightweight file when a deferred provider catalog is missing", async () => {
        const providerId = "vercel-ai-gateway"
        mockAllProviderModels[providerId] = {
            provider: providerId,
            providerName: "Vercel AI Gateway",
            billingMode: "token",
            models: {},
        }
        try {
            vi.spyOn(fs, "existsSync").mockReturnValue(false)

            await ensureSeedProviders(tempDir)

            const writeCall = writeFileStub.mock.calls.find((call: unknown[]) => call[0] === path.join(tempDir, "vercel.json"))
            expect(writeCall).not.to.be.undefined
            const jsonContent = writeCall?.[1] as string
            expect(jsonContent).to.include('\n\t"provider": "vercel-ai-gateway"')
            expect(jsonContent.endsWith("\n")).to.be.true
        } finally {
            delete mockAllProviderModels[providerId]
        }
    })
})
