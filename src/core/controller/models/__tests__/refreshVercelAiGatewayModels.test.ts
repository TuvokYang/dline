import fs from "node:fs/promises"
import * as path from "node:path"
import { ModelRegistry } from "@core/model-registry/ModelRegistry"
import type { ModelInfo } from "@shared/api"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Controller } from "../.."
import { persistVercelProviderModels } from "../refreshVercelAiGatewayModels"

describe("persistVercelProviderModels", () => {
    let registry: ModelRegistry
    let tempDir: string

    beforeEach(async () => {
        tempDir = path.join(process.env.TEMP || "/tmp", `vercel-provider-test-${Date.now()}`)
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

    it("writes the remote catalog to vercel.json and reloads it", async () => {
        const postStateToWebview = vi.fn(async () => undefined)
        await fs.writeFile(
            path.join(tempDir, "vercel.json"),
            JSON.stringify({
                provider: "vercel-ai-gateway",
                providerName: "Vercel AI Gateway",
                defaultModelId: "custom/model",
                models: {
                    "custom/model": { id: "custom/model", name: "Custom", userDefined: true },
                },
            }),
        )
        await registry.reload()
        const models: Record<string, ModelInfo> = {
            "openai/gpt-5": {
                id: "openai/gpt-5",
                name: "GPT-5",
                description: "Remote Vercel model",
                userDefined: true,
            },
        }

        await persistVercelProviderModels({ postStateToWebview } as unknown as Controller, models)

        const raw = await fs.readFile(path.join(tempDir, "vercel.json"), "utf8")
        const persisted = JSON.parse(raw)
        expect(raw).toContain('\n\t"provider": "vercel-ai-gateway"')
        expect(raw.endsWith("\n")).toBe(true)
        expect(persisted.provider).toBe("vercel-ai-gateway")
        expect(persisted.defaultModelId).toBe("openai/gpt-5")
        expect(persisted.models["openai/gpt-5"]).toMatchObject({
            id: "openai/gpt-5",
            name: "GPT-5",
            userDefined: false,
        })
        expect(persisted.models).not.toHaveProperty("custom/model")
        expect(registry.getProviderModels("vercel-ai-gateway")?.models).toHaveProperty("openai/gpt-5")
        expect(postStateToWebview).toHaveBeenCalledOnce()
    })
})
