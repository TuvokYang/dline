/**
 * `refreshOcaModels` cache mapping.
 *
 * The OCA proto carries `supports_prompt_cache` as a required bool, so a listing
 * that states no cache flag has to be resolved before the response is written.
 * These tests assert on the response the handler actually produces, not on a
 * mock's argument: an unstated capability must arrive as `true` and an explicit
 * `false` must arrive as `false`.
 */

import fs from "node:fs/promises"
import * as path from "node:path"
import { ModelRegistry } from "@core/model-registry/ModelRegistry"
import { StringRequest } from "@shared/proto/dline/common"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mockFetchForTesting } from "@/shared/net"
import type { Controller } from "../.."
import { refreshOcaModels } from "../refreshOcaModels"

const auth = vi.hoisted(() => ({ getAuthToken: vi.fn() }))
vi.mock("@/services/auth/oca/OcaAuthService", () => ({
    OcaAuthService: { getInstance: () => auth },
}))

const LISTING = {
    data: [
        { litellm_params: { model: "oca/stated-on" }, model_info: { supports_caching: true } },
        { litellm_params: { model: "oca/stated-off" }, model_info: { supports_caching: false } },
        { litellm_params: { model: "oca/silent" }, model_info: { description: "no flag" } },
        { litellm_params: { model: "oca/no-model-info" } },
    ],
}

function respondWith(payload: unknown): typeof fetch {
    return (async () =>
        new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch
}

describe("refreshOcaModels cache mapping", () => {
    let tempDir: string

    beforeEach(async () => {
        tempDir = path.join(process.env.TEMP || "/tmp", `oca-cache-mapping-${Date.now()}-${Math.random().toString(36).slice(2)}`)
        await fs.mkdir(tempDir, { recursive: true })
        ;(ModelRegistry as unknown as { instance?: ModelRegistry }).instance = undefined
        const registry = ModelRegistry.getInstance()
        Object.defineProperty(registry, "providersDir", { get: () => tempDir, configurable: true })
        Object.defineProperty(registry, "startWatch", { value: vi.fn(), configurable: true })
        await registry.initialize()
        auth.getAuthToken.mockReset().mockResolvedValue("oca-token")
    })

    afterEach(async () => {
        await ModelRegistry.getInstance().dispose()
        ;(ModelRegistry as unknown as { instance?: ModelRegistry }).instance = undefined
        vi.restoreAllMocks()
        await fs.rm(tempDir, { recursive: true, force: true })
    })

    function controller(): Controller {
        return {
            stateManager: { getGlobalSettingsKey: () => "internal" },
            postStateToWebview: vi.fn(async () => undefined),
        } as unknown as Controller
    }

    it("sends true for an unstated capability and preserves an explicit false", async () => {
        const response = await mockFetchForTesting(respondWith(LISTING), () =>
            refreshOcaModels(controller(), StringRequest.create({ value: "https://oca.example.test" })),
        )

        expect(response.error).toBeUndefined()
        expect(Object.keys(response.models).sort()).toEqual([
            "oca/no-model-info",
            "oca/silent",
            "oca/stated-off",
            "oca/stated-on",
        ])
        expect(response.models["oca/stated-on"].supportsPromptCache).toBe(true)
        expect(response.models["oca/stated-off"].supportsPromptCache).toBe(false)
        expect(response.models["oca/silent"].supportsPromptCache).toBe(true)
        expect(response.models["oca/no-model-info"].supportsPromptCache).toBe(true)
    })

    it("persists each capability as stated so a reload keeps the same answer", async () => {
        await mockFetchForTesting(respondWith(LISTING), () =>
            refreshOcaModels(controller(), StringRequest.create({ value: "https://oca.example.test" })),
        )

        const written = JSON.parse(await fs.readFile(path.join(tempDir, "oca.json"), "utf8"))
        expect(written.models["oca/stated-on"].capabilities.supportsPromptCache).toBe(true)
        expect(written.models["oca/stated-off"].capabilities.supportsPromptCache).toBe(false)
        // An unstated capability is stored as absent: the price and capability the
        // vendor never published must not be written as a denial.
        expect(written.models["oca/silent"].capabilities.supportsPromptCache).toBeUndefined()

        const restored = ModelRegistry.getInstance().getProviderModels("oca")?.models ?? {}
        expect(restored["oca/silent"].capabilities?.supportsPromptCache).toBeUndefined()
        expect(restored["oca/stated-off"].capabilities?.supportsPromptCache).toBe(false)
    })
})
