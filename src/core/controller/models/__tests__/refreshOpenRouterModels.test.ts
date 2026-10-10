import fs from "node:fs/promises"
import * as path from "node:path"
import { ModelRegistry } from "@core/model-registry/ModelRegistry"
import type { ModelInfo } from "@shared/api"
import { openRouterDefaultModelId } from "@shared/api"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Controller } from "../.."
import { persistOpenRouterProviderModels } from "../refreshOpenRouterModels"

describe("persistOpenRouterProviderModels", () => {
    let registry: ModelRegistry
    let tempDir: string

    beforeEach(async () => {
        tempDir = path.join(process.env.TEMP || "/tmp", `openrouter-provider-test-${Date.now()}`)
        await fs.mkdir(tempDir, { recursive: true })
        ;(ModelRegistry as unknown as { instance?: ModelRegistry }).instance = undefined
        registry = ModelRegistry.getInstance()
        Object.defineProperty(registry, "providersDir", { get: () => tempDir, configurable: true })
        Object.defineProperty(registry, "startWatch", { value: vi.fn(), configurable: true })
        await registry.initialize()
    })

    afterEach(async () => {
        await registry.dispose()
        ;(ModelRegistry as unknown as { instance?: ModelRegistry }).instance = undefined
        vi.restoreAllMocks()
        await fs.rm(tempDir, { recursive: true, force: true })
    })

    it("writes the remote catalog to formatted openrouter.json and reloads it", async () => {
        const postStateToWebview = vi.fn(async () => undefined)
        const models: Record<string, ModelInfo> = {
            [openRouterDefaultModelId]: {
                id: openRouterDefaultModelId,
                name: "Claude Sonnet 4.5",
                description: "Remote OpenRouter model",
                userDefined: true,
            },
        }

        await persistOpenRouterProviderModels({ postStateToWebview } as unknown as Controller, models)

        const raw = await fs.readFile(path.join(tempDir, "openrouter.json"), "utf8")
        const persisted = JSON.parse(raw)
        expect(raw).toContain('\n\t"provider": "openrouter"')
        expect(raw.endsWith("\n")).toBe(true)
        expect(persisted.provider).toBe("openrouter")
        expect(persisted.defaultModelId).toBe(openRouterDefaultModelId)
        expect(persisted.models[openRouterDefaultModelId]).toMatchObject({
            id: openRouterDefaultModelId,
            name: "Claude Sonnet 4.5",
            userDefined: false,
        })
        expect(registry.getProviderModels("openrouter")?.models).toHaveProperty(openRouterDefaultModelId)
        expect(postStateToWebview).toHaveBeenCalledOnce()
    })
})
